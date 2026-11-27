-- 833: выплата по ведомости из окна «Перевод» ДДС (ВГ 27.11).
-- «Деньги уже потрачены» + «Оплата труда» / «Гонорар за ретрит»: человек и месяцы
-- как в ведомости. fin_pay_payroll получает необязательные ключи:
--   source_account_id — с какого счёта выдали (по умолчанию основная касса),
--   category_code     — 'dept_labor' (по умолчанию) или 'retreat_fee',
--   object_id         — ретрит/объект у расхода.
-- Без этих ключей поведение прежнее (828).

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
  v_cat_code text;
  v_src uuid;
  v_expense_obj uuid;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'comment', 'withhold_amount', 'periods',
                                          'source_account_id', 'category_code', 'object_id']);

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

  -- Статья: «Оплата труда» (по умолчанию) или «Гонорар за ретрит» (833, окно перевода)
  v_cat_code := COALESCE(NULLIF(payload->>'category_code', ''), 'dept_labor');
  IF v_cat_code NOT IN ('dept_labor', 'retreat_fee') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Через ведомость — только «Оплата труда» или «Гонорар за ретрит»';
  END IF;
  SELECT id INTO v_category FROM fin_categories WHERE code = v_cat_code AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = format('Статья %s не найдена в справочнике', v_cat_code);
  END IF;
  v_expense_obj := fin_private_get_uuid(payload, 'object_id', false);

  -- только основная касса: «Касса ДДС у ГХ» тоже в группе «Касса», но хранится у департамента
  SELECT id INTO v_cash_account
    FROM fin_accounts
   WHERE kind = 'real' AND group_name = 'Касса' AND currency_code = v_position.currency_code AND is_active
     AND cashbox_department_id IS NULL
   ORDER BY created_at
   LIMIT 1;
  -- Откуда выдали: из окна перевода — выбранный счёт (833), иначе основная касса
  v_src := fin_private_get_uuid(payload, 'source_account_id', false);
  IF v_src IS NOT NULL THEN
    SELECT id INTO v_cash_account FROM fin_accounts
     WHERE id = v_src AND is_active AND currency_code = v_position.currency_code;
    IF v_cash_account IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Счёт-источник должен быть в валюте сотрудника (%s)', v_position.currency_code);
    END IF;
  END IF;
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
      'object_id', v_expense_obj,
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

