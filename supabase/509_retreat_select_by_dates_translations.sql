-- Выбор ретрита у группы и в шахматке: только ретриты, идущие в эти даты, с датами в скобках
insert into translations (key, ru, en, hi, context) values
('retreat_dates_mismatch', 'Даты не пересекаются с датами выбранного ретрита', 'Dates do not overlap with the selected retreat', 'तिथियाँ चुने गए रिट्रीट की तिथियों से मेल नहीं खातीं', 'Группы / Шахматка'),
('group_event_dates_first', 'сначала укажите даты', 'enter dates first', 'पहले तिथियाँ दर्ज करें', 'Группы')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
