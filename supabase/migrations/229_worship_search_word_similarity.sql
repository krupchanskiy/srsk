-- Поиск на обычной похожести не нашёл ничего: similarity сравнивает строку
-- целиком, и короткий запрос в длинном тексте всегда тонет («одеть» против
-- «Утреннее одевание» даёт 0.14 при пороге 0.3).
--
-- Нужна похожесть ЗАПРОСА С ОТДЕЛЬНЫМ СЛОВОМ текста — word_similarity:
-- «одеть» → «одевание» 0.5, опечатка «экодаши» → «экадаши» 0.45, чужое слово 0.
-- Порог задаём явно, а не полагаемся на сессионный show_limit: в stable-функции
-- его всё равно не выставить.
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
           websearch_to_tsquery('russian', btrim(coalesce(p_query, ''))) as слова,
           0.4::real as порог
),
стандарты as (
    select 'standard'::text as вид, a.id, v.title as заголовок,
           left(v.plain_text, 200) as кусок,
           case when a.status = 'archived' then 'не действует' else null end as добавочно,
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               word_similarity((select текст from запрос), v.title) * 2,
               word_similarity((select текст from запрос), left(v.plain_text, 4000))
           )::real as вес
      from worship_versions v
      join worship_articles a on a.id = v.article_id
     where v.status = 'published' and a.kind = 'standard'
       and (v.search_vector @@ (select слова from запрос)
            or word_similarity((select текст from запрос), v.title) >= (select порог from запрос)
            or word_similarity((select текст from запрос), left(v.plain_text, 4000)) >= (select порог from запрос))
),
материалы as (
    select 'material'::text, a.id, a.title,
           left(coalesce(a.summary, v.plain_text, ''), 200),
           nullif(a.author_name, ''),
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               word_similarity((select текст from запрос), a.title) * 2,
               word_similarity((select текст from запрос), coalesce(a.summary, '')) * 2,
               word_similarity((select текст from запрос), left(coalesce(v.plain_text, ''), 4000))
           )::real
      from worship_articles a
      left join worship_versions v on v.article_id = a.id and v.status = 'published'
     where a.kind = 'material' and a.status = 'published'
       and (v.search_vector @@ (select слова from запрос)
            or word_similarity((select текст from запрос), a.title) >= (select порог from запрос)
            or word_similarity((select текст from запрос), coalesce(a.summary, '')) >= (select порог from запрос)
            or word_similarity((select текст from запрос), left(coalesce(v.plain_text, ''), 4000)) >= (select порог from запрос))
),
вложения as (
    select 'material'::text, a.id, a.title, t.name,
           case t.kind when 'link' then 'ссылка' else 'файл' end,
           (word_similarity((select текст from запрос), t.name) * 2)::real
      from worship_attachments t
      join worship_articles a on a.id = t.article_id
     where a.status = 'published'
       and word_similarity((select текст from запрос), t.name) >= (select порог from запрос)
),
наборы as (
    select 'album'::text, al.id, al.title,
           coalesce(left(al.description, 200), ''),
           to_char(al.event_date, 'DD.MM.YYYY'),
           greatest(
               word_similarity((select текст from запрос), al.title) * 2,
               word_similarity((select текст from запрос), coalesce(al.description, '')),
               coalesce((select max(word_similarity((select текст from запрос), i.caption))
                           from worship_images i where i.album_id = al.id), 0)
           )::real
      from worship_albums al
     where not al.is_archived
       and (word_similarity((select текст from запрос), al.title) >= (select порог from запрос)
            or word_similarity((select текст from запрос), coalesce(al.description, '')) >= (select порог from запрос)
            or exists (select 1 from worship_images i
                        where i.album_id = al.id
                          and word_similarity((select текст from запрос), coalesce(i.caption, '')) >= (select порог from запрос)))
)
select * from (
    select * from стандарты
    union all select * from материалы
    union all select * from вложения
    union all select * from наборы
) всё
where вес > 0.2 and length((select текст from запрос)) >= 2
order by вес desc, заголовок
limit greatest(1, least(coalesce(p_limit, 40), 200));
$$;

revoke all on function worship_search(text, integer) from public, anon;
grant execute on function worship_search(text, integer) to authenticated;
