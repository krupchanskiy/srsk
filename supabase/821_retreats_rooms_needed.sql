-- 821: сколько номеров Гостевого дома нужно ретриту, если он занимает не весь ГД (ВГ 20.11.2026)
-- «Два плюс один» — двухместные; трёхместных нет. Видно в карточке ретрита и в «Расписании».
alter table public.retreats
    add column rooms_2_needed int check (rooms_2_needed >= 0),
    add column rooms_4_needed int check (rooms_4_needed >= 0);

insert into translations (key, ru, en, hi, context) values
('retreats_rooms_needed', 'Сколько номеров Гостевого дома нужно', 'Guest house rooms needed', 'अतिथि गृह के कितने कमरे चाहिए', 'Ретриты')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
