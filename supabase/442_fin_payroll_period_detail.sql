-- =============================================================
-- Payroll: видимость по месяцам — за какой период что начислено
-- и когда что выплачено (замечание ВГ 16.09.2026: в ведомости видна
-- только общая сумма, непонятно, за какой период она набежала).
-- =============================================================

CREATE OR REPLACE VIEW public.fin_v_payroll_accruals AS
SELECT a.id, a.position_id, a.period, a.amount, a.currency_code, a.days_worked, a.days_in_month
FROM fin_payroll_accruals a
JOIN fin_payroll_positions p ON p.id = a.position_id
WHERE fin_is_admin();

CREATE OR REPLACE VIEW public.fin_v_payroll_payments AS
SELECT
  fpp.id,
  fpp.position_id,
  o.occurred_on,
  po.amount,
  po.currency_code,
  o.comment,
  o.is_reversed
FROM fin_payroll_payments fpp
JOIN fin_postings po ON po.id = fpp.posting_id
JOIN fin_operations o ON o.id = po.operation_id
WHERE fin_is_admin();

GRANT SELECT ON public.fin_v_payroll_accruals TO authenticated;
GRANT SELECT ON public.fin_v_payroll_payments TO authenticated;
