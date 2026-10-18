-- Функции подборок.

-- ── выдача ───────────────────────────────────────────────────────────────────
-- Закрытый набор фотографий в подборку не кладётся: снимки процесса одевания
-- не должны уехать к человеку, которого в отделе ещё не видели. Проверяем
-- при выдаче, а не только при составлении: набор могли закрыть позже.
create or replace function worship_kit_grant(
    p_kit uuid, p_vaishnava uuid default null, p_retreat uuid default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_закрытые text[];
    v_id uuid;
begin
    if not worship_can_write() then
        raise exception 'Выдавать подборки может пуджари' using errcode = '42501';
    end if;
    if num_nonnulls(p_vaishnava, p_retreat) <> 1 then
        raise exception 'Выдаём либо человеку, либо ретриту';
    end if;
    if not exists (select 1 from worship_kits where id = p_kit and is_active) then
        raise exception 'Подборка не найдена или отключена';
    end if;

    select array_agg(al.title) into v_закрытые
      from worship_kit_items i
      join worship_albums al on al.id = i.album_id
     where i.kit_id = p_kit and (al.is_private or al.is_archived);

    if v_закрытые is not null then
        raise exception 'В подборке закрытый набор фотографий: % . Откройте его или уберите из подборки',
            array_to_string(v_закрытые, ', ');
    end if;

    -- повторная выдача тому же человеку не создаёт второй записи
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

    return jsonb_build_object('ok', true, 'grant_id', v_id);
end $$;

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

    return jsonb_build_object('ok', true);
end $$;

-- ── что можно класть в подборку ──────────────────────────────────────────────
-- Та же проверка, что при выдаче, но заранее: интерфейс спрашивает об этом
-- в момент добавления, а не ставит перед фактом при выдаче.
create or replace function worship_kit_album_allowed(p_album uuid)
returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$
    select exists (select 1 from worship_albums
                    where id = p_album and not is_private and not is_archived);
$$;

-- ── чтение подборки гостем ───────────────────────────────────────────────────
-- Портал гостя читает подборку ОТДЕЛЬНЫМ путём, а не получает доступ к модулю:
-- функция отдаёт только содержимое выданных этому человеку подборок. Права
-- worship_view у гостя нет и не появляется.
--
-- Стандарты отдаются в действующей редакции: человек открывает подборку через
-- месяц и видит то, что действует сейчас, а не слепок на день выдачи.
-- Отменённый стандарт помечается, а не исчезает: иначе дорожка рвётся.
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
                                  'text', v.plain_text,
                                  'doc', v.doc,
                                  'archived', coalesce(a.status = 'archived', false),
                                  'event_date', al.event_date,
                                  'album_id', i.album_id)
                              order by i.sort_order)
                         from worship_kit_items i
                         left join worship_articles a on a.id = i.article_id
                         left join worship_versions v
                                on v.article_id = a.id and v.status = 'published'
                         left join worship_albums al on al.id = i.album_id
                        where i.kit_id = k.id), '[]'::jsonb)) as подборка
          from worship_kits k
         where k.is_active
           and exists (
               select 1 from worship_kit_grants g
                where g.kit_id = k.id and g.revoked_at is null
                  and (g.vaishnava_id = p_vaishnava
                       or g.retreat_id in (
                           select rr.retreat_id from retreat_registrations rr
                            where rr.vaishnava_id = p_vaishnava
                              and rr.status <> 'cancelled')))
      ) t;

    return jsonb_build_object('ok', true, 'подборки', v_итог);
end $$;

do $$
declare f text;
begin
    foreach f in array array['worship_kit_grant(uuid,uuid,uuid)', 'worship_kit_revoke(uuid)',
                             'worship_kit_album_allowed(uuid)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;

-- Функцию для портала вызывает только служебная сторона: у гостя своя
-- авторизация, и прямой доступ к ней из общего клиента не нужен.
revoke all on function worship_kit_for_guest(uuid) from public, anon, authenticated;
