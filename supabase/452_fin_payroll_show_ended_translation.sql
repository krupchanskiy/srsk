-- Переключатель «Показать завершённых» в зарплатной ведомости
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_show_ended', 'Показать завершённых', 'Show ended', 'समाप्त दिखाएँ', 'Финансы')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
