-- Кнопка «Вернуть» у завершённого периода в списке сотрудников департамента
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_return', 'Вернуть', 'Return', 'वापस लाएँ', 'Финансы')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
