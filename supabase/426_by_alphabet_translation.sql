-- Перевод: вкладка «По алфавиту» в выборе блюда для меню
INSERT INTO translations (key, ru, en, hi) VALUES
  ('by_alphabet', 'По алфавиту', 'A–Z', 'वर्णक्रम')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
