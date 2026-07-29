-- Причина отказа: её видит автор заявки в своём чате

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_dismiss_reason_prompt',
   'Причина отказа (необязательно) — её увидит автор в чате',
   'Reason for rejection (optional) — the author will see it in the chat',
   'अस्वीकृति का कारण (वैकल्पिक) — लेखक इसे चैट में देखेगा', 'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
