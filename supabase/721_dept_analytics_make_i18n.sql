-- 721: «Изготовление «Мурти»» — себестоимость линии одной строкой у продавца (ВГ 19.10)
insert into translations (key, ru, en, hi, context) values
('dacc_an_make', 'Изготовление', 'Production of', 'निर्माण', 'Аналитика департамента: себестоимость линии')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
