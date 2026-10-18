-- Блок 3.3, часть вторая: поиск.
--
-- Поправка ТЗ к самому себе стоит того, чтобы её повторить: «„одеть“ находит
-- „одевание“» на штатном русском словаре НЕ работает — основы получаются
-- разные («одет» и «одеван»). Поэтому к обычному полнотекстовому поиску
-- добавляется поиск по похожести: он находит однокоренные и опечатки.
create extension if not exists pg_trgm;

-- ── поисковый образ версии ───────────────────────────────────────────────────
-- Образ лежит в версии, а не в статье: ищут по тексту, а текст живёт там.
-- Язык разбора берётся из языка статьи.
create or replace function worship_version_search_vector()
returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_lang regconfig;
begin
    select case a.lang when 'en' then 'english'::regconfig
                       when 'hi' then 'simple'::regconfig
                       else 'russian'::regconfig end
      into v_lang
      from worship_articles a where a.id = new.article_id;

    new.search_vector :=
        setweight(to_tsvector(coalesce(v_lang, 'russian'), coalesce(new.title, '')), 'A') ||
        setweight(to_tsvector(coalesce(v_lang, 'russian'), coalesce(new.plain_text, '')), 'B');
    return new;
end $$;

drop trigger if exists worship_versions_search on worship_versions;
create trigger worship_versions_search
    before insert or update of title, plain_text on worship_versions
    for each row execute function worship_version_search_vector();

-- пересобираем образ у того, что уже написано
update worship_versions set plain_text = plain_text;

-- ── поиск по похожести ───────────────────────────────────────────────────────
-- Триграммные индексы: по ним находится «одевание» на запрос «одеть»
-- и «экадаши» на «экодаши».
create index if not exists worship_versions_trgm
    on worship_versions using gin (plain_text gin_trgm_ops);
create index if not exists worship_versions_title_trgm
    on worship_versions using gin (title gin_trgm_ops);
create index if not exists worship_images_caption_trgm
    on worship_images using gin (caption gin_trgm_ops);
create index if not exists worship_albums_title_trgm
    on worship_albums using gin (title gin_trgm_ops);
create index if not exists worship_attachments_name_trgm
    on worship_attachments using gin (name gin_trgm_ops);

-- ── сам поиск ────────────────────────────────────────────────────────────────
-- Выдача сгруппирована по видам: человек не знает, в каком из хранилищ ответ,
-- он помнит слово. Видимость каждой строки проверяется теми же правилами,
-- что и при обычном чтении: функция намеренно НЕ security definer.
create or replace function worship_search(p_query text, p_limit integer default 40)
returns table (
    вид        text,
    id         uuid,
    заголовок  text,
    кусок      text,
    добавочно  text,
    вес        real
)
language sql stable
set search_path to 'public', 'pg_temp'
as $$
with запрос as (
    select btrim(coalesce(p_query, '')) as текст,
           websearch_to_tsquery('russian', btrim(coalesce(p_query, ''))) as слова
),
стандарты as (
    select 'standard'::text as вид, a.id, v.title as заголовок,
           left(v.plain_text, 200) as кусок,
           case when a.status = 'archived' then 'не действует' else null end as добавочно,
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               similarity(v.title, (select текст from запрос)) * 2,
               similarity(left(v.plain_text, 2000), (select текст from запрос))
           )::real as вес
      from worship_versions v
      join worship_articles a on a.id = v.article_id
     where v.status = 'published' and a.kind = 'standard'
       and ((select слова from запрос) is not null and v.search_vector @@ (select слова from запрос)
            or v.title % (select текст from запрос)
            or left(v.plain_text, 2000) % (select текст from запрос))
),
материалы as (
    select 'material'::text, a.id, a.title,
           left(coalesce(a.summary, v.plain_text), 200),
           nullif(a.author_name, ''),
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               similarity(a.title, (select текст from запрос)) * 2,
               similarity(coalesce(a.summary, ''), (select текст from запрос)) * 2,
               similarity(left(coalesce(v.plain_text, ''), 2000), (select текст from запрос))
           )::real
      from worship_articles a
      left join worship_versions v on v.article_id = a.id and v.status = 'published'
     where a.kind = 'material' and a.status = 'published'
       and ((select слова from запрос) is not null and v.search_vector @@ (select слова from запрос)
            or a.title % (select текст from запрос)
            or coalesce(a.summary, '') % (select текст from запрос))
),
вложения as (
    select 'material'::text, a.id, a.title, t.name,
           'файл'::text,
           (similarity(t.name, (select текст from запрос)) * 2)::real
      from worship_attachments t
      join worship_articles a on a.id = t.article_id
     where a.status = 'published' and t.name % (select текст from запрос)
),
наборы as (
    select 'album'::text, al.id, al.title,
           coalesce(left(al.description, 200), ''),
           to_char(al.event_date, 'DD.MM.YYYY'),
           greatest(
               similarity(al.title, (select текст from запрос)) * 2,
               similarity(coalesce(al.description, ''), (select текст from запрос)),
               coalesce((select max(similarity(i.caption, (select текст from запрос)))
                           from worship_images i where i.album_id = al.id), 0)
           )::real
      from worship_albums al
     where not al.is_archived
       and (al.title % (select текст from запрос)
            or coalesce(al.description, '') % (select текст from запрос)
            or exists (select 1 from worship_images i
                        where i.album_id = al.id and i.caption % (select текст from запрос)))
)
select * from (
    select * from стандарты
    union all select * from материалы
    union all select * from вложения
    union all select * from наборы
) всё
where вес > 0.08
order by вес desc, заголовок
limit greatest(1, least(coalesce(p_limit, 40), 200));
$$;

revoke all on function worship_search(text, integer) from public, anon;
grant execute on function worship_search(text, integer) to authenticated;

comment on function worship_search is
    'Один поиск на модуль: стандарты, материалы, вложения, наборы фото. Полнотекстовый плюс похожесть (pg_trgm): «одеть» находит «одевание», опечатки тоже. Не security definer — видимость строк проверяют обычные правила доступа.';
