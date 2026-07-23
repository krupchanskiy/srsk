-- Переводы: вкладка «Не разнеслись» во Входящих + сигналы на дашборде финмодуля
-- (наблюдаемость: неразнесённые платежи и нарушения целостности видны сразу).
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_tab_unposted', 'Не разнеслись', 'Not posted', 'दर्ज नहीं हुए'),
  ('fin_no_unposted', 'Все платежи разнесены в учёт', 'All payments posted to the ledger', 'सभी भुगतान लेखा में दर्ज हैं'),
  ('fin_open_deal', 'Открыть сделку', 'Open deal', 'सौदा खोलें'),
  ('fin_signal_unposted', 'платежей подтверждены в CRM, но не попали в учёт', 'payments confirmed in CRM but not in the ledger', 'भुगतान CRM में पुष्ट, पर लेखा में नहीं'),
  ('fin_signal_integrity', 'Нарушение целостности', 'Integrity issue', 'अखंडता समस्या')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
