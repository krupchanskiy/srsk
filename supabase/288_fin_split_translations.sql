INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_split', 'Статьи', 'Categories', 'श्रेणियाँ', 'Входящие'),
  ('fin_split_title', 'Статьи расхода', 'Expense categories', 'व्यय श्रेणियाँ', 'Входящие'),
  ('fin_split_add', '+ Ещё строка', '+ Another line', '+ एक और पंक्ति', 'Входящие'),
  ('fin_split_left', 'Осталось разнести', 'Left to allocate', 'बाँटना बाकी', 'Входящие'),
  ('fin_split_ok', 'Сумма сходится', 'Amounts match', 'राशि मेल खाती है', 'Входящие')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
