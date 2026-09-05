-- Перевод: строка «Итого по группе» в форме совместной оплаты
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_group_total', 'Итого по группе', 'Group total', 'समूह का कुल')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
