-- Зарплата: одно сводное уведомление в чат департамента вместо двух.
--
-- fin_pay_payroll всегда создаёт перевод «Касса → департамент» и следом
-- расход на ту же сумму — деньги проходят через подотчёт департамента
-- транзитом, остаток не меняется. Оба триггерят tg_notify_dept_credit
-- по отдельности, а доставка идёт через очередь с повторами (385) —
-- если одно из двух сообщений не получило ответ от Telegram с первой
-- попытки, оно уходит на повтор и может прийти в чат МИНУТАМИ позже
-- второго. Человек в чате видит сначала «Проведён расход −100 000»,
-- а через пару минут «Выдано под отчёт +100 000» — и не может понять,
-- сколько же на руках (ВГ, 16.09.2026, разбор реальной выплаты).
--
-- В базе порядок и остаток всегда были верны — проблема только в том,
-- что доставка двух отдельных HTTP-запросов не гарантирует порядок.
-- Решение то же, что и для многострочных заявок бота (448): подавляем
-- триггер на обеих проводках и шлём одно сообщение сами, уже после
-- того как обе проводки точно прошли.

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

  -- Обе проводки — одна операция пользователя («выплатил зарплату»), а не
  -- два независимых события. Триггер на проводках молчит, сводку соберём
  -- сами после того, как обе точно прошли.
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

  -- Одно сообщение вместо двух: деньги прошли транзитом, остаток
  -- департамента не изменился — незачем показывать промежуточный шаг.
  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_position.department_id AND is_active;
  IF v_chat IS NOT NULL THEN
    PERFORM tg_send_chat(v_chat,
      format('✅ <b>Зарплата выплачена: %s</b>', fin_fmt_money(v_amount, v_position.currency_code))
      || format(E'\n%s', tg_escape(v_comment))
      || format(E'\nНа руках у департамента: %s',
                fin_fmt_money(fin_private_account_balance(v_account), v_position.currency_code)));
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
