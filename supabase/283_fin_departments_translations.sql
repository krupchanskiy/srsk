INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_dict_departments', 'Департаменты', 'Departments', 'विभाग', 'Справочники'),
  ('fin_dept_chat', 'Чат департамента', 'Department chat', 'विभाग चैट', 'Справочники'),
  ('fin_dept_no_chat', 'Чат не привязан', 'No chat linked', 'चैट नहीं जुड़ा', 'Справочники'),
  ('fin_dept_on_hand', 'На руках', 'On hand', 'हाथ में', 'Справочники'),
  ('fin_dept_chat_busy', 'сейчас у', 'now with', 'अभी है', 'Справочники'),
  ('fin_dept_hint',
   'Подотчётный счёт создастся сам при первой выдаче. Чат появится в списке после того, как бота добавят в него.',
   'The custodial account is created automatically on the first payout. A chat appears in the list once the bot is added to it.',
   'पहली निकासी पर अभिरक्षा खाता स्वतः बन जाएगा। बॉट जोड़ने के बाद चैट सूची में दिखेगा।',
   'Справочники')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
