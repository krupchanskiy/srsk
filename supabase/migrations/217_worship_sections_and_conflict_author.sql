-- Починки по итогам прогона глазами отдела.

-- ── 1. Пустой раздел можно удалить ───────────────────────────────────────────
-- Подсказка в окне обещает «раздел с содержимым не удаляется», то есть пустой —
-- удаляется. Кнопки не было вовсе, и раздел, заведённый с опечаткой, оставался
-- навсегда. Удаление идёт функцией: политика DELETE на таблице пустила бы
-- и раздел со статьями, оставив их без дома.
create or replace function worship_section_delete(p_section uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
begin
    if not worship_can_approve() then
        raise exception 'Вести разделы может старший пуджари' using errcode = '42501';
    end if;
    if exists (select 1 from worship_articles where section_id = p_section) then
        raise exception 'В разделе есть статьи: его можно только скрыть';
    end if;
    delete from worship_sections where id = p_section;
    return jsonb_build_object('ok', true);
end $$;

-- ── 2. Порядок разделов — одной операцией ────────────────────────────────────
-- Клиент переставлял разделы построчными запросами: сбой на середине оставлял
-- перемешанный порядок. Заодно номера раздаются заново, как у статей.
create or replace function worship_section_reorder(p_section uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_раздел worship_sections%rowtype;
    v_мой    integer;
    v_сосед  uuid;
begin
    if not worship_can_approve() then
        raise exception 'Вести разделы может старший пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию вверх или вниз';
    end if;

    select * into v_раздел from worship_sections where id = p_section for update;
    if not found then raise exception 'Раздел не найден'; end if;

    perform 1 from worship_sections where kind = v_раздел.kind order by id for update;

    with упорядоченные as (
        select id, (row_number() over (order by sort_order, name_ru, id) - 1)::int as n
          from worship_sections where kind = v_раздел.kind
    )
    update worship_sections s
       set sort_order = у.n
      from упорядоченные у
     where s.id = у.id and s.sort_order is distinct from у.n;

    select sort_order into v_мой from worship_sections where id = p_section;
    select id into v_сосед from worship_sections
     where kind = v_раздел.kind and sort_order = v_мой + p_direction limit 1;

    if v_сосед is null then return jsonb_build_object('ok', true, 'край', true); end if;

    update worship_sections set sort_order = v_мой, updated_at = now() where id = v_сосед;
    update worship_sections set sort_order = v_мой + p_direction, updated_at = now() where id = p_section;

    return jsonb_build_object('ok', true);
end $$;

-- ── 3. Кто именно сохранил чужую правку ──────────────────────────────────────
-- ТЗ: система «говорит, кто сохранил правку». Отдавали время и текст, а имени
-- не было — человек не понимал, с кем ему договариваться.
create or replace function worship_save_draft(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_article   uuid := nullif(payload->>'article_id', '')::uuid;
    v_base      timestamptz := nullif(payload->>'base_updated_at', '')::timestamptz;
    v_known     boolean := coalesce((payload->>'base_known')::boolean, true);
    v_title     text := coalesce(nullif(btrim(payload->>'title'), ''), 'Без названия');
    v_kind      text := coalesce(nullif(payload->>'kind', ''), 'standard');
    v_version   worship_versions%rowtype;
    v_статья    worship_articles%rowtype;
    v_кто       text;
begin
    if not worship_can_write() then
        raise exception 'Писать стандарты может пуджари' using errcode = '42501';
    end if;

    if v_article is null then
        insert into worship_articles (kind, section_id, title, lang, status, created_by, updated_by)
        values (v_kind,
                nullif(payload->>'section_id', '')::uuid,
                v_title,
                coalesce(nullif(payload->>'lang', ''), 'ru'),
                case when v_kind = 'material' then 'published' else 'draft' end,
                auth.uid(), auth.uid())
        returning * into v_статья;
        v_article := v_статья.id;
    else
        select * into v_статья from worship_articles where id = v_article for update;
        if not found then raise exception 'Статья не найдена'; end if;
        if v_статья.status = 'archived' then
            raise exception 'Статья в архиве: сначала верните её из архива';
        end if;
    end if;

    select * into v_version from worship_versions
     where article_id = v_article and status in ('draft', 'submitted') for update;

    if found then
        if v_version.status = 'submitted' then
            raise exception 'Правка уже отправлена на утверждение: отзовите её, чтобы продолжить';
        end if;
        if v_known and v_base is distinct from v_version.updated_at then
            select coalesce(v.spiritual_name,
                            btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')),
                            'кто-то из отдела')
              into v_кто
              from vaishnavas v where v.user_id = v_version.created_by;

            return jsonb_build_object(
                'ok', false,
                'конфликт', true,
                'сообщение', case when v_base is null
                                  then 'Пока вы писали, черновик завёл кто-то другой'
                                  else 'Пока вы писали, черновик изменил кто-то другой' end,
                'чужая_версия', jsonb_build_object(
                    'обновлена', v_version.updated_at,
                    'кто', coalesce(v_кто, 'кто-то из отдела'),
                    'заголовок', v_version.title,
                    'текст', v_version.plain_text));
        end if;

        update worship_versions
           set title = v_title,
               doc = coalesce(payload->'doc', doc),
               plain_text = coalesce(payload->>'plain_text', plain_text),
               change_note = nullif(payload->>'change_note', ''),
               updated_at = now()
         where id = v_version.id
        returning * into v_version;
    else
        insert into worship_versions (article_id, status, title, doc, plain_text, change_note, created_by)
        values (v_article, 'draft', v_title,
                coalesce(payload->'doc', '{}'::jsonb),
                coalesce(payload->>'plain_text', ''),
                nullif(payload->>'change_note', ''),
                auth.uid())
        returning * into v_version;
    end if;

    update worship_articles
       set title = case when status = 'published' and v_kind <> 'material' then title else v_title end,
           section_id = case when payload ? 'section_id'
                             then nullif(payload->>'section_id', '')::uuid
                             else section_id end,
           updated_at = now(), updated_by = auth.uid()
     where id = v_article;

    if v_kind = 'material' and v_version.status = 'draft' then
        update worship_versions set status = 'superseded'
         where article_id = v_article and status = 'published';

        update worship_versions
           set status = 'published',
               version_no = coalesce((select max(version_no) + 1 from worship_versions
                                       where article_id = v_article and version_no is not null), 1),
               approved_at = now(), approved_by = auth.uid()
         where id = v_version.id
        returning * into v_version;

        update worship_articles
           set status = 'published', current_version_id = v_version.id
         where id = v_article;
    end if;

    return jsonb_build_object('ok', true, 'article_id', v_article,
                              'version_id', v_version.id,
                              'updated_at', v_version.updated_at);
end $$;

do $$
declare f text;
begin
    foreach f in array array['worship_save_draft(jsonb)', 'worship_section_delete(uuid)',
                             'worship_section_reorder(uuid,integer)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
