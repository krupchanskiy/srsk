-- Шахматка: подблоки под разделителем «Самостоятельное проживание» — коротко «Гости» / «Команда»
insert into translations (key, ru, en, hi, context) values
('timeline_self_short_guests', 'Гости', 'Guests', 'अतिथि', 'Шахматка'),
('timeline_self_short_team', 'Команда', 'Team', 'टीम', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
