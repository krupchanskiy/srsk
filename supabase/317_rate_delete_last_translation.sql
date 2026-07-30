-- Перевод: удаляют последний общий курс валюты

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_rate_delete_last',
   'Это последний общий курс {cur}. Если удалить, приход и расход в {cur} перестанут проводиться, пока не заведёте новый курс. Всё равно удалить?',
   'This is the last shared {cur} rate. Delete it and operations in {cur} will stop posting until a new rate is added. Delete anyway?',
   'यह {cur} की अंतिम सामान्य दर है। हटाने पर {cur} में लेनदेन दर्ज नहीं होंगे। फिर भी हटाएँ?',
   'Справочники')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
