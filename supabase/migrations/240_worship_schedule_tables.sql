-- Этап 2, блок 2.1: службы, люди отдела, назначения, отклонения дня.
--
-- Устройство, которое стоит понять до чтения схемы:
--   * службы одни и те же каждый день, меняются люди. Поэтому расписание —
--     это назначения на дату, а не «расписание недели» как объект;
--   * праздник — точечное отклонение дня: отмена обычной службы или разовая
--     со своим временем. Второго расписания не заводим;
--   * человек отдела — ссылка на карточку вайшнава, а не вторая карточка.
--     У временного стоит срок участия, после которого он уходит из выбора;
--   * заметки о людях лежат отдельной таблицей: защита в Postgres строчная,
--     и поле «заметка» уехало бы вместе со строкой любому, кто запросил людей.

-- ── службы ────────────────────────────────────────────────────────────────────
create table if not exists worship_services (
    id          uuid primary key default gen_random_uuid(),
    name_ru     text not null,
    name_en     text,
    name_hi     text,
    time_of_day time not null,
    sort_order  integer not null default 0,
    article_id  uuid references worship_articles(id) on delete set null,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    created_by  uuid,
    updated_at  timestamptz not null default now(),
    updated_by  uuid
);

create index if not exists worship_services_order on worship_services (sort_order, time_of_day);

-- ── люди отдела ───────────────────────────────────────────────────────────────
create table if not exists worship_people (
    id           uuid primary key default gen_random_uuid(),
    vaishnava_id uuid not null unique references vaishnavas(id) on delete cascade,
    -- срок участия: у волонтёра он есть, у постоянного пуджари обычно пуст
    active_from  date,
    active_to    date,
    is_active    boolean not null default true,
    created_at   timestamptz not null default now(),
    created_by   uuid,
    updated_at   timestamptz not null default now(),
    updated_by   uuid,
    constraint worship_people_dates check (active_to is null or active_from is null or active_to >= active_from)
);

-- ── допуск к службам: предупреждение интерфейса, не запрет базы ───────────────
create table if not exists worship_person_services (
    person_id  uuid not null references worship_people(id) on delete cascade,
    service_id uuid not null references worship_services(id) on delete cascade,
    primary key (person_id, service_id)
);

-- ── заметки о людях: только для носителей права утверждения ───────────────────
create table if not exists worship_person_notes (
    id         uuid primary key default gen_random_uuid(),
    person_id  uuid not null references worship_people(id) on delete cascade,
    body       text not null,
    created_at timestamptz not null default now(),
    created_by uuid
);

create index if not exists worship_person_notes_person on worship_person_notes (person_id, created_at desc);

-- ── недоступность ─────────────────────────────────────────────────────────────
create table if not exists worship_absences (
    id         uuid primary key default gen_random_uuid(),
    person_id  uuid not null references worship_people(id) on delete cascade,
    date_from  date not null,
    -- пусто — «пока не сниму»: человек отметился в четыре утра и ушёл лечиться
    date_to    date,
    reason     text,
    created_at timestamptz not null default now(),
    created_by uuid,
    constraint worship_absences_dates check (date_to is null or date_to >= date_from),
    -- пересечения у одного человека запрещены: две отметки на одни дни
    -- превращают «он в отъезде?» в гадание
    constraint worship_absences_overlap exclude using gist (
        person_id with =,
        daterange(date_from, coalesce(date_to, 'infinity'::date), '[]') with &&)
);

-- ── отклонения дня ────────────────────────────────────────────────────────────
create table if not exists worship_day_overrides (
    id          uuid primary key default gen_random_uuid(),
    duty_date   date not null,
    -- либо отмена обычной службы, либо разовая служба со своим временем
    service_id  uuid references worship_services(id) on delete cascade,
    title       text,
    time_of_day time,
    reason      text,
    created_at  timestamptz not null default now(),
    created_by  uuid,
    constraint worship_day_overrides_kind check (
        (service_id is not null and title is null and time_of_day is null)
        or (service_id is null and title is not null and time_of_day is not null))
);

create unique index if not exists worship_day_overrides_cancel
    on worship_day_overrides (duty_date, service_id) where service_id is not null;
create index if not exists worship_day_overrides_date on worship_day_overrides (duty_date);

-- ── назначения ────────────────────────────────────────────────────────────────
create table if not exists worship_duties (
    id          uuid primary key default gen_random_uuid(),
    duty_date   date not null,
    -- обычная служба либо разовая служба этого дня: ровно одно из двух
    service_id  uuid references worship_services(id) on delete cascade,
    override_id uuid references worship_day_overrides(id) on delete cascade,
    person_id   uuid not null references worship_people(id) on delete cascade,
    -- на службу ставят двоих: пуджари и киртания, у каждого своя роль
    role        text not null default 'pujari' check (role in ('pujari', 'kirtan', 'helper')),
    created_at  timestamptz not null default now(),
    created_by  uuid,
    notified_at timestamptz,
    constraint worship_duties_target check (num_nonnulls(service_id, override_id) = 1)
);

create unique index if not exists worship_duties_unique
    on worship_duties (duty_date, coalesce(service_id, override_id), person_id, role);
create index if not exists worship_duties_date on worship_duties (duty_date);
create index if not exists worship_duties_person on worship_duties (person_id, duty_date);

-- ── правила доступа ───────────────────────────────────────────────────────────
alter table worship_services        enable row level security;
alter table worship_people          enable row level security;
alter table worship_person_services enable row level security;
alter table worship_person_notes    enable row level security;
alter table worship_absences        enable row level security;
alter table worship_day_overrides   enable row level security;
alter table worship_duties          enable row level security;

-- расписание читает весь персонал: «кто сегодня на арати» — вопрос не только отдела
create policy "worship services view" on worship_services for select using (worship_can_view());
create policy "worship services write" on worship_services for insert with check (worship_can_approve());
create policy "worship services update" on worship_services for update using (worship_can_approve()) with check (worship_can_approve());
create policy "worship services delete" on worship_services for delete using (worship_can_approve());

create policy "worship people view" on worship_people for select using (worship_can_view());
create policy "worship people write" on worship_people for insert with check (worship_can_approve());
create policy "worship people update" on worship_people for update using (worship_can_approve()) with check (worship_can_approve());
create policy "worship people delete" on worship_people for delete using (worship_can_approve());

create policy "worship person services view" on worship_person_services for select using (worship_can_view());
create policy "worship person services write" on worship_person_services for insert with check (worship_can_approve());
create policy "worship person services delete" on worship_person_services for delete using (worship_can_approve());

-- заметки: ни строки никому, кроме старшего
create policy "worship person notes view" on worship_person_notes for select using (worship_can_approve());
create policy "worship person notes write" on worship_person_notes for insert with check (worship_can_approve() and created_by = auth.uid());
create policy "worship person notes delete" on worship_person_notes for delete using (worship_can_approve());

-- недоступность видна всем, кто видит расписание: пустая клетка иначе
-- выглядит недосмотром. Пишется только через функции
create policy "worship absences view" on worship_absences for select using (worship_can_view());

-- отклонения дня ведёт старший
create policy "worship day overrides view" on worship_day_overrides for select using (worship_can_view());
create policy "worship day overrides write" on worship_day_overrides for insert with check (worship_can_approve());
create policy "worship day overrides update" on worship_day_overrides for update using (worship_can_approve()) with check (worship_can_approve());
create policy "worship day overrides delete" on worship_day_overrides for delete using (worship_can_approve());

-- назначения: только чтение напрямую, запись — через функции с проверками
create policy "worship duties view" on worship_duties for select using (worship_can_view());