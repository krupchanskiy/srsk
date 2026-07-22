INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_confirm_without_fin_rights',
   'У вас нет прав финмодуля. Платёж будет подтверждён в CRM, но НЕ попадёт в финансовый учёт — его придётся проводить вручную. Всё равно подтвердить?',
   'You do not have finance-module rights. The payment will be confirmed in CRM but will NOT reach the ledger — it will need manual posting. Confirm anyway?',
   'आपके पास वित्त मॉड्यूल के अधिकार नहीं हैं। भुगतान CRM में पुष्ट होगा, पर लेखा में दर्ज नहीं होगा — उसे हाथ से दर्ज करना पड़ेगा। फिर भी पुष्टि करें?')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
