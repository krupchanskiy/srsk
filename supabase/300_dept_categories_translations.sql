INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_dept_categories', 'Статьи расходов департамента', 'Department expense categories',
   'विभाग की व्यय श्रेणियाँ', 'Справочники'),
  ('fin_dept_categories_hint',
   'Ничего не отмечено — бот покажет общий набор. Отмеченное полностью заменяет общий набор для этого департамента.',
   'Nothing checked means the bot shows the shared set. A checked set fully replaces the shared one for this department.',
   'कुछ भी चयनित नहीं — बॉट सामान्य सूची दिखाएगा। चयनित सूची इस विभाग के लिए सामान्य सूची को पूरी तरह बदल देती है।',
   'Справочники'),
  ('fin_rate_history_note',
   'Прошлые операции не изменятся: каждая проводка хранит курс, снятый в момент проведения.',
   'Past operations are unaffected: every posting stores the rate captured when it was made.',
   'पुराने लेनदेन नहीं बदलेंगे: प्रत्येक प्रविष्टि अपनी दर स्वयं रखती है।', 'Справочники'),
  ('fin_rate_delete_confirm', 'Удалить курс? Проведённые операции не изменятся.',
   'Delete this rate? Posted operations will not change.',
   'दर हटाएँ? दर्ज लेनदेन नहीं बदलेंगे।', 'Справочники')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
