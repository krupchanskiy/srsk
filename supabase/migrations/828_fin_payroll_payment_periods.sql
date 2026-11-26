-- 828: «за какой месяц» у выплаты зарплаты.
-- Раньше месяц был только у начисления (fin_payroll_accruals.period), у выплаты —
-- лишь в комментарии. Теперь выплата раскладывается строками «месяц — сумма»
-- (Сундара Рупа 100 000 = сентябрь 50 000 + октябрь 50 000), проводка одна.
-- Сумма строк = сумма выплаты (брутто, вместе с удержанием).
-- Выплата без строк = «месяц не указан» (старые, где из комментария не понять).
-- Новая выплата без явных месяцев (Телеграм/«Входящие» через tg_post_draft)
-- получает самый старый неоплаченный месяц — поменять потом в ведомости.
-- «Итоги» берут зарплату по месяцу из fin_v_payroll_by_period.

CREATE TABLE fin_payroll_payment_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid NOT NULL REFERENCES fin_payroll_payments(id) ON DELETE CASCADE,
  period      date NOT NULL CHECK (period = date_trunc('month', period)::date),
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'default', 'comment', 'vg')),
  created_by  uuid DEFAULT auth.uid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, period)
);
CREATE INDEX fin_payroll_payment_periods_period_idx ON fin_payroll_payment_periods (period);
ALTER TABLE fin_payroll_payment_periods ENABLE ROW LEVEL SECURITY;
-- доступ только через функции и представления (как у fin_payroll_payments)

-- Сумма строк = сумма выплаты. Отложенная проверка: замена строк (удалить + вставить)
-- в одной транзакции не ловит промежуточное состояние
CREATE OR REPLACE FUNCTION fin_private_check_payment_periods()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_pid uuid := COALESCE(NEW.payment_id, OLD.payment_id);
  v_sum numeric;
  v_cnt int;
  v_total numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_cnt, v_sum
    FROM fin_payroll_payment_periods WHERE payment_id = v_pid;
  IF v_cnt = 0 THEN RETURN NULL; END IF;
  SELECT po.amount INTO v_total
    FROM fin_payroll_payments f JOIN fin_postings po ON po.id = f.posting_id
   WHERE f.id = v_pid;
  IF v_total IS NULL THEN RETURN NULL; END IF;  -- выплату удаляют каскадом
  IF abs(v_sum - v_total) > 0.005 THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = format('Сумма по месяцам (%s) не равна сумме выплаты (%s)', v_sum, v_total);
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER fin_payroll_payment_periods_sum
  AFTER INSERT OR UPDATE OR DELETE ON fin_payroll_payment_periods
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION fin_private_check_payment_periods();

-- Самый старый месяц, где начислено больше, чем уже разложено выплатами.
-- Человек + департамент + валюта (позиции-периоды одной строки ведомости).
-- Нет недоплаченных — месяц даты выплаты.
CREATE OR REPLACE FUNCTION fin_private_payroll_oldest_unpaid(p_position_id uuid, p_on date)
RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH pos AS (
    SELECT p2.id FROM fin_payroll_positions p1
      JOIN fin_payroll_positions p2 ON p2.vaishnava_id = p1.vaishnava_id
                                   AND p2.department_id = p1.department_id
                                   AND p2.currency_code = p1.currency_code
     WHERE p1.id = p_position_id
  ), acc AS (
    SELECT period, sum(amount) amt FROM fin_payroll_accruals
     WHERE position_id IN (SELECT id FROM pos) GROUP BY period
  ), paid AS (
    SELECT pp.period, sum(pp.amount) amt
      FROM fin_payroll_payment_periods pp
      JOIN fin_payroll_payments f ON f.id = pp.payment_id
      JOIN fin_postings po ON po.id = f.posting_id
      JOIN fin_operations o ON o.id = po.operation_id
     WHERE f.position_id IN (SELECT id FROM pos) AND NOT o.is_reversed
     GROUP BY pp.period
  )
  SELECT COALESCE(
    (SELECT acc.period FROM acc LEFT JOIN paid USING (period)
      WHERE acc.amt - COALESCE(paid.amt, 0) > 0.005
      ORDER BY acc.period LIMIT 1),
    date_trunc('month', p_on)::date);
$$;

-- Новая выплата без строк — одна строка «самый старый неоплаченный месяц».
-- fin_pay_payroll с явными месяцами потом заменяет её (fin_private_set_payment_periods)
CREATE OR REPLACE FUNCTION fin_private_payroll_payment_default_period()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_amount numeric;
  v_on date;
BEGIN
  SELECT po.amount, o.occurred_on INTO v_amount, v_on
    FROM fin_postings po JOIN fin_operations o ON o.id = po.operation_id
   WHERE po.id = NEW.posting_id;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN NULL; END IF;
  INSERT INTO fin_payroll_payment_periods (payment_id, period, amount, source)
  VALUES (NEW.id, fin_private_payroll_oldest_unpaid(NEW.position_id, v_on), v_amount, 'default');
  RETURN NULL;
END $$;

CREATE TRIGGER fin_payroll_payments_default_period
  AFTER INSERT ON fin_payroll_payments
  FOR EACH ROW EXECUTE FUNCTION fin_private_payroll_payment_default_period();

-- Заменить строки выплаты: periods = [{period:'2026-10-01', amount:50000}, ...]
CREATE OR REPLACE FUNCTION fin_private_set_payment_periods(p_payment_id uuid, p_periods jsonb, p_source text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r jsonb;
  v_period date;
  v_amount numeric;
BEGIN
  IF p_periods IS NULL OR jsonb_typeof(p_periods) <> 'array' OR jsonb_array_length(p_periods) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите хотя бы один месяц';
  END IF;
  DELETE FROM fin_payroll_payment_periods WHERE payment_id = p_payment_id;
  FOR r IN SELECT * FROM jsonb_array_elements(p_periods) LOOP
    BEGIN
      v_period := date_trunc('month', (r->>'period')::date)::date;
      v_amount := round((r->>'amount')::numeric, 2);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный месяц или сумма';
    END;
    IF v_period IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У каждого месяца нужна сумма больше нуля';
    END IF;
    IF EXISTS (SELECT 1 FROM fin_payroll_payment_periods WHERE payment_id = p_payment_id AND period = v_period) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Один и тот же месяц указан дважды';
    END IF;
    INSERT INTO fin_payroll_payment_periods (payment_id, period, amount, source)
    VALUES (p_payment_id, v_period, v_amount, p_source);
  END LOOP;
  -- проверить сумму сразу, а не в конце транзакции — чтобы ошибка вернулась ответом
  SET CONSTRAINTS fin_payroll_payment_periods_sum IMMEDIATE;
  SET CONSTRAINTS fin_payroll_payment_periods_sum DEFERRED;
END $$;

-- Поменять месяцы у существующей выплаты (из ведомости)
CREATE OR REPLACE FUNCTION fin_set_payroll_payment_periods(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['payment_id', 'periods']);
  v_id := fin_private_get_uuid(payload, 'payment_id', true);
  IF NOT EXISTS (SELECT 1 FROM fin_payroll_payments WHERE id = v_id) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Выплата не найдена';
  END IF;
  PERFORM fin_private_set_payment_periods(v_id, payload->'periods', 'manual');
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END $$;
REVOKE ALL ON FUNCTION fin_set_payroll_payment_periods(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION fin_set_payroll_payment_periods(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION fin_private_set_payment_periods(uuid, jsonb, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_payroll_oldest_unpaid(uuid, date) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_check_payment_periods() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_payroll_payment_default_period() FROM public, anon, authenticated;

-- Ведомость: у выплаты — её месяцы
CREATE OR REPLACE VIEW fin_v_payroll_payments AS
 SELECT fpp.id,
    fpp.position_id,
    o.occurred_on,
    po.amount,
    po.currency_code,
    o.comment,
    o.is_reversed,
    fpp.confirm_requested_at,
    fpp.dm_sent_at,
    fpp.confirmed_at,
    (EXISTS ( SELECT 1
           FROM tg_user_links l
             JOIN fin_payroll_positions pp ON pp.vaishnava_id = l.vaishnava_id
          WHERE pp.id = fpp.position_id)) AND NOT fin_payroll_dm_failed(fpp.dm_outbox_id) AS recipient_linked,
    fpp.withheld_amount,
    po.amount - fpp.withheld_amount AS on_hand,
    ( SELECT jsonb_agg(jsonb_build_object('period', x.period, 'amount', x.amount, 'source', x.source) ORDER BY x.period)
        FROM fin_payroll_payment_periods x WHERE x.payment_id = fpp.id) AS periods
   FROM fin_payroll_payments fpp
     JOIN fin_postings po ON po.id = fpp.posting_id
     JOIN fin_operations o ON o.id = po.operation_id
  WHERE fin_is_admin();

-- Для «Итогов»: зарплата по месяцу, к которому относится, без сторнированных.
-- Выплата без указанного месяца — месяцем даты выплаты, period_assigned = false.
CREATE OR REPLACE VIEW fin_v_payroll_by_period AS
 SELECT COALESCE(x.period, date_trunc('month', o.occurred_on)::date) AS period,
    x.period IS NOT NULL AS period_assigned,
    COALESCE(x.amount, po.amount) AS amount,
    po.currency_code,
    pp.department_id,
    pp.vaishnava_id,
    fpp.position_id,
    fpp.id AS payment_id,
    po.id AS posting_id,
    o.id AS operation_id,
    o.occurred_on
   FROM fin_payroll_payments fpp
     JOIN fin_postings po ON po.id = fpp.posting_id
     JOIN fin_operations o ON o.id = po.operation_id
     JOIN fin_payroll_positions pp ON pp.id = fpp.position_id
     LEFT JOIN fin_payroll_payment_periods x ON x.payment_id = fpp.id
  WHERE NOT o.is_reversed AND fin_is_admin();
GRANT SELECT ON fin_v_payroll_by_period TO authenticated;

-- fin_pay_payroll: необязательный periods = [{period, amount}] — строки «за месяц — сумма».
-- Без него — самый старый неоплаченный месяц (триггер). Остальное без изменений (792).
CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_withhold numeric;
  v_total numeric;
  v_debt numeric;
  v_on date;
  v_comment text;
  v_employee_name text;
  v_category uuid;
  v_account uuid;
  v_cash_account uuid;
  v_request_id uuid := gen_random_uuid();
  v_transfer_request_id uuid := gen_random_uuid();
  v_withhold_request_id uuid := gen_random_uuid();
  v_row_id uuid := gen_random_uuid();
  v_obj uuid;
  v_transfer_res jsonb;
  v_res jsonb;
  v_wres jsonb;
  v_detail text;
  v_payment_id uuid;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'comment', 'withhold_amount', 'periods']);

  SELECT * INTO v_position FROM fin_payroll_positions
    WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;

  BEGIN
    v_amount   := round(COALESCE(NULLIF(payload->>'amount', ''), '0')::numeric, 2);
    v_withhold := round(COALESCE(NULLIF(payload->>'withhold_amount', ''), '0')::numeric, 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректная сумма';
  END;
  IF v_amount < 0 OR v_withhold < 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Сумма не может быть отрицательной';
  END IF;
  v_total := v_amount + v_withhold;
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Сумма выплаты должна быть > 0';
  END IF;
  IF v_withhold > 0 THEN
    v_debt := fin_payroll_person_debt(v_position.vaishnava_id, v_position.currency_code);
    IF v_withhold > v_debt + 0.005 THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = format('Удержание %s больше долга человека (%s)',
                              fin_fmt_money(v_withhold, v_position.currency_code), fin_fmt_money(v_debt, v_position.currency_code));
    END IF;
  END IF;

  v_on      := COALESCE(fin_private_get_date(payload, 'occurred_on', false), current_date);
  v_comment := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');

  v_employee_name := fin_private_person_name(v_position.vaishnava_id);
  v_comment := v_employee_name || COALESCE(' — ' || v_comment, '');

  SELECT id INTO v_category FROM fin_categories WHERE code = 'dept_labor' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Оплата труда» не найдена в справочнике';
  END IF;

  -- только основная касса: «Касса ДДС у ГХ» тоже в группе «Касса», но хранится у департамента
  SELECT id INTO v_cash_account
    FROM fin_accounts
   WHERE kind = 'real' AND group_name = 'Касса' AND currency_code = v_position.currency_code AND is_active
     AND cashbox_department_id IS NULL
   ORDER BY created_at
   LIMIT 1;
  IF v_cash_account IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = format('Касса в валюте %s не найдена', v_position.currency_code);
  END IF;

  v_account := fin_dept_account(v_position.department_id, v_position.currency_code);

  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  -- на руки — из кассы департаменту
  IF v_amount > 0 THEN
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
  END IF;

  -- удержание — оплата долга человека на счёт департамента, без кассы
  IF v_withhold > 0 THEN
    SELECT id INTO v_obj FROM fin_accounting_objects WHERE retreat_id = fin_private_no_event_retreat();
    v_wres := fin_create_payment(jsonb_build_object(
      'request_id', v_withhold_request_id,
      'occurred_on', v_on,
      'payer_contact_id', v_position.vaishnava_id,
      'comment', 'Удержано из зарплаты: ' || v_comment,
      'reason', NULL,
      'rows', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid(),
        'account_id', v_account,
        'amount', v_withhold,
        'participant_id', v_position.vaishnava_id,
        'object_id', v_obj,
        'participant_balance_kind', 'general',
        'payment_channel', NULL,
        'rate_mode', NULL)),
      'change', NULL, 'exchange', NULL, 'donation', NULL, 'writeoff', NULL));
    IF NOT COALESCE((v_wres->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'internal_error'
        USING DETAIL = 'Удержание не провелось: ' || COALESCE(v_wres->'error'->>'message', v_wres->'error'->>'code', 'unknown');
    END IF;
  END IF;

  v_res := fin_create_expense(jsonb_build_object(
    'request_id', v_request_id,
    'occurred_on', v_on,
    'comment', v_comment || CASE WHEN v_withhold > 0
                 THEN format(' (на руки %s, удержано %s)', fin_fmt_money(v_amount, v_position.currency_code),
                             fin_fmt_money(v_withhold, v_position.currency_code))
                 ELSE '' END,
    'reason', NULL,
    'payer_contact_id', NULL,
    'rows', jsonb_build_array(jsonb_build_object(
      'id', v_row_id,
      'account_id', v_account,
      'amount', v_total,
      'category_id', v_category,
      'cost_center_id', NULL,
      'object_id', NULL,
      'participant_id', NULL,
      'contractor_id', NULL,
      'payment_channel', NULL
    ))
  ));

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'internal_error'
      USING DETAIL = 'Перевод прошёл, но расход не создался: ' || COALESCE(v_res->'error'->>'message', v_res->'error'->>'code', 'unknown');
  END IF;

  INSERT INTO fin_payroll_payments (posting_id, position_id, withheld_amount, withhold_operation_id)
  VALUES (v_row_id, v_position.id, v_withhold, CASE WHEN v_withhold > 0 THEN v_withhold_request_id END)
  RETURNING id INTO v_payment_id;

  -- месяцы явно — заменяют строку по умолчанию; сумма строк = v_total
  IF jsonb_typeof(payload->'periods') = 'array' AND jsonb_array_length(payload->'periods') > 0 THEN
    PERFORM fin_private_set_payment_periods(v_payment_id, payload->'periods', 'manual');
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
