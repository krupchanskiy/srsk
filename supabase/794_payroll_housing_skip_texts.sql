-- 794. Подписи: «не начислять» жильё за месяц и «за какой месяц» (793)
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_housing_skip', 'не начислять', 'skip', 'न जोड़ें'),
  ('fin_payroll_housing_skip_hint', 'Не начислять жильё за этот месяц (уехал, оплачено вперёд…)', 'Do not accrue housing for this month (left, prepaid…)', 'इस महीने आवास न जोड़ें (चले गए, अग्रिम भुगतान…)'),
  ('fin_payroll_housing_skip_reason', 'Почему жильё за этот месяц не начисляем? (например: уехал, оплачено вперёд)', 'Why is housing not accrued for this month? (e.g. left, prepaid)', 'इस महीने आवास क्यों नहीं जोड़ा? (जैसे: चले गए, अग्रिम भुगतान)'),
  ('fin_payroll_housing_skipped', 'не начислено', 'not accrued', 'नहीं जोड़ा'),
  ('fin_payroll_housing_unskip', 'вернуть', 'restore', 'वापस करें'),
  ('fin_payroll_for_month', 'за', 'for', 'के लिए'),
  ('fin_payroll_for_month_label', 'За какой месяц', 'For which month', 'किस महीने के लिए')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
