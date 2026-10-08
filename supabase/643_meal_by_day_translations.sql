-- 643: переводы окна «Разового питания» по дням (640) и общего выбора ретрита (ВГ, 08.10.2026).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'groups'
  from (values
    ('mge_meals',          'Питание',                       'Meals',                         'भोजन'),
    ('mge_mode_same',      'Одинаково каждый день',         'Same every day',                'हर दिन एक जैसा'),
    ('mge_mode_days',      'По дням',                       'By day',                        'दिन के अनुसार'),
    ('mge_fill_down',      'Пустые дни — как предыдущий',   'Empty days — copy previous',    'खाली दिन — पिछले जैसा'),
    ('mge_paste_hint',     'Можно вставить столбики из Google-таблицы: встаньте в клетку и Cmd+V',
                           'You can paste columns from a Google Sheet: click a cell and press Cmd+V',
                           'Google शीट से कॉलम चिपका सकते हैं: सेल पर क्लिक करें और Cmd+V दबाएँ'),
    ('mge_breakfasts',     'Завтраков',                     'Breakfasts',                    'नाश्ते'),
    ('mge_lunches',        'Обедов',                        'Lunches',                       'दोपहर के भोजन'),
    ('mge_days_hint',      '0 — в этот день приём не нужен. Кухня берёт числа из этой таблицы, примечание к дню видят повара.',
                           '0 — no meal that day. The kitchen uses these numbers; cooks see the day note.',
                           '0 — उस दिन भोजन नहीं। रसोई इन्हीं संख्याओं से गिनती करती है, दिन की टिप्पणी रसोइये देखते हैं।'),
    ('mge_retreat_start',  'начало ретрита',                'retreat starts',                'रिट्रीट शुरू'),
    ('mge_retreat_end',    'конец ретрита',                 'retreat ends',                  'रिट्रीट समाप्त'),
    ('mge_day_note',       'Примечание к дню (видят повара)', 'Day note (seen by cooks)',    'दिन की टिप्पणी (रसोइये देखते हैं)'),
    ('mge_day_note_ph',    'Например: 19 человек приедут позже — отложить порции',
                           'E.g.: 19 people will come later — set portions aside',
                           'उदाहरण: 19 लोग बाद में आएँगे — उनके लिए भोजन अलग रखें'),
    ('mge_days_empty',     'В таблице нет ни одного завтрака или обеда', 'The table has no breakfasts or lunches', 'तालिका में कोई नाश्ता या भोजन नहीं है'),
    ('mge_up_to',          'до',                            'up to',                         'अधिकतम'),
    ('retreat_select_upcoming', 'Предстоящие',              'Upcoming',                      'आगामी'),
    ('fill_required',      'Заполните обязательные поля',   'Fill in the required fields',   'आवश्यक फ़ील्ड भरें')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
