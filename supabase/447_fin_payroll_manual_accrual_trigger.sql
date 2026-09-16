-- =============================================================
-- Payroll: кнопка «Начислить сейчас» в самой ведомости.
--
-- fin_run_payroll_accrual() вызывается только cron'ом (1-го числа) и
-- REVOKE'd от authenticated. При заведении нового сотрудника посреди
-- месяца администратор до сих пор был вынужден просить прогнать её
-- отдельно, вручную через базу. Тонкая обёртка с проверкой прав —
-- чтобы это можно было сделать самому, кнопкой (ВГ, 16.09.2026).
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_trigger_payroll_accrual() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_run_payroll_accrual();
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

REVOKE ALL ON FUNCTION public.fin_trigger_payroll_accrual() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_trigger_payroll_accrual() TO authenticated;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_run_accrual', 'Начислить сейчас', 'Run accrual now', 'अभी आबंटित करें', 'Финансы'),
  ('fin_payroll_accrual_done', 'Начисление обновлено', 'Accrual updated', 'आबंटन अपडेट हो गया', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
