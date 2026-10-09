-- 658: переводы «Вставить список» в окне «Регистрация группы» (ВГ, 09.10.2026, «Шахматка 11», часть 3).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_group_paste_list',   'Вставить список',              'Paste a list',                 'सूची चिपकाएँ'),
    ('timeline_list_any_room',      '— любое отмеченное место —',   '— any selected bed —',         '— कोई भी चुना हुआ बिस्तर —'),
    ('timeline_list_apply',         'Расставить по номерам',        'Place into rooms',             'कमरों में रखें'),
    ('timeline_list_back_to',       'К списку',                     'Back to list',                 'सूची पर लौटें'),
    ('timeline_list_check',         'проверьте похожих',            'check similar names',          'मिलते-जुलते नाम जाँचें'),
    ('timeline_list_clear',         'Убрать список',                'Remove list',                  'सूची हटाएँ'),
    ('timeline_list_col',           'Столбец',                      'Column',                       'कॉलम'),
    ('timeline_list_columns',       'Что в каком столбце',          'What is in each column',       'किस कॉलम में क्या है'),
    ('timeline_list_companion',     'спутник без имени',            'companion without a name',     'बिना नाम का साथी'),
    ('timeline_list_found',         'есть в базе',                  'in the database',              'डेटाबेस में है'),
    ('timeline_list_hint',          'Выделите в Excel или Google-таблице строки вместе с заголовком, скопируйте и вставьте сюда (Cmd+V). Какой столбец что значит — выберете ниже.',
                                    'Select rows with the header in Excel or Google Sheets, copy and paste here (Cmd+V). You will choose what each column means below.',
                                    'Excel या Google शीट में शीर्षक सहित पंक्तियाँ चुनें, कॉपी करें और यहाँ चिपकाएँ (Cmd+V)। हर कॉलम का अर्थ नीचे चुनें।'),
    ('timeline_list_in_base',       'В базе',                       'In database',                  'डेटाबेस में'),
    ('timeline_list_manual',        'разберите вручную',            'sort out manually',            'हाथ से देखें'),
    ('timeline_list_name',          'Имя',                          'Name',                         'नाम'),
    ('timeline_list_need_name',     'Выберите столбец с именами',   'Choose the column with names', 'नामों वाला कॉलम चुनें'),
    ('timeline_list_new',           'новый',                        'new',                          'नया'),
    ('timeline_list_no_room',       'нет номера — отметьте номера или укажите номер в списке',
                                    'no room — select rooms or put the room number in the list',
                                    'कमरा नहीं — कमरे चुनें या सूची में कमरा नंबर दें'),
    ('timeline_list_other',         'другой человек — имя без карточки', 'another person — name without a card', 'दूसरा व्यक्ति — बिना कार्ड का नाम'),
    ('timeline_list_placed',        'Из списка расставлено',        'Placed from the list',         'सूची से रखे गए'),
    ('timeline_list_room_full',     'людей больше, чем мест (замена посреди срока?) — разберите вручную',
                                    'more people than beds (a swap mid-stay?) — sort out manually',
                                    'बिस्तरों से अधिक लोग (बीच में बदलाव?) — हाथ से देखें'),
    ('timeline_list_room_not_found', 'не найден',                   'not found',                    'नहीं मिला'),
    ('timeline_list_row',           'Строка',                       'Row',                          'पंक्ति'),
    ('timeline_list_same',          'тот же?',                      'same person?',                 'वही व्यक्ति?'),
    ('timeline_list_twice',         'дважды в списке',              'twice in the list',            'सूची में दो बार')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
