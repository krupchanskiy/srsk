-- Гостю не уезжает заголовок неутверждённого стандарта: в пунктах подборки
-- фильтровалась версия, но не статус самой статьи.
create or replace function worship_kit_for_guest(p_vaishnava uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare v_итог jsonb;
begin
    if p_vaishnava is null then raise exception 'Не указан человек'; end if;

    select coalesce(jsonb_agg(подборка order by подборка->>'title'), '[]'::jsonb)
      into v_итог
      from (
        select jsonb_build_object(
                   'id', k.id,
                   'title', k.title,
                   'description', k.description,
                   'lang', k.lang,
                   'items', coalesce((
                       select jsonb_agg(jsonb_build_object(
                                  'kind', case when i.note is not null then 'note'
                                               when i.album_id is not null then 'album'
                                               when a.kind = 'material' then 'material'
                                               else 'standard' end,
                                  'note', i.note,
                                  'title', coalesce(v.title, a.title, al.title),
                                  'summary', a.summary,
                                  'author', a.author_name,
                                  'source', a.source,
                                  'text', v.plain_text,
                                  'doc', v.doc,
                                  'archived', coalesce(a.status = 'archived', false),
                                  'event_date', al.event_date,
                                  'album_id', i.album_id,
                                  -- пути, а не ссылки: подписывает их служебная
                                  -- сторона портала, у которой есть доступ к бакету
                                  'images', coalesce((
                                      select jsonb_agg(jsonb_build_object(
                                                 'path', im.storage_path,
                                                 'caption', im.caption)
                                             order by im.sort_order, im.shot_at)
                                        from worship_images im
                                       where im.album_id = al.id), '[]'::jsonb),
                                  'files', coalesce((
                                      select jsonb_agg(jsonb_build_object(
                                                 'kind', t.kind,
                                                 'name', t.name,
                                                 'path', t.storage_path,
                                                 'url', t.url)
                                             order by t.sort_order)
                                        from worship_attachments t
                                       where t.article_id = a.id), '[]'::jsonb))
                              order by i.sort_order)
                         from worship_kit_items i
                         -- черновик и правка на утверждении наружу не уезжают
                         -- даже заголовком: статья должна быть действующей
                         left join worship_articles a
                                on a.id = i.article_id
                               and a.status in ('published', 'archived')
                         left join worship_versions v
                                on v.article_id = a.id and v.status = 'published'
                         -- закрытый или убранный в архив набор не уезжает наружу,
                         -- даже если его закрыли уже после выдачи
                         left join worship_albums al
                                on al.id = i.album_id
                               and not al.is_private and not al.is_archived
                        where i.kit_id = k.id
                          and (i.note is not null
                               or (i.article_id is not null and a.id is not null)
                               or (i.album_id is not null and al.id is not null))),
                       '[]'::jsonb)) as подборка
          from worship_kits k
         where k.is_active
           and exists (
               select 1 from worship_kit_grants g
                where g.kit_id = k.id and g.revoked_at is null
                  and (g.vaishnava_id = p_vaishnava
                       or g.retreat_id in (
                           select rr.retreat_id from retreat_registrations rr
                            where rr.vaishnava_id = p_vaishnava
                              -- «всем волонтёрам ретрита», а не всем подряд:
                              -- гость и VIP приезжают не служить
                              and rr.status in ('volunteer', 'team'))))
      ) t;

    return jsonb_build_object('ok', true, 'подборки', v_итог);
end $function$;

revoke all on function worship_kit_for_guest(uuid) from public, anon, authenticated;

-- Выдача несуществующему человеку отдавала сырую ошибку внешнего ключа.
create or replace function worship_kit_grant(p_kit uuid, p_vaishnava uuid default null, p_retreat uuid default null)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
    v_закрытые text[];
    v_id uuid;
    v_подборка worship_kits%rowtype;
    v_кому uuid;
begin
    if not worship_can_write() then
        raise exception 'Выдавать подборки может пуджари' using errcode = '42501';
    end if;
    if num_nonnulls(p_vaishnava, p_retreat) <> 1 then
        raise exception 'Выдаём либо человеку, либо ретриту';
    end if;
    if p_vaishnava is not null and not exists (select 1 from vaishnavas where id = p_vaishnava) then
        raise exception 'Такого человека нет в списке вайшнавов';
    end if;
    if p_retreat is not null and not exists (select 1 from retreats where id = p_retreat) then
        raise exception 'Такого ретрита нет';
    end if;

    select * into v_подборка from worship_kits where id = p_kit and is_active;
    if not found then raise exception 'Подборка не найдена или отключена'; end if;

    select array_agg(al.title) into v_закрытые
      from worship_kit_items i
      join worship_albums al on al.id = i.album_id
     where i.kit_id = p_kit and (al.is_private or al.is_archived);

    if v_закрытые is not null then
        raise exception 'В подборке закрытый набор фотографий: % . Откройте его или уберите из подборки',
            array_to_string(v_закрытые, ', ');
    end if;

    select id into v_id from worship_kit_grants
     where kit_id = p_kit and revoked_at is null
       and vaishnava_id is not distinct from p_vaishnava
       and retreat_id is not distinct from p_retreat;
    if v_id is not null then
        return jsonb_build_object('ok', true, 'повтор', true, 'grant_id', v_id);
    end if;

    insert into worship_kit_grants (kit_id, vaishnava_id, retreat_id, granted_by)
    values (p_kit, p_vaishnava, p_retreat, auth.uid())
    returning id into v_id;

    -- человеку — личное сообщение; ретриту сообщаем каждому волонтёру отдельно,
    -- общий чат отдела тут ни при чём: это письмо адресату, а не новость
    if p_vaishnava is not null then
        select user_id into v_кому from vaishnavas where id = p_vaishnava;
        if v_кому is not null then
            perform worship_event('kit_granted', null, null, null, v_кому,
                                  'kit:' || v_id,
                                  jsonb_build_object('заголовок', v_подборка.title,
                                                     'kit_id', p_kit));
        end if;
    else
        for v_кому in
            select v.user_id
              from retreat_registrations rr
              join vaishnavas v on v.id = rr.vaishnava_id
             where rr.retreat_id = p_retreat
               and rr.status in ('volunteer', 'team')
               and v.user_id is not null
        loop
            perform worship_event('kit_granted', null, null, null, v_кому,
                                  'kit:' || v_id || ':' || v_кому,
                                  jsonb_build_object('заголовок', v_подборка.title,
                                                     'kit_id', p_kit));
        end loop;
    end if;

    return jsonb_build_object('ok', true, 'grant_id', v_id);
end $function$;

revoke all on function worship_kit_grant(uuid, uuid, uuid) from public, anon;
grant execute on function worship_kit_grant(uuid, uuid, uuid) to authenticated;

-- Материал приходил в выдачу дважды: из своего CTE и из CTE вложений.
create or replace function worship_search(p_query text, p_limit integer default 40)
returns table ("вид" text, id uuid, "заголовок" text, "кусок" text, "добавочно" text, "вес" real)
language sql stable set search_path to 'public', 'pg_temp' as $function$
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
-- одна вещь — одна строка: из двух попаданий остаётся то, что весит больше
select вид, id, заголовок, кусок, добавочно, вес from (
    select distinct on (вид, id) * from (
        select * from стандарты
        union all select * from материалы
        union all select * from вложения
        union all select * from наборы
    ) всё
    where вес > 0.2 and length((select текст from запрос)) >= 2
    order by вид, id, вес desc
) сжато
order by вес desc, заголовок
limit greatest(1, least(coalesce(p_limit, 40), 200));
$function$;

revoke all on function worship_search(text, integer) from public, anon;
grant execute on function worship_search(text, integer) to authenticated;