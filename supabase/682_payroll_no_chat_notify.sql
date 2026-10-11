-- Оплата труда больше не показывается в чатах департаментов (ВГ, 11.10.2026).
--
-- В чате департамента сидят несколько человек, и сообщение «Зарплата
-- выплачена: 30 000 ₹ — Имя» видно всем. Остаток департамента при выплате
-- не меняется (деньги идут транзитом: касса → департамент → расход), так
-- что пользы чату от сообщения нет — только раскрытие суммы.
--
-- Личкой получателю не шлём: бот может написать человеку, только если тот
-- сам нажал «Старт» у бота; сообщений в чате департамента для этого мало,
-- а из 7 человек в ведомости к боту привязаны 3. Решение ВГ — не писать
-- вовсе.
--
-- Учёт не меняется: расход по статье «Оплата труда» на счёте департамента,
-- как и раньше, в ДДС, себестоимости и аналитике.
--
-- 1) fin_pay_payroll — убрано сводное сообщение «Зарплата выплачена».
-- 2) tg_notify_dept_credit — молчит по проводкам статьи «Оплата труда»
--    (расход и его сторно), заведённым на сайте. Если выплату провели
--    черновиком из чата — человек сам написал это в чат, ответ бота на
--    его сообщение оставляем как был.

CREATE OR REPLACE FUNCTION public.tg_notify_dept_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_orig_op uuid;
  v_reason text;
  v_comment text;
  v_created_by uuid;
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
  v_amount text;
  v_text text;
  v_other_acc text;
  v_other_dept text;
  v_purpose text;
  v_reply_to bigint;
  v_src_chat bigint;
  v_dr uuid;
  v_link text;
  v_who text;
BEGIN
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id),
         o.original_operation_id,
         NULLIF(btrim(o.reason), ''),
         NULLIF(btrim(o.comment), ''),
         o.created_by
    INTO v_optype, v_orig_type, v_orig_op, v_reason, v_comment, v_created_by
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  SELECT a2.name, d2.name
    INTO v_other_acc, v_other_dept
    FROM fin_postings p2
    JOIN fin_accounts a2 ON a2.id = p2.account_id
    LEFT JOIN fin_departments d2 ON d2.id = a2.department_id
   WHERE p2.operation_id = NEW.operation_id
     AND p2.direction <> NEW.direction
   LIMIT 1;

  SELECT NULLIF(btrim(dr.purpose), ''),
         dr.source_message_id,
         dr.chat_id,
         dr.id
    INTO v_purpose, v_reply_to, v_src_chat, v_dr
    FROM tg_drafts dr
   WHERE dr.id IN (SELECT dop.draft_id FROM tg_draft_operations dop
                    WHERE dop.operation_id = COALESCE(v_orig_op, NEW.operation_id))
      OR dr.operation_id = COALESCE(v_orig_op, NEW.operation_id)
      OR dr.id = COALESCE(v_orig_op, NEW.operation_id)
   LIMIT 1;

  IF v_src_chat IS DISTINCT FROM v_chat THEN
    v_reply_to := NULL;
    IF v_dr IS NOT NULL THEN v_link := tg_source_link_line(v_dr); END IF;
  END IF;

  -- Оплата труда, заведённая на сайте, — в чат не пишем (см. шапку).
  IF v_dr IS NULL AND NEW.category_id IS NOT NULL
     AND NEW.category_id = (SELECT id FROM fin_categories WHERE code = 'dept_labor') THEN
    RETURN NEW;
  END IF;

  -- Черновика бота нет — операция заведена прямо на сайте. Комментарий,
  -- который вписал администратор, и есть «на что»/«кому», плюс кто провёл.
  IF v_dr IS NULL THEN
    v_purpose := v_comment;
    IF v_created_by IS NOT NULL THEN
      SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                      NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''))
        INTO v_who FROM vaishnavas v WHERE v.user_id = v_created_by;
    END IF;
  END IF;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;
  v_amount := v_sign || fin_fmt_money(NEW.amount, v_acc.currency_code);

  v_head := CASE
    WHEN v_optype = 'transfer' AND NEW.direction = 'in' AND v_other_dept IS NOT NULL
      THEN format('📥 <b>Получено от «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'
      THEN format('📥 <b>Выдано под отчёт: %s</b>', v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' AND v_other_dept IS NOT NULL
      THEN format('🔁 <b>Передано «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out'
      THEN format('📤 <b>Возвращено в кассу: %s</b>', v_amount)
    WHEN v_optype = 'expense'  THEN format('💸 <b>Проведён расход: %s</b>', v_amount)
    WHEN v_optype = 'refund'   THEN format('↩️ <b>Возврат: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer'
      THEN format('❌ <b>Выдача отменена: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'
      THEN format('❌ <b>Расход отменён: %s</b>', v_amount)
    WHEN v_optype = 'reversal' THEN format('❌ <b>Операция отменена: %s</b>', v_amount)
    WHEN NEW.direction = 'in'  THEN format('📥 <b>Приход: %s</b>', v_amount)
    ELSE format('📤 <b>Списание: %s</b>', v_amount)
  END;

  v_text := v_head;

  IF v_optype = 'transfer' AND v_other_acc IS NOT NULL THEN
    v_text := v_text || format(E'\n%s: %s',
      CASE WHEN NEW.direction = 'in' THEN 'Со счёта' ELSE 'На счёт' END,
      tg_escape(v_other_acc));
  END IF;

  IF v_purpose IS NOT NULL AND v_reply_to IS NULL AND v_link IS NULL THEN
    v_text := v_text || format(E'\nНа что: %s', tg_escape(v_purpose));
  END IF;

  IF v_who IS NOT NULL THEN
    v_text := v_text || format(E'\nПровёл: %s', tg_escape(v_who));
  END IF;

  IF v_optype = 'reversal' THEN
    v_text := v_text || format(E'\nПричина: %s', tg_escape(COALESCE(v_reason, 'не указана')));
  END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  v_text := v_text || format(E'\nНа руках у департамента: %s',
                             fin_fmt_money(v_bal, v_acc.currency_code));

  PERFORM tg_send_chat(v_chat, COALESCE(v_link || E'\n', '') || v_text, v_reply_to);
  RETURN NEW;
END;
$function$;

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

  -- Триггер на проводках молчит: оплата труда в чат не идёт (см. шапку 682).
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

  -- В чат департамента о зарплате не пишем (см. шапку 682).

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
