-- Починки по итогам сверки этапа 3 с ТЗ.
--
-- 1. «Выдать группе — всем ВОЛОНТЁРАМ ретрита»: функция брала всех
--    участников подряд, включая гостей и VIP. Старший думал, что открыл
--    дорожку волонтёрам, а открывал её всему ретриту.
-- 2. Закрытый после выдачи набор продолжал уезжать гостю: выдача проверяла
--    закрытость, а чтение — нет.
-- 3. Снимки набора и файлы материала не отдавались вовсе: волонтёр получал
--    пункт «набор фото» без фотографий и книгу без скана.
create or replace function worship_kit_for_guest(p_vaishnava uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
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
                         left join worship_articles a on a.id = i.article_id
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
end $$;

revoke all on function worship_kit_for_guest(uuid) from public, anon, authenticated;

-- ── выдача пишет событие ─────────────────────────────────────────────────────
-- ТЗ: «при выдаче человеку уходит сообщение со ссылкой». Раньше выдача
-- не оставляла ни следа в очереди уведомлений — включение рубильника
-- не прислало бы ничего, потому что присылать было нечего.
alter table worship_notifications drop constraint if exists worship_notifications_kind_check;
alter table worship_notifications add constraint worship_notifications_kind_check
    check (kind in ('submitted','approved','returned','remark','stale','kit_granted'));

create or replace function worship_kit_grant(
    p_kit uuid, p_vaishnava uuid default null, p_retreat uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
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
end $$;

revoke all on function worship_kit_grant(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function worship_kit_grant(uuid,uuid,uuid) to authenticated;

-- ── отзыв гасит неотправленное ───────────────────────────────────────────────
create or replace function worship_kit_revoke(p_grant uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
begin
    if not worship_can_write() then
        raise exception 'Отзывать выдачу может пуджари' using errcode = '42501';
    end if;

    update worship_kit_grants
       set revoked_at = now(), revoked_by = auth.uid()
     where id = p_grant and revoked_at is null;

    -- письмо о подборке, доступ к которой уже закрыт, только собьёт
    delete from worship_notifications
     where kind = 'kit_granted' and sent_at is null
       and (event_key = 'kit:' || p_grant or event_key like 'kit:' || p_grant || ':%');

    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_kit_revoke(uuid) from public, anon, authenticated;
grant execute on function worship_kit_revoke(uuid) to authenticated;
