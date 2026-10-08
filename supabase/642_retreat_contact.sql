-- 642: контактное лицо группы и телеграм брони (ВГ, 08.10.2026).
-- У внешней группы есть человек, с которым держим связь (например, у группы Бхакти Чайтаньи
-- Свами — Махапрабху Крипа Прабху). Указываем его у ретрита один раз — бронь группы
-- подставляет имя, телефон и телеграм из его карточки.

alter table public.retreats add column if not exists contact_vaishnava_id uuid
    references public.vaishnavas(id) on delete set null;
alter table public.bookings add column if not exists contact_telegram text;

comment on column public.retreats.contact_vaishnava_id is 'Контактное лицо группы: подставляется в бронь (ВГ 08.10.2026)';
comment on column public.bookings.contact_telegram is 'Телеграм контактного лица брони';
