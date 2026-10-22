-- 729: рейсы гостя из «Вставить список» (ВГ, 22.10.2026). Как в таблице организатора: «30/10 08:20 SU233».
-- По рейсу считаются дата и «Ожидается в ~ / Уезжает в ~»: приезд +4 ч после посадки, отъезд за 7 ч до вылета.
alter table residents add column if not exists arrival_flight text;
alter table residents add column if not exists departure_flight text;
comment on column residents.arrival_flight is 'Рейс прилёта как в списке организатора; время в ашраме — arrival_time';
comment on column residents.departure_flight is 'Рейс вылета как в списке организатора; время отъезда из ашрама — departure_time';

insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_list_arrival',   'Приезд',                            'Arrival',                               'आगमन'),
    ('timeline_list_departure', 'Отъезд',                            'Departure',                             'प्रस्थान'),
    ('timeline_list_own',       'у каждого своё — из списка',        'each their own — from the list',        'हर किसी का अपना — सूची से'),
    ('timeline_list_together',  'все вместе — даты и время группы',  'all together — group dates and time',   'सब साथ — समूह की तिथियाँ और समय'),
    ('timeline_list_as_group',  'как у группы',                      'as the group',                          'समूह जैसा'),
    ('timeline_list_flight',    'рейс',                              'flight',                                'उड़ान'),
    ('timeline_arrival_flight', 'Рейс прилёта',                      'Arrival flight',                        'आगमन उड़ान'),
    ('timeline_departure_flight','Рейс вылета',                      'Departure flight',                      'प्रस्थान उड़ान')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);

update translations set
 ru = 'Под полем появятся карточки столбцов. У каждой выберите, что в ней: Имя, Здание / гостиница, Номер комнаты, Заезд, Выезд, Рейс прилёта, Рейс вылета, Дни, Сколько человек, Телефон, Почта, Телеграм. Ненужные столбцы — «— не брать —». Если в таблице рейсы, а не заезд/выезд, — выберите «Рейс»: приезд посчитается +4 ч после посадки, отъезд — за 7 ч до вылета. Ниже выберите, приезжают и уезжают все вместе или у каждого своё.',
 en = 'Column cards will appear below the field. For each, choose what it contains: Name, Building / hotel, Room number, Check-in, Check-out, Arrival flight, Departure flight, Days, How many people, Phone, Email, Telegram. For unneeded columns choose «— skip —». If the table has flights rather than check-in/out, choose «Flight»: arrival is 4 h after landing, departure 7 h before take-off. Below, choose whether everyone arrives and leaves together or each on their own.',
 hi = 'फ़ील्ड के नीचे कॉलम कार्ड दिखेंगे। हर कार्ड में चुनें कि उसमें क्या है: नाम, भवन / होटल, कमरा नंबर, आगमन, प्रस्थान, आगमन उड़ान, प्रस्थान उड़ान, दिन, कितने लोग, फ़ोन, ईमेल, टेलीग्राम। अनावश्यक कॉलम के लिए «— न लें —» चुनें। यदि तालिका में उड़ानें हैं — «उड़ान» चुनें: आगमन उतरने के 4 घंटे बाद, प्रस्थान उड़ान से 7 घंटे पहले। नीचे चुनें कि सब साथ आते-जाते हैं या हर कोई अलग।'
where key = 'timeline_list_step4';
