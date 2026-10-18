-- Блок 3.4: подборки.
--
-- Набор из стандартов, материалов и фотонаборов, собранный под случай
-- и выданный человеку: «вот это прочти до приезда». Не курс с отчётностью —
-- прогресс не отслеживается сознательно, ни галочек, ни «кто что открывал».
create table if not exists worship_kits (
    id          uuid primary key default gen_random_uuid(),
    title       text not null,
    description text,
    lang        text not null default 'ru' check (lang in ('ru', 'en', 'hi')),
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    created_by  uuid,
    updated_at  timestamptz not null default now(),
    updated_by  uuid
);

-- Пункт — ровно одно из трёх: запись (стандарт или материал — это одна
-- таблица), набор фото или собственный текст составителя. Текст между
-- пунктами и делает из списка ссылок дорожку: «сначала прочти это,
-- потом посмотри, как выглядит».
create table if not exists worship_kit_items (
    id         uuid primary key default gen_random_uuid(),
    kit_id     uuid not null references worship_kits(id) on delete cascade,
    sort_order integer not null default 0,
    article_id uuid references worship_articles(id) on delete cascade,
    album_id   uuid references worship_albums(id) on delete cascade,
    note       text,
    created_at timestamptz not null default now(),
    created_by uuid,
    constraint worship_kit_item_target
        check (num_nonnulls(article_id, album_id, nullif(btrim(coalesce(note, '')), '')) = 1)
);

-- Выдача — решение о раскрытии: содержимое уходит человеку, который
-- не сотрудник отдела и, возможно, ещё не в ашраме. Поэтому у выдачи
-- есть автор, время и возможность отозвать.
create table if not exists worship_kit_grants (
    id         uuid primary key default gen_random_uuid(),
    kit_id     uuid not null references worship_kits(id) on delete cascade,
    vaishnava_id uuid references vaishnavas(id) on delete cascade,
    retreat_id uuid references retreats(id) on delete cascade,
    granted_at timestamptz not null default now(),
    granted_by uuid,
    revoked_at timestamptz,
    revoked_by uuid,
    constraint worship_kit_grant_target check (num_nonnulls(vaishnava_id, retreat_id) = 1)
);

create index if not exists worship_kit_items_kit_idx on worship_kit_items (kit_id, sort_order);
create index if not exists worship_kit_grants_kit_idx on worship_kit_grants (kit_id);
create index if not exists worship_kit_grants_person_idx
    on worship_kit_grants (vaishnava_id) where revoked_at is null;
create index if not exists worship_kit_grants_retreat_idx
    on worship_kit_grants (retreat_id) where revoked_at is null;

create unique index if not exists worship_kit_grants_person_once
    on worship_kit_grants (kit_id, vaishnava_id) where vaishnava_id is not null and revoked_at is null;
create unique index if not exists worship_kit_grants_retreat_once
    on worship_kit_grants (kit_id, retreat_id) where retreat_id is not null and revoked_at is null;

alter table worship_kits enable row level security;
alter table worship_kit_items enable row level security;
alter table worship_kit_grants enable row level security;

-- Внутри модуля подборки видны всем, кто видит модуль: приехавший волонтёр
-- открывает «Поклонение» и попадает в ту же дорожку, которую читал дома.
create policy "worship kits view" on worship_kits for select
    using (worship_can_view() and (is_active or worship_can_write()));
create policy "worship kits insert" on worship_kits for insert
    with check (worship_can_write() and created_by = auth.uid());
create policy "worship kits update" on worship_kits for update
    using (worship_can_write()) with check (worship_can_write());

create policy "worship kit items view" on worship_kit_items for select
    using (exists (select 1 from worship_kits k where k.id = kit_id));
create policy "worship kit items write" on worship_kit_items for insert
    with check (worship_can_write() and created_by = auth.uid());
create policy "worship kit items update" on worship_kit_items for update
    using (worship_can_write()) with check (worship_can_write());
create policy "worship kit items delete" on worship_kit_items for delete
    using (worship_can_write());

-- Кому выдано — внутренняя кухня отдела: видят пишущие.
create policy "worship kit grants view" on worship_kit_grants for select
    using (worship_can_write());

comment on table worship_kits is
    'Подборка: дорожка из стандартов, материалов и фотонаборов под случай.';
comment on table worship_kit_grants is
    'Выдача подборки человеку или ретриту. Выдача — решение о раскрытии: содержимое уходит за периметр отдела.';
