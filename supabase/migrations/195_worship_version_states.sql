-- Уточнение статусов, замеченное при проектировании утверждения.
--
-- В блоке 1.2 «на утверждении» было состоянием СТАТЬИ. На действующем стандарте
-- это ломается: пуджари правит статью, отправляет правку — и статья перестаёт
-- быть published, то есть пропадает из храма вместе с действующим текстом,
-- хотя ТЗ обещает ровно обратное («пока не утверждено, действует прежняя редакция»).
--
-- Поэтому состояния разведены:
--   статья  — существует ли тема и действует ли она: draft | published | archived;
--   версия  — роль конкретного текста: draft | submitted | published | superseded.
-- Очередь «ждут решения» — это версии в состоянии submitted, а не статьи.

alter table worship_versions drop constraint if exists worship_versions_status_check;
alter table worship_versions add constraint worship_versions_status_check
    check (status in ('draft', 'submitted', 'published', 'superseded'));

alter table worship_versions drop constraint if exists worship_version_no_when_published;
alter table worship_versions add constraint worship_version_no_when_published
    check ((status in ('published', 'superseded') and version_no is not null)
        or (status in ('draft', 'submitted') and version_no is null));

-- незавершённый текст у статьи один: черновик и отправленная правка — одно и то же
drop index if exists worship_versions_one_draft;
create unique index worship_versions_one_open
    on worship_versions (article_id) where status in ('draft', 'submitted');

alter table worship_articles drop constraint if exists worship_articles_status_check;
alter table worship_articles add constraint worship_articles_status_check
    check (status in ('draft', 'published', 'archived'));

-- правило доступа переписываем под новые состояния: незавершённое — только пуджари
drop policy if exists "worship versions view" on worship_versions;
create policy "worship versions view" on worship_versions for select
    using (worship_can_view()
           and (status in ('published', 'superseded') or worship_can_write()));

comment on column worship_versions.status is
    'draft — пишется; submitted — отправлена старшему; published — действует; superseded — вытеснена новой';
comment on column worship_articles.status is
    'draft — ни разу не публиковалась; published — действует; archived — отменена';
