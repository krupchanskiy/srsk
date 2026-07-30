-- Переводы: перераспределение платежа между участниками

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_realloc_action', 'Перераспределить', 'Reallocate', 'पुनर्वितरण', 'Финансы'),
  ('fin_realloc_title', 'Перераспределить платёж', 'Reallocate payment',
   'भुगतान का पुनर्वितरण', 'Финансы'),
  ('fin_realloc_rows', 'Кому засчитать', 'Credit to', 'किसके खाते में', 'Финансы'),
  ('fin_realloc_hint',
   'Деньги на счёте не двигаются — меняется только то, чей долг закрыт. Сумма строк должна совпасть с суммой платежа.',
   'The account balance does not change — only whose debt is settled. The rows must add up to the payment amount.',
   'खाते की राशि नहीं बदलती — केवल यह बदलता है कि किसका ऋण चुकाया गया। पंक्तियों का योग भुगतान राशि के बराबर होना चाहिए।',
   'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
