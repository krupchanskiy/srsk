-- =============================================================
-- Payroll: автоначисление догоняет пропущенные месяцы.
--
-- Было: fin_run_payroll_accrual() каждый раз считал ровно один
-- период — предыдущий календарный месяц относительно «сейчас».
-- Это ломается для человека, заведённого в ведомость задним числом
-- (например, повара забыли внести два месяца, а потом добавили с
-- effective_from в прошлом): позиция готова заранее, у неё есть
-- effective_from за два месяца до сегодня, но следующий прогон cron
-- начислит только «последний завершённый месяц» — предыдущие два
-- месяца так и останутся неначисленными навсегда, ни один следующий
-- прогон их уже не увидит (v_period_start каждый раз пересчитывается
-- заново от «сейчас», без памяти о прошлых пропусках).
--
-- Стало: для каждой позиции проходим по ВСЕМ месяцам от начала
-- (effective_from) до последнего завершённого месяца включительно.
-- UNIQUE(position_id, period) + ON CONFLICT DO NOTHING делают это
-- дешёвым и идемпотентным — уже начисленные месяцы просто
-- пропускаются, довносятся только реально пропущенные.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_run_payroll_accrual() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_last_period date;   -- последний полностью завершённый месяц (IST)
  r fin_payroll_positions%ROWTYPE;
  v_cursor date;
  v_period_end date;
  v_days_in_month int;
  v_worked_start date;
  v_worked_end date;
  v_days_worked int;
  v_amount numeric;
BEGIN
  v_last_period := date_trunc('month', ((now() AT TIME ZONE 'Asia/Kolkata')::date - interval '1 month'))::date;

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
END;
$function$;
