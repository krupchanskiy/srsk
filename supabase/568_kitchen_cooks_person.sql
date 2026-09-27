-- Повар в справочнике — всегда человек из базы (решение ВГ 27.09.2026)
alter table public.kitchen_cooks alter column vaishnava_id set not null;
insert into translations (key, ru, en, hi, context) values
('cook_create', 'Нет в базе — завести', 'Not in the database — add', 'डेटाबेस में नहीं — जोड़ें', 'Справочник поваров'),
('cook_create_confirm', 'Завести в базу нового человека', 'Add a new person to the database', 'डेटाबेस में नया व्यक्ति जोड़ें', 'Справочник поваров'),
('cook_pick_person', 'Выберите человека из базы или заведите нового', 'Pick a person from the database or add a new one', 'डेटाबेस से व्यक्ति चुनें या नया जोड़ें', 'Справочник поваров')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
