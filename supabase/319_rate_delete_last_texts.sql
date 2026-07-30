-- Опорный курс: предупреждаем дважды и разными словами (правило ВГ, 30.07.2026):
-- кнопка удаления нужна только для ошибочно созданных курсов.

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_rate_delete_last',
   'ВНИМАНИЕ: это ОПОРНЫЙ курс {cur} — единственный общий курс этой валюты. Удаляйте его только если сам курс создан по ошибке. Продолжить?',
   'WARNING: this is the ANCHOR {cur} rate — the only shared rate for this currency. Delete it only if the rate itself was created by mistake. Continue?',
   'ध्यान दें: यह {cur} की मुख्य दर है — इस मुद्रा की एकमात्र सामान्य दर। केवल गलती से बनाई गई दर ही हटाएँ। जारी रखें?',
   'Справочники'),
  ('fin_rate_delete_last2',
   'Ещё раз: без общего курса {cur} приход и расход в этой валюте проводиться НЕ БУДУТ. Сразу после удаления заведите новый курс — форма откроется автоматически. Удалить?',
   'Once more: without a shared {cur} rate, income and expenses in this currency WILL NOT post. Create a new rate immediately — the form will open automatically. Delete?',
   'फिर से: {cur} की सामान्य दर के बिना इस मुद्रा में लेनदेन दर्ज नहीं होंगे। हटाने के तुरंत बाद नई दर बनाएँ। हटाएँ?',
   'Справочники'),
  ('fin_rate_create_now',
   'Курс {cur} удалён. Заведите новый курс сейчас — до этого операции в {cur} не проводятся.',
   'The {cur} rate is deleted. Create a new rate now — until then operations in {cur} will not post.',
   '{cur} दर हटा दी गई। अभी नई दर बनाएँ।', 'Справочники')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
