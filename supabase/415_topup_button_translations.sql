-- Переводы: кнопка «Подтянуть остаток» для сигнала о неполной загрузке аванса
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_resolve_topup', 'Подтянуть остаток', 'Top up the balance', 'शेष राशि पूरी करें'),
  ('fin_resolve_topup_confirm',
   '{0}: добрать {1} к начальному остатку? Платёж датирован до запуска, но подтверждён уже после загрузки остатков, поэтому в аванс не попал. Движения денег не будет — только строка остатка.',
   '{0}: add {1} to the opening balance? The payment is dated before the launch but was confirmed after the balances were loaded, so it never made it into the advance. No money moves — only the balance row.',
   '{0}: प्रारंभिक शेष में {1} जोड़ें? भुगतान लॉन्च से पहले का है पर शेष लोड होने के बाद पुष्ट हुआ, इसलिए अग्रिम में नहीं गया। पैसे की कोई गति नहीं — केवल शेष की पंक्ति।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
