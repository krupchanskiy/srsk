-- 657: переводы окна «Регистрация группы» (js/group-booking.js) и выбора
-- «Человек или семья / Группа» у «Забронировать» (ВГ, 08.10.2026, «Шахматка 11»).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_booking_person',   'Человек или семья',            'Person or family',             'व्यक्ति या परिवार'),
    ('timeline_booking_group',    'Группа',                       'Group',                        'समूह'),
    ('timeline_group_title',      'Регистрация группы',           'Group registration',           'समूह पंजीकरण'),
    ('timeline_group_edit',       'Групповая бронь: номера и места', 'Group booking: rooms and beds', 'समूह बुकिंग: कमरे और बिस्तर'),
    ('timeline_group_rooms_btn',  'Номера группы',                'Group rooms',                  'समूह के कमरे'),
    ('booking_rooms_seats',       'Номера и места',               'Rooms and beds',               'कमरे और बिस्तर'),
    ('timeline_group_name',       'Название группы',              'Group name',                   'समूह का नाम'),
    ('timeline_group_people',     'Людей',                        'People',                       'लोग'),
    ('timeline_group_seats',      'Мест',                         'Beds',                         'बिस्तर'),
    ('timeline_group_rooms',      'Номера',                       'Rooms',                        'कमरे'),
    ('timeline_group_in_rooms',   'в номерах',                    'in rooms',                     'कमरों में'),
    ('timeline_group_self_short', 'без номера',                   'without room',                 'बिना कमरे'),
    ('timeline_group_short',      'не хватает мест',              'beds missing',                 'बिस्तर कम हैं'),
    ('timeline_group_extra',      'мест больше, чем людей',       'more beds than people',        'लोगों से अधिक बिस्तर'),
    ('timeline_group_match',      'сходится',                     'matches',                      'मेल खाता है'),
    ('timeline_group_name_required', 'Выберите ретрит или впишите название группы',
                                  'Choose a retreat or enter the group name',
                                  'रिट्रीट चुनें या समूह का नाम लिखें'),
    ('timeline_group_no_seats',   'Выберите номера или места без номера',
                                  'Choose rooms or beds without a room',
                                  'कमरे या बिना कमरे वाले स्थान चुनें'),
    ('timeline_group_named_left', 'В номере остались места с именами — уберите их в шахматке',
                                  'Some beds in the room have names — remove them in the timeline',
                                  'कमरे में नाम वाले बिस्तर हैं — उन्हें टाइमलाइन में हटाएँ'),
    ('timeline_dates_required',   'Укажите заезд и выезд',        'Enter check-in and check-out', 'आगमन और प्रस्थान की तिथि दें'),
    ('timeline_free_beds',        'свободно мест',                'free beds',                    'खाली बिस्तर'),
    ('timeline_room_free',        'свободен',                     'free',                         'खाली'),
    ('timeline_room_adjacent',    'в стык',                       'back-to-back',                 'लगातार'),
    ('timeline_room_partial',     'занят частично',               'partly taken',                 'आंशिक रूप से भरा'),
    ('timeline_room_busy_of',     'занято',                       'taken',                        'भरे'),
    ('timeline_room_overlap',     'нахлёст — нельзя',             'overlap — not allowed',        'ओवरलैप — अनुमति नहीं'),
    ('timeline_room_named',       'с именами',                    'named',                        'नाम सहित'),
    ('timeline_prasad',           'Прасад',                       'Prasad',                       'प्रसाद'),
    ('timeline_self_stay',        'Самостоятельное проживание',   'Staying on their own',         'स्वयं का आवास')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
