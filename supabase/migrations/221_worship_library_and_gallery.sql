-- Блок 3.2: библиотека и галерея.
--
-- Библиотека живёт в тех же worship_articles с видом 'material': утверждения
-- у неё нет, версия сразу действующая. Новое здесь — файлы и внешние ссылки.
--
-- Галерея — свои таблицы: набор снимков это не статья, у него дата события
-- и закрытость, а у снимка подпись и порядок.

-- ── файлы и ссылки материала ─────────────────────────────────────────────────
-- Один материал — один носитель: либо файл у нас, либо ссылка наружу, либо
-- просто текст в редакторе. Вложений может быть несколько (книга сканами).
create table if not exists worship_attachments (
    id          uuid primary key default gen_random_uuid(),
    article_id  uuid not null references worship_articles(id) on delete cascade,
    kind        text not null default 'file' check (kind in ('file', 'link')),
    storage_path text,                       -- для файла
    url         text,                        -- для внешней ссылки
    name        text not null,
    mime        text,
    size_bytes  bigint,
    sort_order  integer not null default 0,
    created_at  timestamptz not null default now(),
    created_by  uuid,
    constraint worship_attachment_target
        check ((kind = 'file' and storage_path is not null and url is null)
            or (kind = 'link' and url is not null and storage_path is null))
);

create index if not exists worship_attachments_article_idx
    on worship_attachments (article_id, sort_order);

alter table worship_attachments enable row level security;

-- Вложение видно вместе со статьёй: отдельной жизни у него нет.
create policy "worship attachments view" on worship_attachments for select
    using (worship_can_view() and exists (
        select 1 from worship_articles a where a.id = article_id));
create policy "worship attachments write" on worship_attachments for insert
    with check (worship_can_write() and created_by = auth.uid());
create policy "worship attachments update" on worship_attachments for update
    using (worship_can_write()) with check (worship_can_write());
create policy "worship attachments delete" on worship_attachments for delete
    using (worship_can_write());

-- описание материала обязательно: библиотека без описаний за полгода
-- превращается в свалку файлов с именами вроде scan_0012.pdf
alter table worship_articles add column if not exists summary text;

-- ── наборы снимков ───────────────────────────────────────────────────────────
create table if not exists worship_albums (
    id           uuid primary key default gen_random_uuid(),
    title        text not null,
    description  text,
    -- дата события, а не дата загрузки: без неё через три года по тегу
    -- «Гаура-пурнима» будет десять наборов без признака года
    event_date   date not null,
    cover_image_id uuid,
    article_id   uuid references worship_articles(id) on delete set null,
    is_private   boolean not null default false,   -- «только для отдела»
    is_guide     boolean not null default false,   -- инструкция к стандарту: снимки крупнее
    is_archived  boolean not null default false,
    created_at   timestamptz not null default now(),
    created_by   uuid,
    updated_at   timestamptz not null default now(),
    updated_by   uuid
);

create table if not exists worship_images (
    id          uuid primary key default gen_random_uuid(),
    album_id    uuid not null references worship_albums(id) on delete cascade,
    storage_path text not null,
    caption     text,
    sort_order  integer not null default 0,
    shot_at     timestamptz,                 -- время съёмки из самого файла
    width       integer,
    height      integer,
    created_at  timestamptz not null default now(),
    created_by  uuid
);

alter table worship_albums
    add constraint worship_albums_cover_fk
    foreign key (cover_image_id) references worship_images(id) on delete set null;

create index if not exists worship_albums_date_idx on worship_albums (event_date desc);
create index if not exists worship_images_album_idx on worship_images (album_id, sort_order, shot_at);

alter table worship_albums enable row level security;
alter table worship_images enable row level security;

-- Закрытый набор видят только пуджари: снимки процесса одевания показывать
-- всему ашраму неуместно. Проверка идёт ПО НАБОРУ, а не по строке снимка,
-- иначе две проверки однажды разойдутся.
create policy "worship albums view" on worship_albums for select
    using (worship_can_view() and (not is_private or worship_can_write())
           and (not is_archived or worship_can_write()));

create policy "worship images view" on worship_images for select
    using (exists (select 1 from worship_albums a where a.id = album_id));

-- Набор ведёт пуджари; видимость меняет загрузивший или старший — это проверяет
-- функция, потому что правило по строке такого различия не выразит.
create policy "worship albums insert" on worship_albums for insert
    with check (worship_can_write() and created_by = auth.uid());
create policy "worship albums update" on worship_albums for update
    using (worship_can_write() and (created_by = auth.uid() or worship_can_approve()))
    with check (worship_can_write());

create policy "worship images insert" on worship_images for insert
    with check (worship_can_write() and created_by = auth.uid()
                and exists (select 1 from worship_albums a
                             where a.id = album_id and not a.is_archived));
create policy "worship images update" on worship_images for update
    using (worship_can_write()) with check (worship_can_write());
create policy "worship images delete" on worship_images for delete
    using (worship_can_write());

comment on table worship_albums is
    'Наборы снимков по темам. Закрытый набор (is_private) виден только пуджари.';
comment on column worship_albums.is_guide is
    'Набор-инструкция к стандарту: снимки уменьшаются до большего предела, иначе перестают быть инструкцией.';
comment on table worship_attachments is
    'Файлы и внешние ссылки материала библиотеки.';
