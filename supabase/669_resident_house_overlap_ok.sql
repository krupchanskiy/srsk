-- Плашка в шахматке «Пересечение с ретритом» (ВГ 09.10.2026): брони в Гостевом доме не из ретрита
-- на ночи ретрита «весь Гостевой дом» (668) висят сверху до решения — перенести даты
-- или «Оставить как есть». true — решено осознанно, в плашке не показывать.

alter table residents add column if not exists house_overlap_ok boolean not null default false;

comment on column residents.house_overlap_ok is
    'Пересечение с ретритом «весь Гостевой дом» оставлено осознанно — плашка шахматки его не показывает';

-- Ананда Вардхана Свами, №30, VIP: на ретриты идут 29 номеров — осознанно (ВГ 09.10)
update residents set house_overlap_ok = true where id = '81c2acf4-d805-4160-95ff-b90df9fd38f1';
