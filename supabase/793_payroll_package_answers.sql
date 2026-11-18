-- =============================================================
-- 793. Пакет оклада — ответы ВГ 18.11 (после 790–792)
--
-- 1. Жильё за месяц можно не начислять (сотрудник уехал, оплачено вперёд):
--    строка помечается снятой с причиной, расписание её не пересоздаёт.
--    У оплаты жилья — «за какой месяц». Амрита Маи уехала, жильё было
--    предоплатой — ноябрь снят.
-- 2. Прасад по договорной цене: неполный месяц — по дням, до целых рупий
--    (семья КК до 14.12 → 9 000 × 14/31). Оклад и жильё по дням считаются с
--    790 — по дате окончания позиции.
-- 3. Дубль карточки Кришна Кумара (b136eb70, 18.11 02:06) слит в основную
--    стандартным merge_vaishnavas (ВГ 18.11: «удалим, объединим»).
-- =============================================================

ALTER TABLE fin_payroll_housing_accruals
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by uuid,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;
ALTER TABLE fin_payroll_housing_payments
  ADD COLUMN IF NOT EXISTS period date CHECK (period IS NULL OR period = date_trunc('month', period)::date);
COMMENT ON COLUMN fin_payroll_housing_payments.period IS 'За какой месяц оплачено жильё (793), необязательно';

CREATE OR REPLACE FUNCTION public.fin_private_charge_monthly_meals(p_through date)
 RETURNS int
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ret uuid := fin_private_no_event_retreat();
  v_months text[] := ARRAY['январь','февраль','март','апрель','май','июнь',
                           'июль','август','сентябрь','октябрь','ноябрь','декабрь'];
  r record;
  v_cursor date;
  v_end date;
  v_cur text;
  v_id uuid;
  v_name text;
  v_n int := 0;
  v_from date;
  v_to date;
  v_days int;
  v_dim int;
  v_amount numeric;
BEGIN
  IF v_ret IS NULL THEN RETURN 0; END IF;
  FOR r IN
    SELECT res.id, res.check_in, res.check_out, res.guest_name, res.vaishnava_id,
           COALESCE(res.payer_id, b.payer_id, res.vaishnava_id) AS payer,
           a.value AS price, a.created_by AS ag_by, b.name AS booking_name
      FROM residents res
      JOIN fin_stay_agreements a ON a.resident_id = res.id AND a.field = 'meals_month' AND a.value > 0
      LEFT JOIN bookings b ON b.id = res.booking_id
     WHERE res.retreat_id IS NULL
       AND COALESCE(res.status, '') <> 'cancelled'
  LOOP
    CONTINUE WHEN r.payer IS NULL OR COALESCE(r.ag_by, auth.uid()) IS NULL;
    SELECT o_currency INTO v_cur FROM fin_private_settlement_currency(r.payer, v_ret);
    -- договорная цена — в рупиях; плательщик с другой валютой расчёта — вручную
    CONTINUE WHEN v_cur <> 'INR';
    v_name := COALESCE(NULLIF(fin_private_person_name(r.vaishnava_id), ''), NULLIF(btrim(r.guest_name), ''),
                       'без имени' || COALESCE(' (бронь «' || r.booking_name || '»)', ''));
    v_cursor := date_trunc('month', r.check_in)::date;
    WHILE v_cursor <= LEAST(p_through, date_trunc('month', COALESCE(r.check_out, p_through))::date) LOOP
      v_end := (v_cursor + interval '1 month' - interval '1 day')::date;
      IF NOT EXISTS (SELECT 1 FROM fin_monthly_meal_charges WHERE resident_id = r.id AND period = v_cursor) THEN
        -- неполный месяц — по дням проживания, до целых рупий (ВГ 18.11)
        v_from := GREATEST(r.check_in, v_cursor);
        v_to   := LEAST(COALESCE(r.check_out, v_end), v_end);
        v_days := v_to - v_from + 1;
        v_dim  := v_end - v_cursor + 1;
        v_amount := CASE WHEN v_days >= v_dim THEN r.price ELSE round(r.price * v_days / v_dim) END;
        v_id := gen_random_uuid();
        INSERT INTO fin_charges (id, request_hash, participant_id, retreat_id, kind, description, quantity,
                                 unit_price, amount, discount_amount, currency_code, creation_reason,
                                 created_by, occurred_on, resident_id)
        VALUES (v_id,
                fin_private_hash(jsonb_build_object('command', 'monthly_meals', 'resident_id', lower(r.id::text), 'period', v_cursor)),
                r.payer, v_ret, 'meals',
                format('Прасад за %s %s — %s (договорная цена %s в месяц%s)',
                       v_months[extract(month FROM v_cursor)::int], extract(year FROM v_cursor)::int, v_name,
                       fin_fmt_money(r.price, 'INR'),
                       CASE WHEN v_days >= v_dim THEN '' ELSE format(', %s из %s дн.', v_days, v_dim) END),
                1, v_amount, v_amount, 0, 'INR', 'Прасад: договорная цена в месяц',
                COALESCE(r.ag_by, auth.uid()), v_end, r.id);
        INSERT INTO fin_monthly_meal_charges (resident_id, period, charge_id) VALUES (r.id, v_cursor, v_id);
        -- чтобы список визитов видел эти дни начисленными
        INSERT INTO fin_visit_charge_periods (charge_id, resident_id, d_from, d_to)
        VALUES (v_id, r.id, v_from, v_to);
        v_n := v_n + 1;
      END IF;
      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE VIEW fin_v_payroll_positions AS
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
    (pp.effective_to IS NULL) AS is_current,
    COALESCE(acc.total_accrued, (0)::numeric) AS total_accrued,
    COALESCE(pay.total_paid, (0)::numeric) AS total_paid,
    (COALESCE(acc.total_accrued, (0)::numeric) - COALESCE(pay.total_paid, (0)::numeric)) AS balance,
    pay.last_payment_on,
    fin_payroll_tg_enabled(pp.vaishnava_id) AS telegram_enabled,
    pp.housing_amount,
    COALESCE(hacc.total, (0)::numeric) AS housing_accrued,
    COALESCE(hpay.total, (0)::numeric) AS housing_paid,
    (COALESCE(hacc.total, (0)::numeric) - COALESCE(hpay.total, (0)::numeric)) AS housing_balance,
    fin_payroll_person_debt(pp.vaishnava_id, pp.currency_code) AS person_debt
   FROM fin_payroll_positions pp
     JOIN fin_departments d ON d.id = pp.department_id
     LEFT JOIN ( SELECT position_id, sum(amount) AS total_accrued
                   FROM fin_payroll_accruals GROUP BY position_id) acc ON acc.position_id = pp.id
     LEFT JOIN ( SELECT fpp.position_id, sum(po.amount) AS total_paid, max(o.occurred_on) AS last_payment_on
                   FROM fin_payroll_payments fpp
                   JOIN fin_postings po ON po.id = fpp.posting_id
                   JOIN fin_operations o ON o.id = po.operation_id
                  WHERE NOT o.is_reversed
                  GROUP BY fpp.position_id) pay ON pay.position_id = pp.id
     LEFT JOIN ( SELECT position_id, sum(amount) AS total
                   FROM fin_payroll_housing_accruals WHERE cancelled_at IS NULL GROUP BY position_id) hacc ON hacc.position_id = pp.id
     LEFT JOIN ( SELECT hp.position_id, sum(po.amount) AS total
                   FROM fin_payroll_housing_payments hp
                   JOIN fin_postings po ON po.id = hp.posting_id
                   JOIN fin_operations o ON o.id = po.operation_id
                  WHERE NOT o.is_reversed
                  GROUP BY hp.position_id) hpay ON hpay.position_id = pp.id
  WHERE fin_is_admin();


CREATE OR REPLACE VIEW fin_v_payroll_housing AS
 SELECT 'accrual'::text AS kind, a.id, a.position_id, a.period AS on_date, a.amount, a.currency_code,
        a.comment, a.is_manual, a.days_worked, a.days_in_month,
        NULL::text AS paid_to, NULL::text AS payee, false AS is_reversed,
        a.cancelled_reason, a.period AS for_period
   FROM fin_payroll_housing_accruals a
  WHERE fin_is_admin()
 UNION ALL
 SELECT 'payment'::text, hp.id, hp.position_id, o.occurred_on, po.amount, po.currency_code,
        o.comment, false, NULL::int, NULL::int,
        hp.paid_to, hp.payee, o.is_reversed,
        NULL::text, hp.period
   FROM fin_payroll_housing_payments hp
   JOIN fin_postings po ON po.id = hp.posting_id
   JOIN fin_operations o ON o.id = po.operation_id
  WHERE fin_is_admin();

CREATE OR REPLACE FUNCTION public.fin_pay_payroll_housing(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_on date;
  v_paid_to text;
  v_payee text;
  v_period date;
  v_comment text;
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
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'paid_to', 'payee', 'comment', 'period']);

  SELECT * INTO v_position FROM fin_payroll_positions
    WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;

  v_amount  := fin_private_get_money(payload, 'amount', true);
  v_on      := COALESCE(fin_private_get_date(payload, 'occurred_on', false), current_date);
  v_paid_to := payload->>'paid_to';
  IF v_paid_to IS NULL OR v_paid_to NOT IN ('landlord', 'employee', 'reimburse') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите, кому отдали деньги';
  END IF;
  v_payee := NULLIF(btrim(COALESCE(payload->>'payee', '')), '');
  v_period := date_trunc('month', fin_private_get_date(payload, 'period', false))::date;
  IF v_paid_to = 'reimburse' AND v_payee IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите, кому возвращаем';
  END IF;

  v_comment := 'Жильё: ' || fin_private_person_name(v_position.vaishnava_id) || ' — '
    || CASE v_paid_to WHEN 'landlord' THEN 'отдано хозяину'
                      WHEN 'employee' THEN 'отдано сотруднику'
                      ELSE 'возврат заплатившему' END
    || COALESCE(' ' || v_payee, '')
    || COALESCE(' · за ' || to_char(v_period, 'MM.YYYY'), '')
    || COALESCE(' · ' || NULLIF(btrim(COALESCE(payload->>'comment', '')), ''), '');

  SELECT id INTO v_category FROM fin_categories WHERE code = 'outside_accommodation' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Жилье за пределами ШРСК» не найдена';
  END IF;

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
    RAISE EXCEPTION 'internal_error'
      USING DETAIL = 'Перевод прошёл, но расход не создался: ' || COALESCE(v_res->'error'->>'message', v_res->'error'->>'code', 'unknown');
  END IF;

  INSERT INTO fin_payroll_housing_payments (posting_id, position_id, paid_to, payee, period, created_by)
  VALUES (v_row_id, v_position.id, v_paid_to, v_payee, v_period, auth.uid());

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


CREATE OR REPLACE FUNCTION public.fin_payroll_housing_line(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE;
  v_del uuid;
  v_skip uuid;
  v_unskip uuid;
  v_period date;
  v_comment text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'period', 'amount', 'comment', 'delete_id', 'skip_id', 'unskip_id', 'reason']);
  v_del := fin_private_get_uuid(payload, 'delete_id', false);
  v_skip := fin_private_get_uuid(payload, 'skip_id', false);
  v_unskip := fin_private_get_uuid(payload, 'unskip_id', false);
  -- «Не начислять жильё за месяц» (уехал, оплачено вперёд…): строка остаётся с
  -- причиной, расписание её не пересоздаст; «вернуть» снимает отметку
  IF v_skip IS NOT NULL THEN
    IF NULLIF(btrim(COALESCE(payload->>'reason', '')), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите причину';
    END IF;
    UPDATE fin_payroll_housing_accruals
       SET cancelled_at = now(), cancelled_by = auth.uid(), cancelled_reason = btrim(payload->>'reason')
     WHERE id = v_skip AND NOT is_manual AND cancelled_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Строка не найдена или уже снята'; END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF v_unskip IS NOT NULL THEN
    UPDATE fin_payroll_housing_accruals SET cancelled_at = NULL, cancelled_by = NULL, cancelled_reason = NULL
     WHERE id = v_unskip AND cancelled_at IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Строка не найдена'; END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF v_del IS NOT NULL THEN
    DELETE FROM fin_payroll_housing_accruals WHERE id = v_del AND is_manual;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Удалять можно только ручную строку';
    END IF;
    RETURN jsonb_build_object('ok', true);
  END IF;

  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена'; END IF;
  v_period  := date_trunc('month', fin_private_get_date(payload, 'period', true))::date;
  v_comment := NULLIF(btrim(COALESCE(payload->>'comment', '')), '');
  IF v_comment IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Что это за строка (например, «Свет по чеку»)';
  END IF;
  INSERT INTO fin_payroll_housing_accruals (position_id, period, amount, currency_code, comment, is_manual, created_by)
  VALUES (v_pos.id, v_period, fin_private_get_money(payload, 'amount', true), v_pos.currency_code, v_comment, true, auth.uid());
  RETURN jsonb_build_object('ok', true);
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

-- Амрита Маи: ноябрь — без жилья
UPDATE fin_payroll_housing_accruals
   SET cancelled_at = now(), cancelled_by = '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746',
       cancelled_reason = 'Уехала, жильё было оплачено вперёд (ВГ 18.11)'
 WHERE position_id = '70151743-06e3-44b4-9459-326f47a92432' AND period = '2026-11-01' AND NOT is_manual AND cancelled_at IS NULL;

-- Дубль карточки Кришна Кумара: духовное имя — на основную, дубль сливается
UPDATE vaishnavas SET spiritual_name = 'Кришна Кумар дас', first_name = NULL
 WHERE id = '98231c24-a2a3-453f-8954-9d82b7851043' AND spiritual_name IS NULL AND first_name = 'Кришна Кумар дас';
SELECT merge_vaishnavas('98231c24-a2a3-453f-8954-9d82b7851043', 'b136eb70-19b5-4254-acdc-760c130482e1');
