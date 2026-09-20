-- =============================================================
-- Payroll: ручное начисление за месяц («Начислить за месяц»).
--
-- Не у всех сотрудников оклад фиксирован: сумму за месяц называет глава
-- департамента (Бридж Кишор, кафе), и вводит её казначей (ВГ, 20.09.2026).
-- Начисление — только признание долга в ведомости; в ДДС попадает лишь
-- выплата (fin_pay_payroll), поэтому здесь нет ни проводок, ни переводов.
--
-- days_worked/days_in_month нужны только автоначислению (пропорция по
-- дням) — для ручной записи они не имеют смысла и становятся необязательными.
-- Повторный ввод за тот же месяц правит сумму (ввели с ошибкой — поправили):
-- начисление это внутренняя запись, а не денежная проводка, сторно не нужно.
-- =============================================================

ALTER TABLE fin_payroll_accruals ALTER COLUMN days_worked DROP NOT NULL;
ALTER TABLE fin_payroll_accruals ALTER COLUMN days_in_month DROP NOT NULL;
ALTER TABLE fin_payroll_accruals ADD COLUMN is_manual boolean NOT NULL DEFAULT false;

CREATE OR REPLACE VIEW public.fin_v_payroll_accruals AS
SELECT a.id, a.position_id, a.period, a.amount, a.currency_code, a.days_worked, a.days_in_month, a.is_manual
FROM fin_payroll_accruals a
JOIN fin_payroll_positions p ON p.id = a.position_id
WHERE fin_is_admin();

CREATE OR REPLACE FUNCTION public.fin_set_payroll_accrual(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_pos fin_payroll_positions%ROWTYPE;
  v_period date;
  v_period_end date;
  v_amount numeric;
  v_this_month date;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['position_id', 'period', 'amount']);

  SELECT * INTO v_pos FROM fin_payroll_positions
    WHERE id = fin_private_get_uuid(payload, 'position_id', true) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Позиция не найдена';
  END IF;

  v_period     := date_trunc('month', fin_private_get_date(payload, 'period', true))::date;
  v_period_end := (v_period + interval '1 month' - interval '1 day')::date;
  v_amount     := fin_private_get_money(payload, 'amount', true);
  v_this_month := date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)::date;

  IF v_period > v_this_month THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Нельзя начислить за будущий месяц';
  END IF;
  -- позиция должна действовать хотя бы часть этого месяца — иначе долг
  -- повиснет на человеке, который тогда в департаменте не числился
  IF v_pos.effective_from > v_period_end
     OR (v_pos.effective_to IS NOT NULL AND v_pos.effective_to < v_period) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'В этом месяце позиция не действовала';
  END IF;

  INSERT INTO fin_payroll_accruals (position_id, period, amount, currency_code, is_manual)
  VALUES (v_pos.id, v_period, v_amount, v_pos.currency_code, true)
  ON CONFLICT (position_id, period)
  DO UPDATE SET amount = EXCLUDED.amount, is_manual = true, days_worked = NULL, days_in_month = NULL;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('position_id', v_pos.id, 'period', v_period));
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

REVOKE ALL ON FUNCTION public.fin_set_payroll_accrual(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_set_payroll_accrual(jsonb) TO authenticated;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_accrue', 'Начислить', 'Accrue', 'आबंटित करें', 'Финансы'),
  ('fin_payroll_accrue_title', 'Начислить за месяц', 'Accrue for a month', 'महीने के लिए आबंटन', 'Финансы'),
  ('fin_payroll_period', 'Месяц', 'Month', 'माह', 'Финансы'),
  ('fin_payroll_accrue_hint', 'Только фиксирует долг в ведомости — в ДДС попадёт при выплате. Повторный ввод за тот же месяц заменит сумму.', 'Only records the amount owed in the payroll — it reaches the cash flow when paid. Entering the same month again replaces the amount.', 'केवल वेतन में देय राशि दर्ज करता है — भुगतान पर नकदी प्रवाह में जाएगा। उसी महीने की दोबारा प्रविष्टि राशि बदल देगी।', 'Финансы'),
  ('fin_payroll_manual', 'вручную', 'manual', 'मैन्युअल', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
