-- Блок 1.2: разделы, статьи, версии.
--
-- Устройство, которое стоит понять до чтения схемы:
--   * текст живёт в версии, а не в статье. В статье — состояние темы целиком
--     и копия заголовка для списков, чтобы не тянуть версию ради одной строки;
--   * у статьи ровно одна действующая версия и ровно один черновик. Черновик
--     перезаписывается при сохранении и получает номер только при утверждении:
--     иначе история забилась бы промежуточными сохранениями;
--   * библиотека живёт в этих же таблицах с видом 'material', но проходит мимо
--     утверждения — у неё допустимы только «действует» и «архив».

-- ── помощники прав ────────────────────────────────────────────────────────────
create or replace function worship_can_view() returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$ select abk_current_user_has_permission('worship_view') $$;

create or replace function worship_can_write() returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$ select abk_current_user_has_permission('worship_write') $$;

create or replace function worship_can_approve() returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$ select abk_current_user_has_permission('worship_approve') $$;

revoke all on function worship_can_view(), worship_can_write(), worship_can_approve()
  from public, anon;
grant execute on function worship_can_view(), worship_can_write(), worship_can_approve()
  to authenticated;

-- ── разделы ───────────────────────────────────────────────────────────────────
create table if not exists worship_sections (
    id          uuid primary key default gen_random_uuid(),
    kind        text not null default 'standard' check (kind in ('standard', 'library')),
    name_ru     text not null,
    name_en     text,
    name_hi     text,
    sort_order  integer not null default 0,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now(),
    created_by  uuid,
    updated_at  timestamptz not null default now(),
    updated_by  uuid
);

-- ── статьи (стандарты и материалы библиотеки) ─────────────────────────────────
create table if not exists worship_articles (
    id                 uuid primary key default gen_random_uuid(),
    kind               text not null default 'standard' check (kind in ('standard', 'material')),
    section_id         uuid references worship_sections(id),
    title              text not null default '',
    lang               text not null default 'ru' check (lang in ('ru', 'en', 'hi')),
    status             text not null default 'draft'
                       check (status in ('draft', 'submitted', 'published', 'archived')),
    sort_order         integer not null default 0,
    current_version_id uuid,
    translation_of     uuid references worship_articles(id),
    source_version_id  uuid,
    source             text,
    author_name        text,
    replaced_by_id     uuid references worship_articles(id),
    created_at         timestamptz not null default now(),
    created_by         uuid,
    updated_at         timestamptz not null default now(),
    updated_by         uuid,
    submitted_at       timestamptz,
    submitted_by       uuid,
    returned_at        timestamptz,
    returned_by        uuid,
    return_reason      text,
    archived_at        timestamptz,
    archived_by        uuid,
    archive_reason     text,
    -- материал не проходит утверждение: промежуточных состояний у него нет
    constraint worship_material_status
        check (kind <> 'material' or status in ('published', 'archived'))
);

-- ── версии ────────────────────────────────────────────────────────────────────
create table if not exists worship_versions (
    id            uuid primary key default gen_random_uuid(),
    article_id    uuid not null references worship_articles(id) on delete cascade,
    status        text not null default 'draft'
                  check (status in ('draft', 'published', 'superseded')),
    version_no    integer,
    title         text not null default '',
    doc           jsonb not null default '{}'::jsonb,
    plain_text    text not null default '',
    search_vector tsvector,
    change_note   text,
    created_at    timestamptz not null default now(),
    created_by    uuid,
    updated_at    timestamptz not null default now(),
    approved_at   timestamptz,
    approved_by   uuid,
    -- номер появляется только при утверждении, у черновика его нет
    constraint worship_version_no_when_published
        check ((status = 'published' and version_no is not null)
            or (status = 'superseded' and version_no is not null)
            or (status = 'draft' and version_no is null))
);

alter table worship_articles
    add constraint worship_articles_current_version_fk
    foreign key (current_version_id) references worship_versions(id) on delete set null;

alter table worship_articles
    add constraint worship_articles_source_version_fk
    foreign key (source_version_id) references worship_versions(id) on delete set null;

-- ── ограничения, ради которых всё и затевалось ────────────────────────────────
create unique index if not exists worship_versions_no_unique
    on worship_versions (article_id, version_no) where version_no is not null;

-- действующая версия у статьи ровно одна
create unique index if not exists worship_versions_one_published
    on worship_versions (article_id) where status = 'published';

-- черновик тоже один: сохранение перезаписывает его, а не плодит строки
create unique index if not exists worship_versions_one_draft
    on worship_versions (article_id) where status = 'draft';

create index if not exists worship_articles_section_idx on worship_articles (section_id, sort_order);
create index if not exists worship_articles_status_idx on worship_articles (status);
create index if not exists worship_versions_article_idx on worship_versions (article_id);
create index if not exists worship_versions_search_idx on worship_versions using gin (search_vector);

-- ── правила доступа ───────────────────────────────────────────────────────────
alter table worship_sections enable row level security;
alter table worship_articles enable row level security;
alter table worship_versions enable row level security;

-- разделы: читает вся команда, ведёт старший. Удаления нет вовсе — раздел
-- скрывается, иначе статьи остались бы без дома
create policy "worship sections view" on worship_sections for select
    using (worship_can_view() and (is_active or worship_can_write()));
create policy "worship sections insert" on worship_sections for insert
    with check (worship_can_approve());
create policy "worship sections update" on worship_sections for update
    using (worship_can_approve()) with check (worship_can_approve());

-- статьи: действующее видит вся команда, остальное — только пуджари.
-- Политик записи нет: статус, номер версии и факт утверждения ставят функции
create policy "worship articles view" on worship_articles for select
    using (worship_can_view() and (status = 'published' or status = 'archived' or worship_can_write()));

-- версии: действующая и вытесненная видны всем читающим (история),
-- черновик — только пуджари
create policy "worship versions view" on worship_versions for select
    using (worship_can_view() and (status <> 'draft' or worship_can_write()));

comment on table worship_articles is
    'Стандарты (kind=standard) и материалы библиотеки (kind=material). Запись только через функции worship_*.';
comment on table worship_versions is
    'Текст статьи по версиям. Черновик один и перезаписывается, номер присваивается при утверждении.';
