-- 663d (в журнале базы — 663_person_booking_translations; 663, 663b, 663c заняты предоплатой): переводы окна «Бронирование: человек или семья» (js/group-booking.js, режим person; ВГ, 09.10.2026, «Шахматка 11», часть 4).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_person_title',       'Бронирование: человек или семья', 'Booking: person or family', 'बुकिंग: व्यक्ति या परिवार'),
    ('timeline_person_people',      'Кто едет',                      'Who is coming',                'कौन आ रहा है'),
    ('timeline_add_person',         'ещё человек',                   'another person',               'एक और व्यक्ति'),
    ('timeline_person_placeholder', 'Имя — из справочника или просто вписать', 'Name — from the directory or just type it', 'नाम — सूची से चुनें या लिखें'),
    ('timeline_person_pick_room',   'выберите номер',                'choose a room',                'कमरा चुनें'),
    ('timeline_person_room_small',  'свободных мест меньше, чем людей', 'fewer free beds than people', 'लोगों से कम खाली बिस्तर'),
    ('timeline_person_twice',       'Один и тот же человек выбран дважды', 'The same person is chosen twice', 'एक ही व्यक्ति दो बार चुना गया')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
