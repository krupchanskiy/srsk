-- Переводы: явный выбор счёта при подтверждении платежа и обязательный
-- способ оплаты (решения ВГ по вопросам 1, 3, 4 от 23.07.2026).
INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_pick_account', 'На какой счёт поступили деньги?', 'Which account received the money?', 'पैसा किस खाते में आया?'),
  ('crm_pick_account_hint', 'Приход отмечается только на том счёте, где деньги фактически лежат.', 'Record income only on the account where the money actually sits.', 'आय केवल उसी खाते में दर्ज करें जहाँ पैसा वास्तव में है।'),
  ('crm_no_accounts_for_currency', 'Нет активного счёта в этой валюте — создайте его в финмодуле', 'No active account in this currency — create one in the finance module', 'इस मुद्रा में कोई सक्रिय खाता नहीं — वित्त मॉड्यूल में बनाएँ'),
  ('crm_choose_payment_system', '— выберите способ оплаты —', '— choose payment method —', '— भुगतान विधि चुनें —'),
  ('crm_confirm_requires_payment_system', 'У платежа не указан способ оплаты — заполните его в карточке сделки', 'The payment has no payment method — set it in the deal card', 'भुगतान की विधि नहीं बताई गई — सौदे के कार्ड में भरें')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
