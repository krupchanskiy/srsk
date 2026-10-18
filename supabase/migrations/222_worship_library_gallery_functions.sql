-- Функции библиотеки и галереи.

-- ── материал библиотеки ──────────────────────────────────────────────────────
-- «Убрать лишнее» у старшего значит в архив: на материал могли ссылаться
-- из стандарта. Удаление насовсем, вместе с файлами, — отдельная команда
-- и только из архива.
create or replace function worship_material_delete(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья worship_articles%rowtype;
    v_файлы  text[];
begin
    if not worship_can_approve() then
        raise exception 'Удалять материалы может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Материал не найден'; end if;
    if v_статья.kind <> 'material' then
        raise exception 'Это стандарт: его можно только вывести из действия';
    end if;
    if v_статья.status <> 'archived' then
        raise exception 'Сначала уберите материал в архив: на него могли ссылаться';
    end if;

    select array_agg(storage_path) into v_файлы
      from worship_attachments where article_id = p_article and storage_path is not null;

    delete from worship_articles where id = p_article;

    -- сами файлы удаляет вызывающий: из базы объект в хранилище не стирается
    return jsonb_build_object('ok', true, 'файлы', coalesce(v_файлы, array[]::text[]));
end $$;

-- ── наборы снимков ───────────────────────────────────────────────────────────
-- Видимость меняет загрузивший или старший — это нельзя выразить правилом
-- на строку, поэтому отдельной функцией.
create or replace function worship_album_visibility(p_album uuid, p_private boolean)
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
        raise exception 'Видимость меняет тот, кто загрузил набор, или старший пуджари'
            using errcode = '42501';
    end if;

    update worship_albums
       set is_private = p_private, updated_at = now(), updated_by = auth.uid()
     where id = p_album;

    return jsonb_build_object('ok', true);
end $$;

-- Снимок из закрытого набора нельзя молча вставить в стандарт, который читают
-- все: иначе выйдет либо стандарт с дырами вместо картинок, либо тихий обход
-- закрытости, ради которой набор и закрывали. Интерфейс спрашивает об этом
-- заранее, а функция отвечает на вопрос «а этот снимок вообще можно показывать».
create or replace function worship_image_is_open(p_path text)
returns boolean
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$
    select exists (
        select 1 from worship_images i
          join worship_albums a on a.id = i.album_id
         where i.storage_path = p_path and not a.is_private and not a.is_archived);
$$;

-- Удаление снимка вместе с файлом: обычный запрос к базе объект в хранилище
-- не трогает, и за полгода там накопится то, чего нет ни в одном наборе.
create or replace function worship_image_delete(p_image uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_путь text;
begin
    if not worship_can_write() then
        raise exception 'Убирать снимки может пуджари' using errcode = '42501';
    end if;

    select storage_path into v_путь from worship_images where id = p_image;
    if v_путь is null then raise exception 'Снимок не найден'; end if;

    delete from worship_images where id = p_image;
    return jsonb_build_object('ok', true, 'путь', v_путь);
end $$;

-- Порядок снимков в наборе: по умолчанию по времени съёмки, но руками его
-- можно переставить — время съёмки не всегда совпадает с порядком рассказа.
create or replace function worship_image_reorder(p_image uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_снимок worship_images%rowtype;
    v_мой    integer;
    v_сосед  uuid;
begin
    if not worship_can_write() then
        raise exception 'Менять порядок снимков может пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию';
    end if;

    select * into v_снимок from worship_images where id = p_image for update;
    if not found then raise exception 'Снимок не найден'; end if;

    perform 1 from worship_images where album_id = v_снимок.album_id order by id for update;

    with упорядоченные as (
        select id, (row_number() over (order by sort_order, shot_at, created_at, id) - 1)::int as n
          from worship_images where album_id = v_снимок.album_id
    )
    update worship_images i set sort_order = у.n
      from упорядоченные у
     where i.id = у.id and i.sort_order is distinct from у.n;

    select sort_order into v_мой from worship_images where id = p_image;
    select id into v_сосед from worship_images
     where album_id = v_снимок.album_id and sort_order = v_мой + p_direction limit 1;

    if v_сосед is null then return jsonb_build_object('ok', true, 'край', true); end if;

    update worship_images set sort_order = v_мой where id = v_сосед;
    update worship_images set sort_order = v_мой + p_direction where id = p_image;

    return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
    foreach f in array array[
        'worship_material_delete(uuid)', 'worship_album_visibility(uuid,boolean)',
        'worship_image_is_open(text)', 'worship_image_delete(uuid)',
        'worship_image_reorder(uuid,integer)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
