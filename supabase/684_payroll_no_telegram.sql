-- Зарплата: у человека можно выключить Телеграм (ВГ, 11.10.2026).
--
-- Бридж Кишору и Уше уведомления о зарплате не нужны. Настройка — на
-- человека, а не на позицию ведомости: позиция пересоздаётся при смене
-- оклада или департамента (438), и галочка терялась бы.
--
-- Выключено → ни строки в чат департамента, ни личного сообщения, и
-- выплата не ждёт подтверждения (без ⚠ в ведомости). При выключении уже
-- ждущие подтверждения выплаты этого человека тоже снимаются с ожидания.

CREATE TABLE public.fin_payroll_no_telegram (
  vaishnava_id uuid PRIMARY KEY REFERENCES vaishnavas(id),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fin_payroll_no_telegram ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fin_payroll_no_telegram FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_payroll_tg_enabled(p_vaishnava uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT NOT EXISTS (SELECT 1 FROM fin_payroll_no_telegram WHERE vaishnava_id = p_vaishnava);
$function$;
REVOKE ALL ON FUNCTION public.fin_payroll_tg_enabled(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_payroll_set_telegram(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_vaishnava uuid := NULLIF(payload->>'vaishnava_id', '')::uuid;
  v_enabled boolean := COALESCE((payload->>'enabled')::boolean, true);
BEGIN
  IF NOT fin_is_admin() THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  END IF;
  IF v_vaishnava IS NULL OR NOT EXISTS (SELECT 1 FROM fin_payroll_positions WHERE vaishnava_id = v_vaishnava) THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'not_found', 'message', 'Человек не найден в ведомости'));
  END IF;
  IF v_enabled THEN
    DELETE FROM fin_payroll_no_telegram WHERE vaishnava_id = v_vaishnava;
  ELSE
    INSERT INTO fin_payroll_no_telegram (vaishnava_id, created_by) VALUES (v_vaishnava, auth.uid())
    ON CONFLICT (vaishnava_id) DO NOTHING;
    UPDATE fin_payroll_payments fpp SET confirm_requested_at = NULL
      FROM fin_payroll_positions pp
     WHERE pp.id = fpp.position_id AND pp.vaishnava_id = v_vaishnava AND fpp.confirmed_at IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_payroll_set_telegram(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_payroll_set_telegram(jsonb) TO authenticated;

-- Новая выплата: Телеграм выключен — не ждём подтверждения и не пишем.
CREATE OR REPLACE FUNCTION public.fin_payroll_payment_after_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT fin_payroll_tg_enabled((SELECT vaishnava_id FROM fin_payroll_positions WHERE id = NEW.position_id)) THEN
    RETURN NEW;
  END IF;
  UPDATE fin_payroll_payments SET confirm_requested_at = now() WHERE id = NEW.id;
  PERFORM tg_payroll_send_dm(NEW.id);
  RETURN NEW;
END;
$function$;

-- Признак — на страницу ведомости (колонка в конце, остальное как в 438)
CREATE OR REPLACE VIEW public.fin_v_payroll_positions AS
 SELECT pp.id,
    pp.vaishnava_id,
    fin_private_person_name(pp.vaishnava_id) AS employee_name,
    pp.department_id,
    d.name AS department_name,
    pp.position_title,
    pp.salary_amount,
    pp.currency_code,
    pp.effective_from,
    pp.effective_to,
    pp.effective_to IS NULL AS is_current,
    COALESCE(acc.total_accrued, 0::numeric) AS total_accrued,
    COALESCE(pay.total_paid, 0::numeric) AS total_paid,
    COALESCE(acc.total_accrued, 0::numeric) - COALESCE(pay.total_paid, 0::numeric) AS balance,
    pay.last_payment_on,
    fin_payroll_tg_enabled(pp.vaishnava_id) AS telegram_enabled
   FROM fin_payroll_positions pp
     JOIN fin_departments d ON d.id = pp.department_id
     LEFT JOIN ( SELECT fin_payroll_accruals.position_id,
            sum(fin_payroll_accruals.amount) AS total_accrued
           FROM fin_payroll_accruals
          GROUP BY fin_payroll_accruals.position_id) acc ON acc.position_id = pp.id
     LEFT JOIN ( SELECT fpp.position_id,
            sum(po.amount) AS total_paid,
            max(o.occurred_on) AS last_payment_on
           FROM fin_payroll_payments fpp
             JOIN fin_postings po ON po.id = fpp.posting_id
             JOIN fin_operations o ON o.id = po.operation_id
          WHERE NOT o.is_reversed
          GROUP BY fpp.position_id) pay ON pay.position_id = pp.id
  WHERE fin_is_admin();

-- Выплата со страницы: строка в чат — только если Телеграм не выключен.
CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_on date;
  v_comment text;
  v_employee_name text;
  v_category uuid;
  v_account uuid;
  v_cash_account uuid;
  v_request_id uuid := gen_random_uuid();
  v_transfer_request_id uuid := gen_random_uuid();
  v_row_id uuid := gen_random_uuid();
  v_transfer_res jsonb;
  v_res jsonb;
  v_detail text;
  v_chat bigint;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'comment']);

  SELECT * INTO v_position FROM fin_payroll_positions
    WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;

  v_amount  := fin_private_get_money(payload, 'amount', true);
  v_on      := COALESCE(fin_private_get_date(payload, 'occurred_on', false), current_date);
  v_comment := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');

  v_employee_name := fin_private_person_name(v_position.vaishnava_id);
  v_comment := v_employee_name || COALESCE(' — ' || v_comment, '');

  SELECT id INTO v_category FROM fin_categories WHERE code = 'dept_labor' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Оплата труда» не найдена в справочнике';
  END IF;

  SELECT id INTO v_cash_account
    FROM fin_accounts
   WHERE kind = 'real' AND group_name = 'Касса' AND currency_code = v_position.currency_code AND is_active
   LIMIT 1;
  IF v_cash_account IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = format('Касса в валюте %s не найдена', v_position.currency_code);
  END IF;

  v_account := fin_dept_account(v_position.department_id, v_position.currency_code);

  -- Триггер на проводках молчит: свою строку о выплате (без суммы) шлём ниже.
  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  -- шаг 1: выдать департаменту из кассы (как и любая ручная выплата тут)
  v_transfer_res := fin_create_transfer(jsonb_build_object(
    'request_id', v_transfer_request_id,
    'occurred_on', v_on,
    'source_account_id', v_cash_account,
    'target_account_id', v_account,
    'source_amount', v_amount,
    'target_amount', NULL,
    'comment', v_comment
  ));
  IF NOT COALESCE((v_transfer_res->>'ok')::boolean, false) THEN
    RETURN v_transfer_res;
  END IF;

  -- шаг 2: департамент сразу выдаёт выплаченное
  v_res := fin_create_expense(jsonb_build_object(
    'request_id', v_request_id,
    'occurred_on', v_on,
    'comment', v_comment,
    'reason', NULL,
    'payer_contact_id', NULL,
    'rows', jsonb_build_array(jsonb_build_object(
      'id', v_row_id,
      'account_id', v_account,
      'amount', v_amount,
      'category_id', v_category,
      'cost_center_id', NULL,
      'object_id', NULL,
      'participant_id', NULL,
      'contractor_id', NULL,
      'payment_channel', NULL
    ))
  ));

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    -- перевод уже прошёл — без исключения он остался бы висеть без
    -- расхода; RAISE откатывает оба шага как одно целое (см. шапку)
    RAISE EXCEPTION 'internal_error'
      USING DETAIL = 'Перевод прошёл, но расход не создался: ' || COALESCE(v_res->'error'->>'message', v_res->'error'->>'code', 'unknown');
  END IF;

  INSERT INTO fin_payroll_payments (posting_id, position_id) VALUES (v_row_id, v_position.id);

  -- В чат департамента — отметка без суммы (683), если человеку Телеграм
  -- не выключен (684). Личное сообщение — из триггера на fin_payroll_payments.
  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_position.department_id AND is_active;
  IF v_chat IS NOT NULL AND fin_payroll_tg_enabled(v_position.vaishnava_id) THEN
    PERFORM tg_send_chat(v_chat,
      format('✅ %s — %s', tg_escape(v_employee_name), fin_payroll_paid_phrase(v_position.id)));
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', v_res->'result');
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

-- Решение ВГ: Бридж Кишору и Уше Телеграм не нужен
INSERT INTO fin_payroll_no_telegram (vaishnava_id)
SELECT DISTINCT vaishnava_id FROM fin_payroll_positions
 WHERE id IN ('a0266c5f-963c-4c9d-8cbb-db78afc744d0', '3397811c-6c7c-434e-b9f8-0a3f03f6322d')
ON CONFLICT (vaishnava_id) DO NOTHING;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_tg_on', 'Уведомления о зарплате в Телеграме включены — нажмите, чтобы выключить', 'Telegram salary notifications on — click to turn off', 'टेलीग्राम वेतन सूचनाएँ चालू — बंद करने के लिए दबाएँ'),
  ('fin_payroll_tg_off', 'Телеграм не нужен — нажмите, чтобы включить уведомления', 'No Telegram — click to turn notifications on', 'टेलीग्राम नहीं — सूचनाएँ चालू करने के लिए दबाएँ'),
  ('fin_payroll_tg_off_short', 'без Телеграма', 'no Telegram', 'टेलीग्राम नहीं')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
