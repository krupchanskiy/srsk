-- Период колонок «Начислено/Выплачено» в ведомости (год / месяц / всё время)
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_range_year', 'Этот год', 'This year', 'यह वर्ष', 'Финансы'),
  ('fin_payroll_range_month', 'Этот месяц', 'This month', 'यह महीना', 'Финансы'),
  ('fin_payroll_range_all', 'За всё время', 'All time', 'पूरे समय', 'Финансы'),
  ('fin_payroll_range_all_short', 'всё время', 'all time', 'पूरा समय', 'Финансы')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
