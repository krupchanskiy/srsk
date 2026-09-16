-- Переводы для поля «дата начала» и разбивки по месяцам в ведомости
-- (441_fin_payroll_correct_start_date.sql, 442_fin_payroll_period_detail.sql)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_effective_from', 'С', 'From', 'से', 'Финансы'),
  ('fin_payroll_backdate_hint', 'Можно указать прошлую дату, если заводите задним числом', 'You can pick a past date if entering this retroactively', 'यदि पूर्वव्यापी रूप से दर्ज कर रहे हैं तो पिछली तारीख चुन सकते हैं', 'Финансы'),
  ('fin_payroll_days', 'дн.', 'days', 'दिन', 'Финансы'),
  ('fin_payroll_no_accruals', 'Начислений ещё не было', 'No accruals yet', 'अभी तक कोई आबंटन नहीं', 'Финансы'),
  ('fin_payroll_no_payments', 'Выплат ещё не было', 'No payments yet', 'अभी तक कोई भुगतान नहीं', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
