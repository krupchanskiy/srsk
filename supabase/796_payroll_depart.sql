-- =============================================================
-- 796. «Уехал» в зарплатной ведомости (ВГ 18.11)
--
-- Три случая:
--   left   — уехал надолго: позиция закрывается датой отъезда (последний
--            оплачиваемый день), последний месяц оклада и жилья — по дням;
--            «Вернулся» — новый период с теми же условиями.
--   unpaid — временно без оплаты, с — по включительно: дни вычитаются из
--            оклада, по галочке — и из жилья.
--   paid   — временно, оплата идёт: только отметка.
-- Автоначисления затронутых месяцев пересчитываются; ручные — нет, о них
-- возвращается предупреждение.
-- =============================================================

CREATE TABLE IF NOT EXISTS fin_payroll_absences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id uuid NOT NULL REFERENCES vaishnavas(id),
  department_id uuid NOT NULL REFERENCES fin_departments(id),
  kind text NOT NULL CHECK (kind IN ('left', 'unpaid', 'paid')),
  d_from date NOT NULL,
  d_to date,
  stop_housing boolean NOT NULL DEFAULT false,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CHECK (d_to IS NULL OR d_to >= d_from),
  CHECK (kind <> 'unpaid' OR d_to IS NOT NULL)
);
ALTER TABLE fin_payroll_absences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_payroll_absences FROM anon, authenticated;

CREATE OR REPLACE VIEW fin_v_payroll_absences AS
 SELECT id, vaishnava_id, department_id, kind, d_from, d_to, stop_housing, reason, created_at
   FROM fin_payroll_absences
  WHERE cancelled_at IS NULL AND fin_is_admin();
GRANT SELECT ON fin_v_payroll_absences TO authenticated;

-- дни «временно, без оплаты» в отрезке (для жилья — только с галочкой)
CREATE OR REPLACE FUNCTION public.fin_private_payroll_absent_days(p_vaishnava uuid, p_dept uuid, p_from date, p_to date, p_housing boolean)
 RETURNS int
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT count(DISTINCT d)::int
    FROM fin_payroll_absences a,
         generate_series(GREATEST(a.d_from, p_from), LEAST(a.d_to, p_to), interval '1 day') d
   WHERE a.vaishnava_id = p_vaishnava AND a.department_id = p_dept
     AND a.kind = 'unpaid' AND a.cancelled_at IS NULL
     AND (NOT p_housing OR a.stop_housing)
     AND a.d_from <= p_to AND a.d_to >= p_from;
$function$;
REVOKE ALL ON FUNCTION fin_private_payroll_absent_days(uuid, uuid, date, date, boolean) FROM anon, authenticated;

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
        -- минус дни «временно, без оплаты» (796)
        v_days_worked := v_worked_end - v_worked_start + 1
          - fin_private_payroll_absent_days(r.vaishnava_id, r.department_id, v_worked_start, v_worked_end, false);
        v_amount := round(r.salary_amount * v_days_worked / v_days_in_month, 2);

        IF v_days_worked > 0 THEN
        INSERT INTO fin_payroll_accruals (position_id, period, amount, currency_code, days_worked, days_in_month)
        VALUES (r.id, v_cursor, v_amount, r.currency_code, v_days_worked, v_days_in_month)
        ON CONFLICT (position_id, period) DO NOTHING;
        END IF;
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
        v_days_worked := v_worked_end - v_worked_start + 1
          - fin_private_payroll_absent_days(r.vaishnava_id, r.department_id, v_worked_start, v_worked_end, true);
        v_amount := round(r.housing_amount * v_days_worked / v_days_in_month, 2);

        IF v_days_worked > 0 THEN
        INSERT INTO fin_payroll_housing_accruals (position_id, period, amount, currency_code, days_worked, days_in_month)
        VALUES (r.id, v_cursor, v_amount, r.currency_code, v_days_worked, v_days_in_month)
        ON CONFLICT (position_id, period) WHERE NOT is_manual DO NOTHING;
        END IF;
      END IF;

      v_cursor := (v_cursor + interval '1 month')::date;
    END LOOP;
  END LOOP;

  -- Прасад по договорной цене в месяц (790) — за завершённые месяцы
  PERFORM fin_private_charge_monthly_meals(v_last_period);
END;
$function$;


-- Пересчёт автоначислений человека в департаменте с месяца p_from: по дням
-- действия позиции минус дни без оплаты; месяц вне позиции — удаляется.
-- Ручные начисления не трогаются — возвращаются предупреждением.
CREATE OR REPLACE FUNCTION public.fin_private_payroll_recalc(p_vaishnava uuid, p_dept uuid, p_from date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month date := date_trunc('month', p_from)::date;
  r record;
  v_end date; v_dim int; v_s date; v_e date; v_days int;
  v_warn jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT a.id, a.period, a.is_manual, a.amount, p.salary_amount AS base, p.effective_from, p.effective_to, p.currency_code
      FROM fin_payroll_accruals a JOIN fin_payroll_positions p ON p.id = a.position_id
     WHERE p.vaishnava_id = p_vaishnava AND p.department_id = p_dept AND a.period >= v_month
  LOOP
    IF r.is_manual THEN
      v_warn := v_warn || jsonb_build_array(jsonb_build_object('code', 'manual_accrual',
        'message', format('Оклад за %s начислен вручную (%s) — не пересчитан, поправьте сами',
                          to_char(r.period, 'MM.YYYY'), fin_fmt_money(r.amount, r.currency_code))));
      CONTINUE;
    END IF;
    CONTINUE WHEN r.base IS NULL;
    v_end := (r.period + interval '1 month' - interval '1 day')::date;
    v_dim := v_end - r.period + 1;
    v_s := GREATEST(r.effective_from, r.period);
    v_e := LEAST(COALESCE(r.effective_to, v_end), v_end);
    v_days := CASE WHEN v_s > v_e THEN 0
                   ELSE v_e - v_s + 1 - fin_private_payroll_absent_days(p_vaishnava, p_dept, v_s, v_e, false) END;
    IF v_days <= 0 THEN
      DELETE FROM fin_payroll_accruals WHERE id = r.id;
    ELSE
      UPDATE fin_payroll_accruals
         SET amount = round(r.base * v_days / v_dim, 2), days_worked = v_days, days_in_month = v_dim
       WHERE id = r.id;
    END IF;
  END LOOP;

  FOR r IN
    SELECT a.id, a.period, p.housing_amount AS base, p.effective_from, p.effective_to
      FROM fin_payroll_housing_accruals a JOIN fin_payroll_positions p ON p.id = a.position_id
     WHERE p.vaishnava_id = p_vaishnava AND p.department_id = p_dept AND a.period >= v_month
       AND NOT a.is_manual AND a.cancelled_at IS NULL
  LOOP
    CONTINUE WHEN r.base IS NULL;
    v_end := (r.period + interval '1 month' - interval '1 day')::date;
    v_dim := v_end - r.period + 1;
    v_s := GREATEST(r.effective_from, r.period);
    v_e := LEAST(COALESCE(r.effective_to, v_end), v_end);
    v_days := CASE WHEN v_s > v_e THEN 0
                   ELSE v_e - v_s + 1 - fin_private_payroll_absent_days(p_vaishnava, p_dept, v_s, v_e, true) END;
    IF v_days <= 0 THEN
      DELETE FROM fin_payroll_housing_accruals WHERE id = r.id;
    ELSE
      UPDATE fin_payroll_housing_accruals
         SET amount = round(r.base * v_days / v_dim, 2), days_worked = v_days, days_in_month = v_dim
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- вернувшиеся/отменённые дни: недостающие месяцы досоздаёт обычное начисление
  PERFORM fin_run_payroll_accrual();
  RETURN v_warn;
END;
$function$;
REVOKE ALL ON FUNCTION fin_private_payroll_recalc(uuid, uuid, date) FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fin_payroll_depart(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE;
  v_kind text; v_from date; v_to date; v_reason text; v_warn jsonb := '[]'::jsonb; v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'kind', 'd_from', 'd_to', 'stop_housing', 'reason']);
  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = fin_private_get_uuid(payload, 'position_id', true) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена'; END IF;
  IF v_pos.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция уже закрыта';
  END IF;
  v_kind := payload->>'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('left', 'unpaid', 'paid') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Выберите: надолго / временно без оплаты / временно с оплатой';
  END IF;
  v_from := fin_private_get_date(payload, 'd_from', true);
  v_to := fin_private_get_date(payload, 'd_to', false);
  v_reason := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  IF v_from < v_pos.effective_from THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата раньше начала работы в департаменте';
  END IF;
  IF v_kind = 'unpaid' AND v_to IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите, по какое число без оплаты';
  END IF;
  IF v_to IS NOT NULL AND v_to < v_from THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата «по» раньше даты «с»';
  END IF;

  INSERT INTO fin_payroll_absences (vaishnava_id, department_id, kind, d_from, d_to, stop_housing, reason, created_by)
  VALUES (v_pos.vaishnava_id, v_pos.department_id, v_kind, v_from, CASE WHEN v_kind = 'left' THEN NULL ELSE v_to END,
          v_kind = 'unpaid' AND COALESCE((payload->>'stop_housing')::boolean, false), v_reason, auth.uid());

  IF v_kind = 'left' THEN
    UPDATE fin_payroll_positions SET effective_to = v_from WHERE id = v_pos.id;
  END IF;
  IF v_kind IN ('left', 'unpaid') THEN
    v_warn := fin_private_payroll_recalc(v_pos.vaishnava_id, v_pos.department_id, v_from);
  END IF;
  RETURN jsonb_build_object('ok', true, 'warnings', v_warn);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

-- Отменить временный отъезд (ошибка, передумали) — дни возвращаются в начисление
CREATE OR REPLACE FUNCTION public.fin_payroll_absence_cancel(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_a fin_payroll_absences%ROWTYPE; v_warn jsonb := '[]'::jsonb; v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id']);
  SELECT * INTO v_a FROM fin_payroll_absences WHERE id = fin_private_get_uuid(payload, 'id', true) AND cancelled_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Отъезд не найден'; END IF;
  IF v_a.kind = 'left' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Отъезд надолго снимается кнопкой «Вернулся»';
  END IF;
  UPDATE fin_payroll_absences SET cancelled_at = now() WHERE id = v_a.id;
  IF v_a.kind = 'unpaid' THEN
    v_warn := fin_private_payroll_recalc(v_a.vaishnava_id, v_a.department_id, v_a.d_from);
  END IF;
  RETURN jsonb_build_object('ok', true, 'warnings', v_warn);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

-- «Вернулся»: новый период с прежними условиями (оклад, жильё, получатель)
CREATE OR REPLACE FUNCTION public.fin_payroll_return(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE; v_from date; v_new uuid; v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'd_from']);
  SELECT * INTO v_pos FROM fin_payroll_positions WHERE id = fin_private_get_uuid(payload, 'position_id', true);
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена'; END IF;
  -- берём последний период человека в департаменте
  SELECT * INTO v_pos FROM fin_payroll_positions
   WHERE vaishnava_id = v_pos.vaishnava_id AND department_id = v_pos.department_id
   ORDER BY effective_from DESC LIMIT 1;
  IF v_pos.effective_to IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Человек и так работает в департаменте';
  END IF;
  v_from := fin_private_get_date(payload, 'd_from', true);
  IF v_from <= v_pos.effective_to THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Дата возвращения должна быть позже %s', to_char(v_pos.effective_to, 'DD.MM.YYYY'));
  END IF;
  INSERT INTO fin_payroll_positions (vaishnava_id, department_id, position_title, salary_amount, housing_amount,
                                     currency_code, effective_from, created_by, housing_paid_to, housing_payee)
  VALUES (v_pos.vaishnava_id, v_pos.department_id, v_pos.position_title, v_pos.salary_amount, v_pos.housing_amount,
          v_pos.currency_code, v_from, auth.uid(), v_pos.housing_paid_to, v_pos.housing_payee)
  RETURNING id INTO v_new;
  UPDATE fin_payroll_absences SET d_to = v_from - 1
   WHERE vaishnava_id = v_pos.vaishnava_id AND department_id = v_pos.department_id
     AND kind = 'left' AND d_to IS NULL AND cancelled_at IS NULL;
  PERFORM fin_run_payroll_accrual();
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_new));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
REVOKE ALL ON FUNCTION fin_payroll_depart(jsonb) FROM anon;
REVOKE ALL ON FUNCTION fin_payroll_absence_cancel(jsonb) FROM anon;
REVOKE ALL ON FUNCTION fin_payroll_return(jsonb) FROM anon;

-- Бот: выплата сверх начисленного — «Аванс в счёт зарплаты»
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
  v_accrued numeric;
  v_paid numeric;
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

  -- Выплата целиком сверх начисленного — это аванс (796): «зарплата за октябрь
  -- выдана полностью» на аванс за ноябрь вводила бы в заблуждение
  SELECT COALESCE(sum(amount), 0) INTO v_accrued FROM fin_payroll_accruals a
    JOIN fin_payroll_positions p ON p.id = a.position_id
   WHERE p.vaishnava_id = v_pos.vaishnava_id AND p.department_id = v_pos.department_id;
  SELECT COALESCE(sum(po.amount), 0) INTO v_paid
    FROM fin_payroll_payments f JOIN fin_payroll_positions p ON p.id = f.position_id
    JOIN fin_postings po ON po.id = f.posting_id JOIN fin_operations o ON o.id = po.operation_id
   WHERE p.vaishnava_id = v_pos.vaishnava_id AND p.department_id = v_pos.department_id AND NOT o.is_reversed;

  IF v_salaried AND v_paid - v_amount >= v_accrued - 0.005 THEN
    v_body := E'Спасибо большое за ваше служение!\n\n'
      || format('💰 Аванс в счёт зарплаты: <b>%s</b>', fin_fmt_money(v_hand, v_cur));
  ELSIF v_salaried THEN
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


INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_depart', 'Уехал', 'Left', 'चले गए'),
  ('fin_payroll_depart_left', 'Надолго — закрыть позицию', 'For long — close the position', 'लंबे समय के लिए — पद बंद करें'),
  ('fin_payroll_depart_unpaid', 'Временно, без оплаты', 'Temporarily, unpaid', 'अस्थायी, बिना भुगतान'),
  ('fin_payroll_depart_paid', 'Временно, оплата идёт', 'Temporarily, paid', 'अस्थायी, भुगतान जारी'),
  ('fin_payroll_depart_last_day', 'Последний оплачиваемый день', 'Last paid day', 'अंतिम भुगतान दिवस'),
  ('fin_payroll_depart_from', 'Без оплаты с', 'Unpaid from', 'बिना भुगतान से'),
  ('fin_payroll_depart_to', 'по (включительно)', 'to (inclusive)', 'तक (सहित)'),
  ('fin_payroll_depart_paid_from', 'Уехал', 'Left on', 'गए'),
  ('fin_payroll_depart_paid_to', 'Вернётся (примерно)', 'Returns (approx.)', 'लौटेंगे (लगभग)'),
  ('fin_payroll_depart_stop_housing', 'Жильё за эти дни тоже не начислять', 'Do not accrue housing for these days either', 'इन दिनों का आवास भी न जोड़ें'),
  ('fin_payroll_depart_reason', 'Причина', 'Reason', 'कारण'),
  ('fin_payroll_depart_hint', 'Надолго: последний месяц оклада и жилья — по дням, дальше не начисляется; вернётся — «Вернулся». Ручные начисления не пересчитываются.', 'For long: the last month of salary and housing is by days, nothing after; on return — "Returned". Manual accruals are not recalculated.', 'लंबे समय के लिए: अंतिम महीने का वेतन और आवास दिनों के अनुसार, आगे नहीं; लौटने पर — "लौट आए"। मैनुअल प्रविष्टियाँ पुनर्गणना नहीं होतीं।'),
  ('fin_payroll_return', 'Вернулся', 'Returned', 'लौट आए'),
  ('fin_payroll_return_date', 'Дата возвращения', 'Return date', 'लौटने की तिथि'),
  ('fin_payroll_away_until', 'в отъезде до', 'away until', 'तक बाहर'),
  ('fin_payroll_away', 'в отъезде', 'away', 'बाहर'),
  ('fin_payroll_absences', 'Отъезды', 'Absences', 'अनुपस्थिति'),
  ('fin_payroll_absence_cancel', 'Отменить этот отъезд? Дни вернутся в начисление.', 'Cancel this absence? The days will return to the accrual.', 'यह अनुपस्थिति रद्द करें? दिन फिर से जुड़ेंगे।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
