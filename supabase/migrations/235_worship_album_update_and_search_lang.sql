-- Ещё три починки по итогам сверки.
--
-- 1. Правка чужого набора молча не сохранялась: политика пускает только
--    загрузившего или старшего, а кнопки «Изменить набор» и «обложка» видел
--    любой пуджари. Обычный update возвращал ноль строк без ошибки — человек
--    видел «сохранено», а в базе оставалось старое. Тот же урок, что
--    с карточкой материала: где правило уже, чем интерфейс, нужна функция.
create or replace function worship_album_update(p_album uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_набор worship_albums%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Вести наборы может пуджари' using errcode = '42501';
    end if;

    select * into v_набор from worship_albums where id = p_album for update;
    if not found then raise exception 'Набор не найден'; end if;
    if v_набор.created_by <> auth.uid() and not worship_can_approve() then
        raise exception 'Набор правит тот, кто его завёл, или старший пуджари'
            using errcode = '42501';
    end if;

    update worship_albums
       set title = coalesce(nullif(btrim(p_payload->>'title'), ''), title),
           description = case when p_payload ? 'description'
                              then nullif(btrim(p_payload->>'description'), '')
                              else description end,
           event_date = coalesce(nullif(p_payload->>'event_date', '')::date, event_date),
           article_id = case when p_payload ? 'article_id'
                             then nullif(p_payload->>'article_id', '')::uuid
                             else article_id end,
           cover_image_id = case when p_payload ? 'cover_image_id'
                                 then nullif(p_payload->>'cover_image_id', '')::uuid
                                 else cover_image_id end,
           is_guide = coalesce((p_payload->>'is_guide')::boolean, is_guide),
           is_archived = coalesce((p_payload->>'is_archived')::boolean, is_archived),
           updated_at = now(), updated_by = auth.uid()
     where id = p_album;

    return jsonb_build_object('ok', true);
end $$;

-- 2. Подпись к снимку тоже правится функцией: политика на update у снимков
--    есть, но она шире правила набора — выходило, что подпись к чужому
--    набору поправить можно, а название нет.
create or replace function worship_image_caption(p_image uuid, p_caption text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_набор worship_albums%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Подписывать снимки может пуджари' using errcode = '42501';
    end if;

    select al.* into v_набор
      from worship_images i join worship_albums al on al.id = i.album_id
     where i.id = p_image;
    if not found then raise exception 'Снимок не найден'; end if;
    if v_набор.created_by <> auth.uid() and not worship_can_approve() then
        raise exception 'Снимки подписывает тот, кто завёл набор, или старший'
            using errcode = '42501';
    end if;

    update worship_images
       set caption = nullif(btrim(coalesce(p_caption, '')), '')
     where id = p_image;

    return jsonb_build_object('ok', true);
end $$;

-- 3. Поиск разбирал запрос только по-русски: у английской статьи
--    полнотекстовая часть не срабатывала вовсе. Разбираем обоими словарями —
--    образ всё равно построен по языку статьи, и лишний разбор просто
--    не найдёт совпадений.
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
           websearch_to_tsquery('english', btrim(coalesce(p_query, ''))) as слова_en,
           0.4::real as порог
),
стандарты as (
    select 'standard'::text as вид, a.id, v.title as заголовок,
           left(v.plain_text, 200) as кусок,
           case when a.status = 'archived' then 'не действует' else null end as добавочно,
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               coalesce(ts_rank(v.search_vector, (select слова_en from запрос)), 0) * 4,
               word_similarity((select текст from запрос), v.title) * 2,
               word_similarity((select текст from запрос), left(v.plain_text, 4000))
           )::real as вес
      from worship_versions v
      join worship_articles a on a.id = v.article_id
     where v.status = 'published' and a.kind = 'standard'
       and (v.search_vector @@ (select слова from запрос)
            or v.search_vector @@ (select слова_en from запрос)
            or word_similarity((select текст from запрос), v.title) >= (select порог from запрос)
            or word_similarity((select текст from запрос), left(v.plain_text, 4000)) >= (select порог from запрос))
),
материалы as (
    select 'material'::text, a.id, a.title,
           left(coalesce(a.summary, v.plain_text, ''), 200),
           case when a.status = 'archived' then 'в архиве' else nullif(a.author_name, '') end,
           greatest(
               coalesce(ts_rank(v.search_vector, (select слова from запрос)), 0) * 4,
               coalesce(ts_rank(v.search_vector, (select слова_en from запрос)), 0) * 4,
               word_similarity((select текст from запрос), a.title) * 2,
               word_similarity((select текст from запрос), coalesce(a.summary, '')) * 2,
               word_similarity((select текст from запрос), left(coalesce(v.plain_text, ''), 4000))
           )::real
      from worship_articles a
      left join worship_versions v on v.article_id = a.id and v.status = 'published'
     -- архивный материал находится с пометкой, как и архивный стандарт:
     -- иначе поиск молчит о том, что вещь была и её убрали
     where a.kind = 'material' and a.status in ('published', 'archived')
       and (v.search_vector @@ (select слова from запрос)
            or v.search_vector @@ (select слова_en from запрос)
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
           -- если набор нашёлся по подписи снимка, показываем именно её:
           -- иначе непонятно, почему он вообще в выдаче
           coalesce(
               (select i.caption from worship_images i
                 where i.album_id = al.id
                   and word_similarity((select текст from запрос), coalesce(i.caption, '')) >= (select порог from запрос)
                 order by word_similarity((select текст from запрос), i.caption) desc
                 limit 1),
               left(coalesce(al.description, ''), 200)),
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

do $$
declare f text;
begin
    foreach f in array array['worship_album_update(uuid,jsonb)', 'worship_image_caption(uuid,text)',
                             'worship_search(text,integer)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
