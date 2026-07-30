-- Переводы: один платёж за нескольких участников

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_split_others', 'Засчитать другим участникам', 'Credit to other participants',
   'अन्य प्रतिभागियों के खाते में', 'Финансы'),
  ('fin_split_add', 'Добавить', 'Add', 'जोड़ें', 'Финансы'),
  ('fin_split_payer_gets', 'Плательщику зачтётся:', 'Credited to the payer:',
   'भुगतानकर्ता के खाते में:', 'Финансы'),
  ('fin_split_over', 'Распределено больше, чем принесли — лишнее:',
   'Distributed more than was paid — excess:',
   'भुगतान से अधिक वितरित — अतिरिक्त:', 'Финансы'),
  ('fin_split_amount_required', 'У каждого участника в разбивке должна быть сумма больше нуля',
   'Every participant in the split needs an amount greater than zero',
   'विभाजन में प्रत्येक प्रतिभागी के लिए शून्य से अधिक राशि आवश्यक है', 'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
