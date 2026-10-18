-- Поля карточки материала (о чём, автор, откуда взято) писались из браузера
-- обычным update — а политик записи у worship_articles нет вовсе. Запрос
-- проходил без ошибки и не менял ни строки: человек видел «сохранено»,
-- а в библиотеке оставался материал без описания.
--
-- Теперь они идут через ту же функцию, что и текст. Заодно описание стало
-- обязательным на сервере: без него библиотека за полгода превращается
-- в свалку файлов — это прямое требование ТЗ, и держать его только
-- в браузере нельзя.
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
        v_kind := v_статья.kind;
    end if;

    -- у материала описание обязательно
    if v_kind = 'material'
       and coalesce(btrim(coalesce(payload->>'summary', v_статья.summary, '')), '') = '' then
        raise exception 'Напишите одной фразой, о чём материал';
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
           summary = case when payload ? 'summary'
                          then nullif(btrim(payload->>'summary'), '') else summary end,
           author_name = case when payload ? 'author_name'
                              then nullif(btrim(payload->>'author_name'), '') else author_name end,
           source = case when payload ? 'source'
                         then nullif(btrim(payload->>'source'), '') else source end,
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

revoke all on function worship_save_draft(jsonb) from public, anon, authenticated;
grant execute on function worship_save_draft(jsonb) to authenticated;
