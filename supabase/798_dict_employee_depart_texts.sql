-- 798. Справочник департаментов: «Уехал» / «Вернулся» у сотрудника, как в ведомости (796)
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_payroll_left_badge', 'уехал', 'left', 'चले गए')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
