-- Шахматка: новые ключи подблоков «Гости» / «Команда» (старые *_short_* застряли в кэше браузеров со значением «Вне ШРСК»)
insert into translations (key, ru, en, hi, context) values
('timeline_self_sub_guests', 'Гости', 'Guests', 'अतिथि', 'Шахматка'),
('timeline_self_sub_team', 'Команда', 'Team', 'टीम', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
