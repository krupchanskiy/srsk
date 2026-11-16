-- 786: Form III (FRRO) — документы иностранцев и анкеты по заездам
-- Решения ВГ 16.11:
--   • номера паспорта и визы видят только суперпользователи → отдельная таблица vaishnava_documents;
--   • иностранец = нет индийского паспорта (citizenship <> 'IND'); гражданство — отдельное поле, «Страна» не трогаем;
--   • имя латиницей из паспорта хранится отдельно, имя в карточке не меняется;
--   • переезд в другую комнату без перерыва = один заезд;
--   • цель визита: виза tourist → Tourism, иначе спрашивать поименно.

-- 1. Гражданство — в карточке (не секретно, нужно для списка «Подать»)
alter table public.vaishnavas
    add column if not exists citizenship text;   -- код ISO3 из паспорта: RUS, UKR, IND
-- visa_type (tourist/business/…) и visa_expiry остаются в vaishnavas как есть

-- 2. Документы — только суперпользователи
create table if not exists public.vaishnava_documents (
    vaishnava_id        uuid primary key references public.vaishnavas(id) on delete cascade,
    passport_number     text,
    passport_surname    text,   -- латиницей как в паспорте (GRIGOREV)
    passport_given_name text,   -- латиницей как в паспорте (ALEKSEI)
    passport_expiry     date,
    visa_number         text,   -- номер визы / ETA / OCI
    portal_visa_type    text,   -- как на портале FRRO: e-VISA, OCI, …
    portal_visa_subtype text,   -- как на портале FRRO: e-TV, …
    updated_at          timestamptz not null default now(),
    updated_by          uuid references public.vaishnavas(id)
);

alter table public.vaishnava_documents enable row level security;

create policy vaishnava_documents_superuser_all on public.vaishnava_documents
    for all to authenticated
    using (public.is_superuser(auth.uid()))
    with check (public.is_superuser(auth.uid()));

-- 3. Анкета Form III по заезду
create table if not exists public.form3_entries (
    id                 uuid primary key default gen_random_uuid(),
    vaishnava_id       uuid not null references public.vaishnavas(id),
    resident_id        uuid references public.residents(id) on delete set null, -- первая строка заезда
    arrival_date       date,          -- фактический заезд (из шахматки)
    arrival_time       time,          -- время заезда; пусто → спросить
    expected_checkout  date,
    arrived_from       text,          -- откуда прибыл
    previous_place     text,          -- где жил до этого
    purpose            text,          -- цель визита, как в списке портала (Tourism и т.д.)
    form3_id           text unique,   -- номер анкеты на портале (161126HACGQH)
    submitted_at       timestamptz,
    submitted_by       uuid references public.vaishnavas(id),
    -- выписка (сессия «Form III Checkout»)
    next_destination   text,          -- куда едет после ШРСК
    checkout_at        timestamp,     -- дата+время выезда для портала, без таймзоны (местное время)
    checkout_marked_at timestamptz,
    checkout_marked_by uuid references public.vaishnavas(id),
    notes              text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now()
);

create index if not exists form3_entries_vaishnava_idx on public.form3_entries(vaishnava_id);
create index if not exists form3_entries_resident_idx on public.form3_entries(resident_id);

alter table public.form3_entries enable row level security;

create policy form3_entries_superuser_all on public.form3_entries
    for all to authenticated
    using (public.is_superuser(auth.uid()))
    with check (public.is_superuser(auth.uid()));
