-- Этап 3: переводы UI подтверждения наличных и итога автопроводки
INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_pick_cash_account', 'В какую кассу приняты наличные?', 'Which cash box received the money?', 'नक़दी किस कैश-बॉक्स में ली गई?'),
  ('crm_confirm', 'Подтвердить', 'Confirm', 'पुष्टि करें'),
  ('crm_cash_no_accounts', 'Нет активной кассы в этой валюте — создайте счёт в финмодуле', 'No active cash box in this currency — create an account in the finance module', 'इस मुद्रा में कोई सक्रिय कैश-बॉक्स नहीं — वित्त मॉड्यूल में खाता बनाएँ'),
  ('crm_autopost_ok', 'Платёж проведён в финмодуль', 'Payment posted to the finance module', 'भुगतान वित्त मॉड्यूल में दर्ज हुआ'),
  ('crm_autopost_error', 'Платёж подтверждён, но НЕ проведён в финмодуль', 'Payment confirmed but NOT posted to the finance module', 'भुगतान की पुष्टि हुई, पर वित्त मॉड्यूल में दर्ज नहीं हुआ')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
