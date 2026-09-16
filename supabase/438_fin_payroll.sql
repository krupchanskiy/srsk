-- =============================================================
-- Финансовый модуль: зарплатная ведомость (payroll)
--
-- Идея: не «переносить остаток на следующий месяц» отдельной операцией,
-- а считать баланс накопительно — Σ начислений − Σ выплат по позиции.
-- Недоплата, неровная сумма и аванс наследуются сами, потому что это
-- одна и та же формула в разные моменты времени, а не перенос руками.
--
-- Позиция (fin_payroll_positions) — историчная запись «кто, в каком
-- департаменте, с какой должностью и окладом»: смена оклада/должности/
-- департамента закрывает текущую запись (effective_to) и открывает
-- новую, как и периоды пребывания команды. Это даёт бесплатно и
-- пропорциональный расчёт при переводе/найме/увольнении в середине
-- месяца — начисление просто считается по каждой позиции, активной
-- в периоде, независимо.
--
-- Оклад — не обязателен: без него позиция участвует в ведомости, но
-- без автоначисления и без баланса — только точечные «разовые выплаты»
-- (обычный расход департамента без концепции долга).
--
-- Выплата — не новая денежная сущность, а обычная fin_create_expense
-- (статья «Зарплата», счёт — подотчётный счёт департамента), поэтому
-- вся денежная механика (сторно, закрытие объектов, ДДС) достаётся
-- бесплатно. fin_payroll_payments — только тег, связывающий проводку
-- с позицией для расчёта баланса; сама проводка не отличается от любой
-- другой траты департамента.
--
-- Доступ — только финансовый администратор/суперпользователь
-- (fin_is_admin()): суммы окладов закрыты от остальных.
-- =============================================================

-- -------------------------------------------------------------
-- Статья «Зарплата» — до сих пор не заводилась (в TЗ упомянута, но
-- список статей ведёт ВГ через UI, не миграции)
-- -------------------------------------------------------------
INSERT INTO fin_categories (code, name, direction, visible_to_departments, is_active)
VALUES ('salary', 'Зарплата', 'out', false, true)
ON CONFLICT (code) DO NOTHING;

-- -------------------------------------------------------------
-- Таблицы
-- -------------------------------------------------------------
CREATE TABLE fin_payroll_positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id   uuid NOT NULL REFERENCES vaishnavas(id),
  department_id  uuid NOT NULL REFERENCES fin_departments(id),
  position_title text NOT NULL,
  salary_amount  numeric(14,2) CHECK (salary_amount IS NULL OR salary_amount > 0),
  currency_code  text NOT NULL REFERENCES fin_currencies(code),
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date CHECK (effective_to IS NULL OR effective_to >= effective_from),
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- Не может быть двух одновременно действующих позиций одного человека
-- в одном департаменте — иначе непонятно, по какой из них считать баланс
CREATE UNIQUE INDEX fin_payroll_positions_active_uniq
  ON fin_payroll_positions (vaishnava_id, department_id) WHERE effective_to IS NULL;
CREATE INDEX fin_payroll_positions_department_idx ON fin_payroll_positions(department_id);

CREATE TABLE fin_payroll_accruals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id   uuid NOT NULL REFERENCES fin_payroll_positions(id),
  period        date NOT NULL,                    -- первое число начисленного месяца
  amount        numeric(14,2) NOT NULL CHECK (amount > 0),
  currency_code text NOT NULL,
  days_worked   int NOT NULL,
  days_in_month int NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (position_id, period)                     -- защита от двойного начисления за месяц
);

-- Только тег «эта проводка — выплата этой позиции»; сумма/дата/счёт —
-- в самой проводке fin_postings, здесь не дублируются
CREATE TABLE fin_payroll_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_id  uuid NOT NULL UNIQUE REFERENCES fin_postings(id),
  position_id uuid NOT NULL REFERENCES fin_payroll_positions(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fin_payroll_payments_position_idx ON fin_payroll_payments(position_id);

ALTER TABLE fin_payroll_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_payroll_accruals  ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_payroll_payments  ENABLE ROW LEVEL SECURITY;
-- Прямого доступа нет вообще — только через SECURITY DEFINER функции
-- и view fin_v_payroll_positions (сама проверяет fin_is_admin())
REVOKE ALL ON fin_payroll_positions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON fin_payroll_accruals  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON fin_payroll_payments  FROM PUBLIC, anon, authenticated;

-- -------------------------------------------------------------
-- View: позиции + накопленные суммы + баланс.
-- Обслуживает и раздел «Сотрудники» в справочнике департаментов,
-- и саму ведомость.
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW public.fin_v_payroll_positions AS
SELECT
  pp.id,
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
  COALESCE(acc.total_accrued, 0) AS total_accrued,
  COALESCE(pay.total_paid, 0) AS total_paid,
  COALESCE(acc.total_accrued, 0) - COALESCE(pay.total_paid, 0) AS balance,
  pay.last_payment_on
FROM fin_payroll_positions pp
JOIN fin_departments d ON d.id = pp.department_id
LEFT JOIN (
  SELECT position_id, SUM(amount) AS total_accrued
  FROM fin_payroll_accruals GROUP BY position_id
) acc ON acc.position_id = pp.id
LEFT JOIN (
  -- сторнированные выплаты не считаются оплатой (инвариант сторно —
  -- полное зеркало, деньги вернулись на счёт департамента)
  SELECT fpp.position_id,
         SUM(po.amount) AS total_paid,
         MAX(o.occurred_on) AS last_payment_on
  FROM fin_payroll_payments fpp
  JOIN fin_postings po ON po.id = fpp.posting_id
  JOIN fin_operations o ON o.id = po.operation_id
  WHERE NOT o.is_reversed
  GROUP BY fpp.position_id
) pay ON pay.position_id = pp.id
WHERE fin_is_admin();

GRANT SELECT ON public.fin_v_payroll_positions TO authenticated;

-- -------------------------------------------------------------
-- RPC: завести/изменить позицию.
-- Изменение (id передан) = закрыть текущую запись на дату v_from - 1
-- и завести новую — история не переписывается, будущие начисления
-- считаются по новой записи (см. шапку файла).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_save_payroll_position(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_cur fin_payroll_positions%ROWTYPE;
  v_vaishnava uuid;
  v_department uuid;
  v_title text;
  v_salary numeric;
  v_currency text;
  v_from date;
  v_new_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY[
    'id', 'vaishnava_id', 'department_id', 'position_title', 'salary_amount', 'currency_code', 'effective_from'
  ]);

  v_id         := fin_private_get_uuid(payload, 'id', false);
  v_vaishnava  := fin_private_get_uuid(payload, 'vaishnava_id', true);
  v_department := fin_private_get_uuid(payload, 'department_id', true);
  v_title      := NULLIF(btrim(COALESCE(payload->>'position_title', '')), '');
  v_currency   := COALESCE(NULLIF(payload->>'currency_code', ''), 'INR');
  v_from       := COALESCE(fin_private_get_date(payload, 'effective_from', false), current_date);
  v_salary     := CASE WHEN NULLIF(payload->>'salary_amount', '') IS NULL
                        THEN NULL ELSE fin_private_get_money(payload, 'salary_amount', false) END;

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
    IF v_from <= v_cur.effective_from THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата изменения должна быть позже даты начала текущей записи';
    END IF;
    UPDATE fin_payroll_positions SET effective_to = v_from - 1 WHERE id = v_id;
  ELSE
    IF EXISTS (SELECT 1 FROM fin_payroll_positions
               WHERE vaishnava_id = v_vaishnava AND department_id = v_department AND effective_to IS NULL) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У этого человека уже есть действующая позиция в этом департаменте';
    END IF;
  END IF;

  INSERT INTO fin_payroll_positions
    (vaishnava_id, department_id, position_title, salary_amount, currency_code, effective_from, created_by)
  VALUES (v_vaishnava, v_department, v_title, v_salary, v_currency, v_from, fin_actor())
  RETURNING id INTO v_new_id;

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

-- -------------------------------------------------------------
-- RPC: завершить позицию (увольнение/перевод)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_end_payroll_position(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_to date;
  v_cur fin_payroll_positions%ROWTYPE;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id', 'effective_to']);

  v_id := fin_private_get_uuid(payload, 'id', true);
  v_to := COALESCE(fin_private_get_date(payload, 'effective_to', false), current_date);

  SELECT * INTO v_cur FROM fin_payroll_positions WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;
  IF v_cur.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция уже завершена';
  END IF;
  IF v_to < v_cur.effective_from THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дата окончания раньше даты начала';
  END IF;

  UPDATE fin_payroll_positions SET effective_to = v_to WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
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

-- -------------------------------------------------------------
-- RPC: выплата (окладная или разовая — для позиции без оклада).
-- Всего лишь обёртка над fin_create_expense: реальная проводка,
-- статья «Зарплата», счёт — подотчётный счёт департамента позиции.
-- fin_payroll_payments просто помечает эту проводку как выплату
-- конкретной позиции, для расчёта баланса.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_pay_payroll(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_position fin_payroll_positions%ROWTYPE;
  v_amount numeric;
  v_on date;
  v_comment text;
  v_category uuid;
  v_account uuid;
  v_request_id uuid := gen_random_uuid();
  v_row_id uuid := gen_random_uuid();
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

  SELECT id INTO v_category FROM fin_categories WHERE code = 'salary' AND is_active;
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'internal_error' USING DETAIL = 'Статья «Зарплата» не найдена в справочнике';
  END IF;

  v_account := fin_dept_account(v_position.department_id, v_position.currency_code);

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
    RETURN v_res;
  END IF;

  INSERT INTO fin_payroll_payments (posting_id, position_id) VALUES (v_row_id, v_position.id);

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

REVOKE ALL ON FUNCTION public.fin_save_payroll_position(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_end_payroll_position(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_pay_payroll(jsonb)           FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_save_payroll_position(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_end_payroll_position(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fin_pay_payroll(jsonb)           TO authenticated;

-- -------------------------------------------------------------
-- Автоначисление за прошедший месяц, 1-го числа.
-- Пропорция по дням берётся из пересечения [effective_from, effective_to]
-- позиции с календарным периодом — переезд между департаментами или
-- найм/увольнение в середине месяца просто дают две позиции с разными
-- пропорциями, без специального случая.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_run_payroll_accrual() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_period_start date;
  v_period_end date;
  v_days_in_month int;
  r fin_payroll_positions%ROWTYPE;
  v_worked_start date;
  v_worked_end date;
  v_days_worked int;
  v_amount numeric;
BEGIN
  v_period_start := date_trunc('month', ((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '1 month'))::date;
  v_period_end    := (v_period_start + interval '1 month' - interval '1 day')::date;
  v_days_in_month := v_period_end - v_period_start + 1;

  FOR r IN
    SELECT * FROM fin_payroll_positions
    WHERE salary_amount IS NOT NULL
      AND effective_from <= v_period_end
      AND (effective_to IS NULL OR effective_to >= v_period_start)
  LOOP
    v_worked_start := GREATEST(r.effective_from, v_period_start);
    v_worked_end   := LEAST(COALESCE(r.effective_to, v_period_end), v_period_end);
    IF v_worked_start > v_worked_end THEN CONTINUE; END IF;
    v_days_worked := v_worked_end - v_worked_start + 1;
    v_amount := round(r.salary_amount * v_days_worked / v_days_in_month, 2);

    INSERT INTO fin_payroll_accruals (position_id, period, amount, currency_code, days_worked, days_in_month)
    VALUES (r.id, v_period_start, v_amount, r.currency_code, v_days_worked, v_days_in_month)
    ON CONFLICT (position_id, period) DO NOTHING;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_run_payroll_accrual() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('fin-payroll-accrual-monthly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fin-payroll-accrual-monthly');
-- 02:00 UTC 1-го числа = 07:30 IST 1-го числа — точно после полуночи по Индии
SELECT cron.schedule('fin-payroll-accrual-monthly', '0 2 1 * *', $$SELECT public.fin_run_payroll_accrual()$$);
