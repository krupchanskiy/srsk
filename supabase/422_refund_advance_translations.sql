-- Переводы: кнопка и модалка возврата аванса
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_refund_advance_title', 'Возврат аванса', 'Refund of the advance', 'अग्रिम की वापसी'),
  ('fin_refund_advance_hint',
   'Вернуть переплату деньгами со счёта — например, когда участник отказался от поездки',
   'Return the overpayment in cash from an account — e.g. when the participant cancelled the trip',
   'खाते से अधिक भुगतान नकद लौटाएँ — जैसे जब प्रतिभागी ने यात्रा रद्द कर दी हो')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
