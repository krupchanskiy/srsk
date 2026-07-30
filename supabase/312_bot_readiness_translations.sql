-- Переводы: ответственный не будет узнан ботом (нет ника Telegram)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_dept_bot_blind', 'бот не узнает ответственного',
   'bot will not recognise the responsible person',
   'बॉट जिम्मेदार व्यक्ति को नहीं पहचानेगा', 'Справочники'),
  ('fin_dept_bot_blind_hint',
   'В профиле ответственного нет ника Telegram, поэтому на его сообщение в чате бот ответит «Не нахожу вас в системе». Впишите ник в профиль или попросите нажать «Привязать Telegram».',
   'The responsible person has no Telegram username in their profile, so the bot will answer "I cannot find you". Add the username to the profile or ask them to press "Link Telegram".',
   'जिम्मेदार व्यक्ति की प्रोफ़ाइल में Telegram उपनाम नहीं है — बॉट उसे नहीं पहचानेगा।', 'Справочники')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
