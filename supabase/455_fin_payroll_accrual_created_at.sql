-- «Начислено за этот месяц» в ведомости = что начислили В ЭТОМ месяце (как и
-- «Выплачено» — что выплатили в этом месяце), а не за какой месяц работы.
-- Иначе 1 октября начисление за сентябрь пряталось бы в сентябре, которого
-- в выборе «этот месяц» уже нет (ВГ, 21.09.2026). Для этого view отдаёт
-- дату начисления.
CREATE OR REPLACE VIEW public.fin_v_payroll_accruals AS
SELECT a.id, a.position_id, a.period, a.amount, a.currency_code, a.days_worked, a.days_in_month, a.is_manual, a.created_at
FROM fin_payroll_accruals a
JOIN fin_payroll_positions p ON p.id = a.position_id
WHERE fin_is_admin();
