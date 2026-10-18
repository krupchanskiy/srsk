-- Разбор глазами отдела: что ломало работу.
--
-- 1. Триггер проверки снимков срабатывал на ЛЮБОМ обновлении версии, включая
--    служебное «вытеснить прежнюю редакцию» внутри worship_approve. Если набор
--    со снимком из текста закрывали, стандарт становился неутверждаемым
--    навсегда: ни утвердить, ни отозвать, ни вернуть автору. Теперь проверка
--    идёт только когда текст действительно меняется.
drop trigger if exists worship_versions_images_open on worship_versions;
create trigger worship_versions_images_open
    before insert on worship_versions for each row
    execute function worship_version_images_open();
create trigger worship_versions_images_open_upd
    before update of doc on worship_versions for each row
    when (new.doc is distinct from old.doc)
    execute function worship_version_images_open();

-- 2. Закрыть или убрать в архив набор, снимки которого стоят в действующем
--    стандарте, больше нельзя: раньше это молча вырезало картинку у всех,
--    кроме отдела, и никто об этом не узнавал.
--    Заодно сравнение с NULL: у набора без автора проверка авторства
--    не выполнялась вовсе (тот же случай, что в расписании).
create or replace function worship_album_visibility(p_album uuid, p_private boolean)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_набор worship_albums%rowtype; v_в_стандартах text[];
begin
    if not worship_can_write() then
        raise exception 'Менять видимость набора может пуджари' using errcode = '42501';
    end if;
    select * into v_набор from worship_albums where id = p_album;
    if not found then raise exception 'Набор не найден'; end if;
    if v_набор.created_by is distinct from auth.uid() and not worship_can_approve() then
        raise exception 'Видимость меняет тот, кто загрузил набор, или старший пуджари'
            using errcode = '42501';
    end if;

    if p_private then
        select array_agg(distinct coalesce(v.title, a.title)) into v_в_стандартах
          from worship_images i
          join worship_versions v on v.doc::text like '%' || i.storage_path || '%'
          join worship_articles a on a.id = v.article_id
         where i.album_id = p_album and v.status in ('published', 'submitted');
        if v_в_стандартах is not null then
            raise exception 'Снимки из набора стоят в стандартах: %. Закрыть набор — значит убрать их оттуда для всех, кроме отдела',
                array_to_string(v_в_стандартах, ', ');
        end if;
    end if;

    update worship_albums
       set is_private = p_private, updated_at = now(), updated_by = auth.uid()
     where id = p_album;
    return jsonb_build_object('ok', true, 'is_private', p_private);
end $$;

revoke all on function worship_album_visibility(uuid, boolean) from public, anon;
grant execute on function worship_album_visibility(uuid, boolean) to authenticated;

-- 3. Наборы ведёт отдел сообща: карточку набора правит любой пуджари — иначе
--    кнопка есть, а функция отказывает, и это читается как ошибка. Авторство
--    спрашиваем там, где решается раскрытие: видимость (выше) и архив.
create or replace function worship_album_update(p_album uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $function$
declare
    v_набор worship_albums%rowtype;
    v_в_архив boolean;
    v_в_стандартах text[];
begin
    if not worship_can_write() then
        raise exception 'Вести наборы может пуджари' using errcode = '42501';
    end if;

    select * into v_набор from worship_albums where id = p_album for update;
    if not found then raise exception 'Набор не найден'; end if;

    v_в_архив := (p_payload ? 'is_archived') and (p_payload->>'is_archived')::boolean
                 and not coalesce(v_набор.is_archived, false);

    if v_в_архив and v_набор.created_by is distinct from auth.uid() and not worship_can_approve() then
        raise exception 'Убрать набор в архив может тот, кто его завёл, или старший пуджари'
            using errcode = '42501';
    end if;

    if v_в_архив then
        select array_agg(distinct coalesce(v.title, a.title)) into v_в_стандартах
          from worship_images i
          join worship_versions v on v.doc::text like '%' || i.storage_path || '%'
          join worship_articles a on a.id = v.article_id
         where i.album_id = p_album and v.status in ('published', 'submitted');
        if v_в_стандартах is not null then
            raise exception 'Снимки из набора стоят в стандартах: %. Уберите их оттуда, иначе на их месте у всех будет пустота',
                array_to_string(v_в_стандартах, ', ');
        end if;
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
end $function$;

revoke all on function worship_album_update(uuid, jsonb) from public, anon;
grant execute on function worship_album_update(uuid, jsonb) to authenticated;

-- 4. Подпись к снимку ставит любой пуджари: он стоит у алтаря и знает,
--    что на кадре. Раньше поле подписи показывалось всем, а функция
--    отказывала всем, кроме автора набора.
create or replace function worship_image_caption(p_image uuid, p_caption text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
    if not worship_can_write() then
        raise exception 'Подписывать снимки может пуджари' using errcode = '42501';
    end if;
    update worship_images set caption = nullif(btrim(coalesce(p_caption, '')), '')
     where id = p_image;
    if not found then raise exception 'Снимок не найден'; end if;
    return jsonb_build_object('ok', true);
end $$;

revoke all on function worship_image_caption(uuid, text) from public, anon;
grant execute on function worship_image_caption(uuid, text) to authenticated;

-- 5. «Утверждать некому» показывалось при живом старшем: worship_holders
--    смотрит роли и личные права, а суперпользователь проходит любую проверку
--    прав. Но суперпользователей девятнадцать — слать им письма о каждой
--    правке нельзя, рассылку отключат на второй день. Поэтому список для
--    уведомлений прежний, а счётчик «есть ли кому утверждать» их учитывает.
create or replace function worship_approvers_count() returns integer
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select case when worship_can_view() then (
        select count(distinct кто)::integer from (
            select worship_holders('worship_approve') as кто
            union
            select v.user_id from vaishnavas v where v.is_superuser and v.user_id is not null
        ) t where кто is not null)
    else 0 end
$$;

revoke all on function worship_approvers_count() from public, anon;
grant execute on function worship_approvers_count() to authenticated;
