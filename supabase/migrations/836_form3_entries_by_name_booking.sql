-- Form III: анкета/выписка по брони «на имя» (residents.guest_name, без карточки).
-- Такая запись держится за строку проживания (resident_id), vaishnava_id пустой.
-- Решение ВГ 27.11.2026: брони «на имя» тоже попадают во вкладку «Выписка».
alter table form3_entries alter column vaishnava_id drop not null;
comment on column form3_entries.vaishnava_id is 'Карточка человека; пусто — бронь «на имя», запись держится за resident_id';
