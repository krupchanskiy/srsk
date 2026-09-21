-- «Бывший» звучало как «уволена», а закрывается только период работы в
-- департаменте (Уша перешла с Кухни в Кафе и может вернуться) — ВГ, 21.09.2026
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_ended_on', 'период до', 'period until', 'अवधि तक', 'Финансы'),
  ('fin_payroll_show_ended', 'Показать завершённые периоды', 'Show ended periods', 'समाप्त अवधि दिखाएँ', 'Финансы')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
