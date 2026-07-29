INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_totals_reversed', 'Сторнировано', 'Reversed', 'रद्द किया गया', 'ДДС'),
  ('fin_chat_waiting', 'Из чатов ждут', 'Waiting from chats', 'चैट से प्रतीक्षा', 'ДДС')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
