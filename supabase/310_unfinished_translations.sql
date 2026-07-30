-- Переводы: вкладка «Ждут ответа» (незавершённые заявки из чатов)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_tab_unfinished', 'Ждут ответа', 'Awaiting reply', 'उत्तर की प्रतीक्षा', 'Финансы'),
  ('fin_no_unfinished', 'Все заявки из чатов доведены до конца',
   'Every chat request has been completed', 'सभी चैट अनुरोध पूर्ण हैं', 'Финансы'),
  ('fin_unfinished_days', 'висит дней', 'days waiting', 'दिन प्रतीक्षा', 'Финансы'),
  ('fin_unfinished_kind', 'не сказали: расход или передача', 'kind not chosen',
   'प्रकार नहीं चुना', 'Финансы'),
  ('fin_unfinished_target', 'не выбрали, кому передают', 'recipient not chosen',
   'प्राप्तकर्ता नहीं चुना', 'Финансы'),
  ('fin_unfinished_currency', 'не выбрали валюту', 'currency not chosen',
   'मुद्रा नहीं चुनी', 'Финансы'),
  ('fin_unfinished_category', 'не выбрали статью', 'category not chosen',
   'श्रेणी नहीं चुनी', 'Финансы'),
  ('fin_unfinished_confirm', 'не нажали «Записать»', 'not confirmed',
   'पुष्टि नहीं की', 'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
