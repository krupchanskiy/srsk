-- =============================================================
-- 790. Пакет оклада в зарплатной ведомости (вариант Б, ВГ 18.11.2026)
--
-- Пример — Кришна Кумар дас (Зелёные): пакет 50 000 ₹ = оклад 35 000 + жильё 15 000.
--
-- Оклад. При выплате часть можно удержать в счёт долга человека перед ШРСК
-- (прасад семьи): на руки 17 000 — выдача из кассы, «Получил» в Телеграме
-- только за неё; удержано 18 000 — приход «Оплата от участника» на счёт
-- департамента без движения кассы, гасит долг в «Гостях без события».
-- Расход «Оплата труда» — на весь оклад (35 000): это настоящая цена труда.
--
-- Жильё — не удержание (иначе в кассе появится приход, которого не было):
-- копится долгом «Жильё к оплате» помесячно (с текущим месяцем — аренду
-- платят вперёд) и становится расходом «Жильё за пределами ШРСК» только в
-- момент оплаты, с отметкой, кому отдали деньги. Свет — ручной строкой по чеку.
--
-- Прасад семьи. «Платит за них» (payer_id) у брони или места: начисления
-- идут на карточку плательщика, по строке на человека. Договорная цена
-- в месяц — договорённость места meals_month; начисляется сама за каждый
-- завершённый месяц проживания.
-- =============================================================

-- ---------- состав пакета: жильё в позиции (дата действия — как у оклада) ----------
ALTER TABLE fin_payroll_positions
  ADD COLUMN IF NOT EXISTS housing_amount numeric
  CHECK (housing_amount IS NULL OR housing_amount > 0);
COMMENT ON COLUMN fin_payroll_positions.housing_amount IS
  'Жильё в пакете оклада, в месяц (790). Не выдаётся на руки: копит «Жильё к оплате», оплата — расход «Жильё за пределами ШРСК»';

-- ---------- жильё: начисления по месяцам + ручные строки (свет по чеку) ----------
CREATE TABLE IF NOT EXISTS fin_payroll_housing_accruals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id uuid NOT NULL REFERENCES fin_payroll_positions(id),
  period date NOT NULL CHECK (period = date_trunc('month', period)::date),
  amount numeric NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL,
  days_worked int,
  days_in_month int,
  comment text,
  is_manual boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_manual OR NULLIF(btrim(comment), '') IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS fin_payroll_housing_accruals_auto_uq
  ON fin_payroll_housing_accruals (position_id, period) WHERE NOT is_manual;
ALTER TABLE fin_payroll_housing_accruals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_payroll_housing_accruals FROM anon, authenticated;

-- ---------- жильё: оплаты (связь с расходом) ----------
CREATE TABLE IF NOT EXISTS fin_payroll_housing_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id uuid NOT NULL UNIQUE REFERENCES fin_postings(id),
  position_id uuid NOT NULL REFERENCES fin_payroll_positions(id),
  -- кому отдали: хозяину / сотруднику / вернуть тому, кто заплатил;
  -- NULL — перенесённая старая проводка, где это не записано
  paid_to text CHECK (paid_to IN ('landlord', 'employee', 'reimburse')),
  payee text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin_payroll_housing_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_payroll_housing_payments FROM anon, authenticated;

-- ---------- удержание при выплате оклада ----------
ALTER TABLE fin_payroll_payments
  ADD COLUMN IF NOT EXISTS withheld_amount numeric NOT NULL DEFAULT 0 CHECK (withheld_amount >= 0),
  ADD COLUMN IF NOT EXISTS withhold_operation_id uuid REFERENCES fin_operations(id);
COMMENT ON COLUMN fin_payroll_payments.withheld_amount IS
  'Сколько из выплаченного оклада удержано в счёт долга (790); на руки = сумма расхода − удержано';

-- ---------- «Платит за них» ----------
ALTER TABLE bookings  ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES vaishnavas(id) ON DELETE SET NULL;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS payer_id uuid REFERENCES vaishnavas(id) ON DELETE SET NULL;
COMMENT ON COLUMN bookings.payer_id  IS 'Платит за них (790): начисления мест брони идут на карточку этого человека';
COMMENT ON COLUMN residents.payer_id IS 'Платит за него (790), главнее плательщика брони';

-- ---------- прасад по договорной цене в месяц: что уже начислено ----------
CREATE TABLE IF NOT EXISTS fin_monthly_meal_charges (
  resident_id uuid NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  period date NOT NULL,
  charge_id uuid NOT NULL UNIQUE REFERENCES fin_charges(id),
  PRIMARY KEY (resident_id, period)
);
ALTER TABLE fin_monthly_meal_charges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_monthly_meal_charges FROM anon, authenticated;

-- ---------- договорённость места: + meals_month ----------
ALTER TABLE fin_stay_agreements DROP CONSTRAINT IF EXISTS fin_stay_agreements_field_check;
ALTER TABLE fin_stay_agreements ADD CONSTRAINT fin_stay_agreements_field_check
  CHECK (field = ANY (ARRAY['late_fee', 'people', 'room_price', 'breakfast_price', 'lunch_price', 'meals_month']));
CREATE OR REPLACE FUNCTION public.fin_stay_agreement_set(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_actor uuid; v_detail text; v_rid uuid; v_field text;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Договорённость ставит администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'field', 'calc_value', 'value', 'comment']);
    v_rid := fin_private_get_uuid(payload, 'resident_id', true);
    if not exists (select 1 from residents where id = v_rid) then
        raise exception 'invalid_payload' using detail = 'Место в шахматке не найдено';
    end if;
    v_field := payload->>'field';
    if v_field is null or v_field not in ('late_fee', 'people', 'room_price', 'breakfast_price', 'lunch_price', 'meals_month') then
        raise exception 'invalid_payload' using detail = 'Неизвестное поле договорённости';
    end if;
    if payload->'value' is null or jsonb_typeof(payload->'value') = 'null' then
        delete from fin_stay_agreements where resident_id = v_rid and field = v_field;
    else
        if (payload->>'value')::numeric < 0 or (v_field = 'people' and (payload->>'value')::numeric < 1) then
            raise exception 'invalid_payload' using detail = 'Недопустимое значение';
        end if;
        insert into fin_stay_agreements (resident_id, field, calc_value, value, comment, created_by)
        values (v_rid, v_field, nullif(payload->>'calc_value', '')::numeric, (payload->>'value')::numeric,
                nullif(btrim(coalesce(payload->>'comment', '')), ''), v_actor)
        on conflict (resident_id, field) do update
           set calc_value = excluded.calc_value, value = excluded.value, comment = excluded.comment,
               created_by = excluded.created_by, created_at = now();
    end if;
    return jsonb_build_object('ok', true, 'result', fin_stay_agreements_get(array[v_rid]), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

-- ---------- «Платит за них»: поставить/снять у брони или места ----------
CREATE OR REPLACE FUNCTION public.fin_set_payer(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payer uuid; v_booking uuid; v_resident uuid; v_detail text;
BEGIN
  IF NOT fin_is_admin(fin_actor()) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Плательщика ставит администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['booking_id', 'resident_id', 'payer_id']);
  v_booking  := fin_private_get_uuid(payload, 'booking_id', false);
  v_resident := fin_private_get_uuid(payload, 'resident_id', false);
  v_payer    := fin_private_get_uuid(payload, 'payer_id', false);
  IF (v_booking IS NULL) = (v_resident IS NULL) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите бронь или место';
  END IF;
  IF v_payer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_payer) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Плательщик не найден';
  END IF;
  IF v_booking IS NOT NULL THEN
    UPDATE bookings SET payer_id = v_payer WHERE id = v_booking;
  ELSE
    UPDATE residents SET payer_id = v_payer WHERE id = v_resident;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Бронь или место не найдено'; END IF;
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
REVOKE ALL ON FUNCTION fin_set_payer(jsonb) FROM anon;

-- ---------- прасад по договорной цене в месяц: начисление ----------
-- За каждый завершённый месяц, в котором место (вне ретрита) было занято, —
-- начисление «питание» на плательщика: место.payer_id → бронь.payer_id →
-- карточка самого места. Цена копируется из договорённости в момент
-- начисления. Месяц целиком, без деления по дням (октябрь семьи КК с 02.10 =
-- 9 000, решение ВГ). Повторный запуск ничего не задваивает.
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
        v_id := gen_random_uuid();
        INSERT INTO fin_charges (id, request_hash, participant_id, retreat_id, kind, description, quantity,
                                 unit_price, amount, discount_amount, currency_code, creation_reason,
                                 created_by, occurred_on, resident_id)
        VALUES (v_id,
                fin_private_hash(jsonb_build_object('command', 'monthly_meals', 'resident_id', lower(r.id::text), 'period', v_cursor)),
                r.payer, v_ret, 'meals',
                format('Прасад за %s %s — %s (договорная цена в месяц)',
                       v_months[extract(month FROM v_cursor)::int], extract(year FROM v_cursor)::int, v_name),
                1, r.price, r.price, 0, 'INR', 'Прасад: договорная цена в месяц',
                COALESCE(r.ag_by, auth.uid()), v_end, r.id);
        INSERT INTO fin_monthly_meal_charges (resident_id, period, charge_id) VALUES (r.id, v_cursor, v_id);
        -- чтобы список визитов видел эти дни начисленными
        INSERT INTO fin_visit_charge_periods (charge_id, resident_id, d_from, d_to)
        VALUES (v_id, r.id, GREATEST(r.check_in, v_cursor), LEAST(COALESCE(r.check_out, v_end), v_end));
        v_n := v_n + 1;
      END IF;
      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;
  END LOOP;
  RETURN v_n;
END;
$function$;
REVOKE ALL ON FUNCTION fin_private_charge_monthly_meals(date) FROM anon, authenticated;

-- ---------- начисление по расписанию: оклад + жильё + прасад по месяцам ----------
CREATE OR REPLACE FUNCTION public.fin_run_payroll_accrual()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_last_period date;   -- последний полностью завершённый месяц (IST)
  v_this_month date;    -- текущий месяц (IST): жильё начисляется вперёд
  r fin_payroll_positions%ROWTYPE;
  v_cursor date;
  v_period_end date;
  v_days_in_month int;
  v_worked_start date;
  v_worked_end date;
  v_days_worked int;
  v_amount numeric;
BEGIN
  v_this_month  := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)::date;
  v_last_period := (v_this_month - interval '1 month')::date;

  FOR r IN
    SELECT * FROM fin_payroll_positions
    WHERE salary_amount IS NOT NULL
      AND date_trunc('month', effective_from)::date <= v_last_period
  LOOP
    v_cursor := date_trunc('month', r.effective_from)::date;
    WHILE v_cursor <= v_last_period LOOP
      v_period_end    := (v_cursor + interval '1 month' - interval '1 day')::date;
      v_days_in_month := v_period_end - v_cursor + 1;
      v_worked_start  := GREATEST(r.effective_from, v_cursor);
      v_worked_end    := LEAST(COALESCE(r.effective_to, v_period_end), v_period_end);

      IF v_worked_start <= v_worked_end THEN
        v_days_worked := v_worked_end - v_worked_start + 1;
        v_amount := round(r.salary_amount * v_days_worked / v_days_in_month, 2);

        INSERT INTO fin_payroll_accruals (position_id, period, amount, currency_code, days_worked, days_in_month)
        VALUES (r.id, v_cursor, v_amount, r.currency_code, v_days_worked, v_days_in_month)
        ON CONFLICT (position_id, period) DO NOTHING;
      END IF;

      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;
  END LOOP;

  -- Жильё (790): с текущим месяцем включительно; неполный месяц — по дням,
  -- как оклад, чтобы смена суммы посреди месяца не задвоила начисление
  FOR r IN
    SELECT * FROM fin_payroll_positions
    WHERE housing_amount IS NOT NULL
      AND date_trunc('month', effective_from)::date <= v_this_month
  LOOP
    v_cursor := date_trunc('month', r.effective_from)::date;
    WHILE v_cursor <= v_this_month LOOP
      v_period_end    := (v_cursor + interval '1 month' - interval '1 day')::date;
      v_days_in_month := v_period_end - v_cursor + 1;
      v_worked_start  := GREATEST(r.effective_from, v_cursor);
      v_worked_end    := LEAST(COALESCE(r.effective_to, v_period_end), v_period_end);

      IF v_worked_start <= v_worked_end THEN
        v_days_worked := v_worked_end - v_worked_start + 1;
        v_amount := round(r.housing_amount * v_days_worked / v_days_in_month, 2);

        INSERT INTO fin_payroll_housing_accruals (position_id, period, amount, currency_code, days_worked, days_in_month)
        VALUES (r.id, v_cursor, v_amount, r.currency_code, v_days_worked, v_days_in_month)
        ON CONFLICT (position_id, period) WHERE NOT is_manual DO NOTHING;
      END IF;

      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;
  END LOOP;

  -- Прасад по договорной цене в месяц (790) — за завершённые месяцы
  PERFORM fin_private_charge_monthly_meals(v_last_period);
END;
$function$;

-- ---------- долг человека в «Гостях без события» (то, что можно удержать) ----------
CREATE OR REPLACE FUNCTION public.fin_payroll_person_debt(p_vaishnava uuid, p_currency text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ret uuid := fin_private_no_event_retreat();
  v_obj uuid;
  v_bal jsonb;
BEGIN
  IF p_vaishnava IS NULL OR v_ret IS NULL THEN RETURN 0; END IF;
  SELECT id INTO v_obj FROM fin_accounting_objects WHERE retreat_id = v_ret;
  IF NOT EXISTS (SELECT 1 FROM fin_charges WHERE participant_id = p_vaishnava AND retreat_id = v_ret AND NOT is_cancelled)
     AND NOT EXISTS (SELECT 1 FROM fin_postings WHERE participant_id = p_vaishnava AND object_id = v_obj) THEN
    RETURN 0;
  END IF;
  v_bal := fin_private_participant_balance_v2(p_vaishnava, v_ret);
  IF v_bal->>'currency' IS DISTINCT FROM p_currency THEN RETURN 0; END IF;
  RETURN GREATEST(COALESCE((v_bal->>'net')::numeric, 0), 0);
END;
$function$;
REVOKE ALL ON FUNCTION fin_payroll_person_debt(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION fin_payroll_person_debt(uuid, text) TO authenticated;

-- ---------- на руки по выплате оклада ----------
CREATE OR REPLACE FUNCTION public.fin_payroll_on_hand(p_payment uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT po.amount - fpp.withheld_amount
    FROM fin_payroll_payments fpp JOIN fin_postings po ON po.id = fpp.posting_id
   WHERE fpp.id = p_payment;
$function$;
REVOKE ALL ON FUNCTION fin_payroll_on_hand(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION fin_payroll_on_hand(uuid) TO authenticated;

-- ---------- представления ведомости ----------
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
                   FROM fin_payroll_housing_accruals GROUP BY position_id) hacc ON hacc.position_id = pp.id
     LEFT JOIN ( SELECT hp.position_id, sum(po.amount) AS total
                   FROM fin_payroll_housing_payments hp
                   JOIN fin_postings po ON po.id = hp.posting_id
                   JOIN fin_operations o ON o.id = po.operation_id
                  WHERE NOT o.is_reversed
                  GROUP BY hp.position_id) hpay ON hpay.position_id = pp.id
  WHERE fin_is_admin();

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
    ((EXISTS ( SELECT 1
           FROM (tg_user_links l
             JOIN fin_payroll_positions pp ON ((pp.vaishnava_id = l.vaishnava_id)))
          WHERE (pp.id = fpp.position_id))) AND (NOT fin_payroll_dm_failed(fpp.dm_outbox_id))) AS recipient_linked,
    fpp.withheld_amount,
    (po.amount - fpp.withheld_amount) AS on_hand
   FROM ((fin_payroll_payments fpp
     JOIN fin_postings po ON ((po.id = fpp.posting_id)))
     JOIN fin_operations o ON ((o.id = po.operation_id)))
  WHERE fin_is_admin();

CREATE OR REPLACE VIEW fin_v_payroll_housing AS
 SELECT 'accrual'::text AS kind, a.id, a.position_id, a.period AS on_date, a.amount, a.currency_code,
        a.comment, a.is_manual, a.days_worked, a.days_in_month,
        NULL::text AS paid_to, NULL::text AS payee, false AS is_reversed
   FROM fin_payroll_housing_accruals a
  WHERE fin_is_admin()
 UNION ALL
 SELECT 'payment'::text, hp.id, hp.position_id, o.occurred_on, po.amount, po.currency_code,
        o.comment, false, NULL::int, NULL::int,
        hp.paid_to, hp.payee, o.is_reversed
   FROM fin_payroll_housing_payments hp
   JOIN fin_postings po ON po.id = hp.posting_id
   JOIN fin_operations o ON o.id = po.operation_id
  WHERE fin_is_admin();
GRANT SELECT ON fin_v_payroll_housing TO authenticated;

-- ---------- позиция: + жильё в пакете ----------
CREATE OR REPLACE FUNCTION public.fin_save_payroll_position(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_cur fin_payroll_positions%ROWTYPE;
  v_vaishnava uuid;
  v_department uuid;
  v_title text;
  v_salary numeric;
  v_housing numeric;
  v_currency text;
  v_from date;
  v_has_history boolean;
  v_new_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY[
    'id', 'vaishnava_id', 'department_id', 'position_title', 'salary_amount', 'currency_code', 'effective_from', 'housing_amount'
  ]);

  v_id         := fin_private_get_uuid(payload, 'id', false);
  v_vaishnava  := fin_private_get_uuid(payload, 'vaishnava_id', true);
  v_department := fin_private_get_uuid(payload, 'department_id', true);
  v_title      := NULLIF(btrim(COALESCE(payload->>'position_title', '')), '');
  v_currency   := COALESCE(NULLIF(payload->>'currency_code', ''), 'INR');
  v_from       := COALESCE(fin_private_get_date(payload, 'effective_from', false), current_date);
  v_salary     := CASE WHEN NULLIF(payload->>'salary_amount', '') IS NULL
                        THEN NULL ELSE fin_private_get_money(payload, 'salary_amount', false) END;
  v_housing    := CASE WHEN NULLIF(payload->>'housing_amount', '') IS NULL
                        THEN NULL ELSE fin_private_get_money(payload, 'housing_amount', false) END;

  IF v_title IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Должность обязательна';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_vaishnava) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Человек не найден в справочнике людей';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = v_department) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = v_currency AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Валюта не найдена';
  END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_cur FROM fin_payroll_positions WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
    END IF;
    IF v_cur.effective_to IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Эта запись уже закрыта — заведите новую позицию';
    END IF;
    -- старый экран не знает про жильё — не передал ключ, значит жильё не меняем
    IF NOT (payload ? 'housing_amount') THEN v_housing := v_cur.housing_amount; END IF;

    v_has_history := EXISTS (SELECT 1 FROM fin_payroll_accruals WHERE position_id = v_id)
                   OR EXISTS (SELECT 1 FROM fin_payroll_payments WHERE position_id = v_id)
                   OR EXISTS (SELECT 1 FROM fin_payroll_housing_accruals WHERE position_id = v_id)
                   OR EXISTS (SELECT 1 FROM fin_payroll_housing_payments WHERE position_id = v_id);

    IF NOT v_has_history THEN
      UPDATE fin_payroll_positions
         SET vaishnava_id = v_vaishnava, department_id = v_department, position_title = v_title,
             salary_amount = v_salary, housing_amount = v_housing, currency_code = v_currency, effective_from = v_from
       WHERE id = v_id
      RETURNING id INTO v_new_id;
    ELSE
      IF v_from <= v_cur.effective_from THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата изменения должна быть позже даты начала текущей записи';
      END IF;
      UPDATE fin_payroll_positions SET effective_to = v_from - 1 WHERE id = v_id;
      INSERT INTO fin_payroll_positions
        (vaishnava_id, department_id, position_title, salary_amount, housing_amount, currency_code, effective_from, created_by)
      VALUES (v_vaishnava, v_department, v_title, v_salary, v_housing, v_currency, v_from, fin_actor())
      RETURNING id INTO v_new_id;
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM fin_payroll_positions
               WHERE vaishnava_id = v_vaishnava AND department_id = v_department AND effective_to IS NULL) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У этого человека уже есть действующая позиция в этом департаменте';
    END IF;
    INSERT INTO fin_payroll_positions
      (vaishnava_id, department_id, position_title, salary_amount, housing_amount, currency_code, effective_from, created_by)
    VALUES (v_vaishnava, v_department, v_title, v_salary, v_housing, v_currency, v_from, fin_actor())
    RETURNING id INTO v_new_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_new_id));
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

-- ---------- выплата оклада: на руки + удержание ----------
-- amount — на руки (выдача из кассы, может быть 0, если удержано всё),
-- withhold_amount — удержано в счёт долга. Расход «Оплата труда» = сумма обоих.
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
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'comment', 'withhold_amount']);

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
  VALUES (v_row_id, v_position.id, v_withhold, CASE WHEN v_withhold > 0 THEN v_withhold_request_id END);

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

-- ---------- оплата жилья: расход «Жильё за пределами ШРСК» ----------
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
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'amount', 'occurred_on', 'paid_to', 'payee', 'comment']);

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
  IF v_paid_to = 'reimburse' AND v_payee IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите, кому возвращаем';
  END IF;

  v_comment := 'Жильё: ' || fin_private_person_name(v_position.vaishnava_id) || ' — '
    || CASE v_paid_to WHEN 'landlord' THEN 'отдано хозяину'
                      WHEN 'employee' THEN 'отдано сотруднику'
                      ELSE 'возврат заплатившему' END
    || COALESCE(' ' || v_payee, '')
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

  INSERT INTO fin_payroll_housing_payments (posting_id, position_id, paid_to, payee, created_by)
  VALUES (v_row_id, v_position.id, v_paid_to, v_payee, auth.uid());

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

-- ---------- ручная строка жилья (свет по чеку) и её удаление ----------
CREATE OR REPLACE FUNCTION public.fin_payroll_housing_line(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE;
  v_del uuid;
  v_period date;
  v_comment text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'period', 'amount', 'comment', 'delete_id']);
  v_del := fin_private_get_uuid(payload, 'delete_id', false);
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
REVOKE ALL ON FUNCTION fin_pay_payroll_housing(jsonb) FROM anon;
REVOKE ALL ON FUNCTION fin_payroll_housing_line(jsonb) FROM anon;

-- ---------- сторно выплаты оклада возвращает удержание в долг ----------
CREATE OR REPLACE FUNCTION public.fin_payroll_withhold_follow_reversal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op uuid;
  v_res jsonb;
BEGIN
  FOR v_op IN
    SELECT fpp.withhold_operation_id
      FROM fin_payroll_payments fpp
      JOIN fin_postings po ON po.id = fpp.posting_id
      JOIN fin_operations w ON w.id = fpp.withhold_operation_id
     WHERE po.operation_id = NEW.id AND NOT w.is_reversed
  LOOP
    v_res := fin_create_reversal(jsonb_build_object(
      'request_id', fin_private_child_uuid(NEW.id, 'payroll-withhold'),
      'original_operation_id', v_op,
      'occurred_on_policy', 'actual_reverse_date',
      'occurred_on', (now() AT TIME ZONE 'Asia/Kolkata')::date,
      'reason', 'Сторно выплаты зарплаты — удержание возвращается в долг'));
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'pair_reversal_failed'
        USING DETAIL = 'Не удалось сторнировать удержание: ' || COALESCE(v_res#>>'{error,message}', 'ошибка');
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;
DROP TRIGGER IF EXISTS trg_payroll_withhold_follow_reversal ON fin_operations;
CREATE TRIGGER trg_payroll_withhold_follow_reversal
  AFTER UPDATE OF is_reversed ON fin_operations
  FOR EACH ROW WHEN (NEW.is_reversed AND NOT OLD.is_reversed AND NEW.type = 'expense')
  EXECUTE FUNCTION fin_payroll_withhold_follow_reversal();

-- ---------- Телеграм: «Получил» — только за то, что на руках ----------
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
  -- удержано всё — денег на руки нет, подтверждать нечего (790)
  IF COALESCE(fin_payroll_on_hand(NEW.id), 0) <= 0 THEN
    RETURN NEW;
  END IF;
  UPDATE fin_payroll_payments SET confirm_requested_at = now() WHERE id = NEW.id;
  PERFORM tg_payroll_send_dm(NEW.id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_payroll_send_dm(p_payment uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay fin_payroll_payments%ROWTYPE;
  v_pos fin_payroll_positions%ROWTYPE;
  v_tg bigint;
  v_amount numeric;
  v_hand numeric;
  v_cur text;
  v_on date;
  v_reversed boolean;
  v_dept text;
  v_id bigint;
  v_salaried boolean;
  v_m text[];
  v_body text;
BEGIN
  SELECT * INTO v_pay FROM fin_payroll_payments WHERE id = p_payment;
  IF NOT FOUND OR v_pay.confirmed_at IS NOT NULL THEN RETURN false; END IF;
  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = v_pay.position_id;

  SELECT tg_user_id INTO v_tg FROM tg_user_links WHERE vaishnava_id = v_pos.vaishnava_id
   ORDER BY linked_at DESC LIMIT 1;
  IF v_tg IS NULL THEN RETURN false; END IF;

  SELECT po.amount, po.currency_code, o.occurred_on, o.is_reversed
    INTO v_amount, v_cur, v_on, v_reversed
    FROM fin_postings po JOIN fin_operations o ON o.id = po.operation_id
   WHERE po.id = v_pay.posting_id;
  IF v_reversed THEN RETURN false; END IF;
  v_hand := v_amount - v_pay.withheld_amount;
  IF v_hand <= 0 THEN RETURN false; END IF;
  SELECT name INTO v_dept FROM fin_departments WHERE id = v_pos.department_id;

  v_salaried := v_pos.salary_amount IS NOT NULL
    OR EXISTS (SELECT 1 FROM fin_payroll_accruals WHERE position_id = v_pos.id);

  IF v_salaried THEN
    v_m := regexp_match(fin_payroll_paid_phrase(v_pos.id), '^зарплата за (.+) выдана (\S+)$');
    v_body := E'Спасибо большое за ваше служение!\n\n'
      || CASE WHEN v_m IS NULL
              THEN format('💰 Ваша зарплата: <b>%s</b>', fin_fmt_money(v_amount, v_cur))
              WHEN v_pay.withheld_amount > 0
              THEN format('💰 Ваша зарплата за %s: %s — выдана %s.', v_m[1], fin_fmt_money(v_amount, v_cur), v_m[2])
              ELSE format('💰 Ваша зарплата за %s: <b>%s</b> — выдана %s.',
                          v_m[1], fin_fmt_money(v_amount, v_cur), v_m[2]) END
      || CASE WHEN v_pay.withheld_amount > 0
              THEN format(E'\n• Удержано за прасад семьи: %s\n• На руки: <b>%s</b>',
                          fin_fmt_money(v_pay.withheld_amount, v_cur), fin_fmt_money(v_hand, v_cur))
              ELSE '' END
      || CASE WHEN v_pos.housing_amount IS NOT NULL AND v_pos.salary_amount IS NOT NULL
              THEN format(E'\n\n🏠 Ваш пакет в месяц: оклад %s + жильё %s = %s. Жильё ШРСК оплачивает отдельно.',
                          fin_fmt_money(v_pos.salary_amount, v_cur), fin_fmt_money(v_pos.housing_amount, v_cur),
                          fin_fmt_money(v_pos.salary_amount + v_pos.housing_amount, v_cur))
              ELSE '' END;
  ELSE
    v_body := E'Спасибо большое за ваше служение! В качестве благодарности примите, пожалуйста:\n\n'
      || format('💰 <b>%s</b>', fin_fmt_money(v_hand, v_cur));
  END IF;

  INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
  VALUES (v_tg,
    E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n'
    || v_body
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || E'\n\nПожалуйста, нажмите «✅ Получил», если денежки у вас.',
    NULL, 'finance',
    jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
      jsonb_build_object('text', '✅ Получил', 'callback_data', 'pc:' || p_payment::text)))))
  RETURNING id INTO v_id;
  PERFORM tg_outbox_try(v_id);

  UPDATE fin_payroll_payments SET dm_sent_at = now(), dm_outbox_id = v_id WHERE id = p_payment;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_payroll_remind()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_id bigint;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT fp.id, l.tg_user_id, po.amount - fp.withheld_amount AS amount, po.currency_code, o.occurred_on, d.name AS dept
      FROM fin_payroll_payments fp
      JOIN fin_payroll_positions p ON p.id = fp.position_id
      JOIN fin_departments d ON d.id = p.department_id
      JOIN fin_postings po ON po.id = fp.posting_id
      JOIN fin_operations o ON o.id = po.operation_id
      JOIN LATERAL (SELECT tg_user_id FROM tg_user_links WHERE vaishnava_id = p.vaishnava_id
                     ORDER BY linked_at DESC LIMIT 1) l ON true
     WHERE fp.confirm_requested_at IS NOT NULL
       AND fp.confirmed_at IS NULL
       AND fp.dm_sent_at IS NOT NULL
       AND NOT o.is_reversed
       AND fin_payroll_tg_enabled(p.vaishnava_id)
       AND COALESCE(fp.reminded_at, fp.dm_sent_at) <= now() - interval '47 hours'
  LOOP
    BEGIN
      INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
      VALUES (r.tg_user_id,
        E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\nНапоминаем: пожалуйста, подтвердите получение.\n\n'
        || format('💰 <b>%s</b>', fin_fmt_money(r.amount, r.currency_code))
        || format(E'\nДепартамент: %s', tg_escape(r.dept))
        || format(E'\nДата: %s', to_char(r.occurred_on, 'DD.MM.YYYY'))
        || E'\n\nЕсли денежки у вас, нажмите, пожалуйста, «✅ Получил».',
        NULL, 'finance',
        jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
          jsonb_build_object('text', '✅ Получил', 'callback_data', 'pc:' || r.id::text)))))
      RETURNING id INTO v_id;
      PERFORM tg_outbox_try(v_id);
      UPDATE fin_payroll_payments SET reminded_at = now() WHERE id = r.id;
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_payroll_confirm(p_payment uuid, p_tg_user bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay fin_payroll_payments%ROWTYPE;
  v_vaishnava uuid;
  v_amount numeric;
  v_cur text;
  v_on date;
  v_reversed boolean;
  v_dept text;
BEGIN
  SELECT fpp.* INTO v_pay FROM fin_payroll_payments fpp WHERE fpp.id = p_payment FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT pp.vaishnava_id, d.name INTO v_vaishnava, v_dept
    FROM fin_payroll_positions pp JOIN fin_departments d ON d.id = pp.department_id
   WHERE pp.id = v_pay.position_id;
  IF NOT EXISTS (SELECT 1 FROM tg_user_links WHERE tg_user_id = p_tg_user AND vaishnava_id = v_vaishnava) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_recipient');
  END IF;

  SELECT po.amount - v_pay.withheld_amount, po.currency_code, o.occurred_on, o.is_reversed
    INTO v_amount, v_cur, v_on, v_reversed
    FROM fin_postings po JOIN fin_operations o ON o.id = po.operation_id
   WHERE po.id = v_pay.posting_id;
  IF v_reversed THEN RETURN jsonb_build_object('ok', false, 'error', 'reversed'); END IF;

  IF v_pay.confirmed_at IS NULL THEN
    UPDATE fin_payroll_payments SET confirmed_at = now() WHERE id = p_payment
    RETURNING * INTO v_pay;
  END IF;

  RETURN jsonb_build_object('ok', true, 'text',
    format('💰 %s: <b>%s</b>',
           CASE WHEN v_pay.withheld_amount > 0 THEN 'Зарплата на руки'
                WHEN fin_payroll_is_salaried(v_pay.position_id) THEN 'Зарплата' ELSE 'Благодарность за служение' END,
           fin_fmt_money(v_amount, v_cur))
    || format(E'\nДепартамент: %s', tg_escape(v_dept))
    || format(E'\nДата: %s', to_char(v_on, 'DD.MM.YYYY'))
    || format(E'\n\n✅ Получение подтверждено %s. Спасибо!',
              to_char(v_pay.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'DD.MM.YYYY HH24:MI')));
END;
$function$;
