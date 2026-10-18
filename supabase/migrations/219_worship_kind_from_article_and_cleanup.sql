-- Главное здесь — дыра в обход утверждения, найденная контрольной проверкой.
--
-- worship_save_draft брала вид записи из присланного запроса. Для материала
-- библиотеки версия становится действующей сразу, без утверждения, — значит
-- любой пуджари мог сохранить ОБЫЧНЫЙ стандарт, подставив в запрос
-- kind = 'material', и текст тут же вставал в строй мимо старшего. Публичный
-- ключ делает это доступным из консоли браузера.
--
-- Теперь вид берётся из самой статьи, а из запроса — только при её создании.
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
    if v_kind not in ('standard', 'material') then
        raise exception 'Неизвестный вид записи';
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
        -- вид записи — свойство самой статьи, а не присланного запроса
        v_kind := v_статья.kind;
    end if;

    select * into v_version from worship_versions
     where article_id = v_article and status in ('draft', 'submitted') for update;

    if found then
        if v_version.status = 'submitted' then
            raise exception 'Правка уже отправлена на утверждение: отзовите её, чтобы продолжить';
        end if;
        if v_known and v_base is distinct from v_version.updated_at then
            select coalesce(v.spiritual_name,
                            nullif(btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
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

-- ── порядок: архивные тоже получают номера, но в конце ───────────────────────
-- Иначе после возврата из архива статья встаёт в список по заголовку,
-- а не по замыслу: её sort_order так и остался нулевым.
create or replace function worship_reorder(p_article uuid, p_direction integer)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья worship_articles%rowtype;
    v_мой    integer;
    v_сосед  uuid;
begin
    if not worship_can_write() then
        raise exception 'Менять порядок статей может пуджари' using errcode = '42501';
    end if;
    if p_direction not in (-1, 1) then
        raise exception 'Двигать можно на одну позицию вверх или вниз';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        raise exception 'Отменённые стандарты в списке не переставляют';
    end if;

    perform 1 from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
     order by id
     for update;

    -- действующие и черновики идут по порядку, отменённые — следом за ними
    with упорядоченные as (
        select id, (row_number() over (
                        order by (status = 'archived'), sort_order, title, id) - 1)::int as n
          from worship_articles
         where kind = v_статья.kind
           and section_id is not distinct from v_статья.section_id
    )
    update worship_articles a
       set sort_order = у.n
      from упорядоченные у
     where a.id = у.id and a.sort_order is distinct from у.n;

    select sort_order into v_мой from worship_articles where id = p_article;

    select id into v_сосед
      from worship_articles
     where kind = v_статья.kind
       and section_id is not distinct from v_статья.section_id
       and status <> 'archived'
       and sort_order = v_мой + p_direction
     limit 1;

    if v_сосед is null then return jsonb_build_object('ok', true, 'край', true); end if;

    update worship_articles set sort_order = v_мой, updated_at = now() where id = v_сосед;
    update worship_articles set sort_order = v_мой + p_direction, updated_at = now() where id = p_article;

    return jsonb_build_object('ok', true, 'позиция', v_мой + p_direction);
end $$;

-- ── внутренние функции закрываем и от вошедших ───────────────────────────────
revoke all on function worship_html(text) from public, anon, authenticated;
revoke all on function worship_cut(text, integer) from public, anon, authenticated;

do $$
declare f text;
begin
    foreach f in array array['worship_save_draft(jsonb)', 'worship_reorder(uuid,integer)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
