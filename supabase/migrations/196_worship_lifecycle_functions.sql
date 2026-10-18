-- Блок 1.3: жизненный цикл статьи. Единственный способ менять статусы и версии.
--
-- Общие правила, одинаковые во всех функциях:
--   * право проверяется внутри, а не в интерфейсе;
--   * статью берём FOR UPDATE до всякой проверки состояния, иначе двое могут
--     утвердить одну правку одновременно и получить две действующие версии;
--   * повтор не ломает и не удваивает: утверждение уже утверждённого возвращает
--     тот же ответ, а не вторую версию и второе сообщение отделу.

-- ── сохранение черновика ──────────────────────────────────────────────────────
-- Создаёт статью, если её ещё нет. Черновик у статьи один: он перезаписывается.
-- base_updated_at — отметка времени, с которой начинали править: если черновик
-- за это время изменил кто-то другой, работа не затирается, а возвращается отказ
-- с данными о чужой правке.
create or replace function worship_save_draft(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_article uuid := nullif(payload->>'article_id', '')::uuid;
    v_base    timestamptz := nullif(payload->>'base_updated_at', '')::timestamptz;
    v_title   text := coalesce(nullif(btrim(payload->>'title'), ''), 'Без названия');
    v_kind    text := coalesce(nullif(payload->>'kind', ''), 'standard');
    v_version worship_versions%rowtype;
    v_статья  worship_articles%rowtype;
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
        -- чужая правка между открытием и сохранением
        if v_base is not null and v_version.updated_at <> v_base then
            return jsonb_build_object(
                'ok', false,
                'конфликт', true,
                'сообщение', 'Пока вы писали, черновик изменил кто-то другой',
                'чужая_версия', jsonb_build_object(
                    'обновлена', v_version.updated_at,
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

    -- заголовок в статье держим в ногу с черновиком, пока статья не опубликована:
    -- у действующей статьи заголовок меняется только утверждением
    update worship_articles
       set title = case when status = 'published' then title else v_title end,
           section_id = coalesce(nullif(payload->>'section_id', '')::uuid, section_id),
           updated_at = now(), updated_by = auth.uid()
     where id = v_article;

    return jsonb_build_object('ok', true, 'article_id', v_article,
                              'version_id', v_version.id,
                              'updated_at', v_version.updated_at);
end $$;

-- ── отправка на утверждение и отзыв ───────────────────────────────────────────
create or replace function worship_submit(p_article uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_version worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Отправить правку может пуджари' using errcode = '42501';
    end if;
    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status in ('draft', 'submitted');
    if not found then raise exception 'Нечего отправлять: черновика нет'; end if;
    if v_version.status = 'submitted' then
        return jsonb_build_object('ok', true, 'повтор', true, 'version_id', v_version.id);
    end if;
    if coalesce(btrim(v_version.change_note), '') = ''
       and exists (select 1 from worship_versions
                    where article_id = p_article and status = 'published') then
        raise exception 'Заполните «что изменилось» — эта строка попадёт в историю и в сообщение отделу';
    end if;

    update worship_versions set status = 'submitted', updated_at = now() where id = v_version.id;
    update worship_articles
       set submitted_at = now(), submitted_by = auth.uid(),
           returned_at = null, returned_by = null, return_reason = null,
           updated_at = now()
     where id = p_article;

    return jsonb_build_object('ok', true, 'version_id', v_version.id);
end $$;

create or replace function worship_withdraw(p_article uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_version worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Отозвать правку может пуджари' using errcode = '42501';
    end if;
    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;

    update worship_versions set status = 'draft', updated_at = now() where id = v_version.id;
    update worship_articles set submitted_at = null, submitted_by = null, updated_at = now()
     where id = p_article;

    return jsonb_build_object('ok', true, 'version_id', v_version.id);
end $$;

-- ── утверждение ───────────────────────────────────────────────────────────────
create or replace function worship_approve(p_article uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья  worship_articles%rowtype;
    v_version worship_versions%rowtype;
    v_номер   integer;
begin
    if not worship_can_approve() then
        raise exception 'Утверждать стандарты может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';

    if not found then
        -- повтор: утверждать нечего, но и ошибки нет — отдаём действующую версию
        select * into v_version from worship_versions
         where article_id = p_article and status = 'published';
        if found then
            return jsonb_build_object('ok', true, 'повтор', true,
                                      'version_id', v_version.id, 'номер', v_version.version_no);
        end if;
        raise exception 'На утверждении ничего нет';
    end if;

    select coalesce(max(version_no), 0) + 1 into v_номер
      from worship_versions where article_id = p_article;

    update worship_versions set status = 'superseded'
     where article_id = p_article and status = 'published';

    update worship_versions
       set status = 'published', version_no = v_номер,
           approved_at = now(), approved_by = auth.uid(), updated_at = now()
     where id = v_version.id;

    update worship_articles
       set status = 'published', current_version_id = v_version.id, title = v_version.title,
           submitted_at = null, submitted_by = null,
           returned_at = null, returned_by = null, return_reason = null,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    return jsonb_build_object('ok', true, 'version_id', v_version.id, 'номер', v_номер);
end $$;

-- ── возврат автору ────────────────────────────────────────────────────────────
create or replace function worship_return(p_article uuid, p_reason text)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_version worship_versions%rowtype;
begin
    if not worship_can_approve() then
        raise exception 'Возвращать правки может старший пуджари' using errcode = '42501';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
        raise exception 'Назовите причину возврата: без неё автор не поймёт, что поправить';
    end if;

    perform 1 from worship_articles where id = p_article for update;
    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then raise exception 'На утверждении ничего нет'; end if;

    update worship_versions set status = 'draft', updated_at = now() where id = v_version.id;
    update worship_articles
       set returned_at = now(), returned_by = auth.uid(), return_reason = btrim(p_reason),
           submitted_at = null, submitted_by = null, updated_at = now()
     where id = p_article;

    return jsonb_build_object('ok', true, 'version_id', v_version.id);
end $$;

-- ── архив и возврат из архива ─────────────────────────────────────────────────
create or replace function worship_archive(p_article uuid, p_reason text, p_replaced_by uuid default null)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_статья worship_articles%rowtype;
begin
    if not worship_can_approve() then
        raise exception 'Архивировать может старший пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status = 'archived' then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;
    if v_статья.status <> 'published' then
        raise exception 'В архив уходит действующий стандарт, а этот ещё не утверждался';
    end if;
    if p_replaced_by is not null and p_replaced_by = p_article then
        raise exception 'Статья не может заменять саму себя';
    end if;

    update worship_articles
       set status = 'archived', archived_at = now(), archived_by = auth.uid(),
           archive_reason = nullif(btrim(p_reason), ''), replaced_by_id = p_replaced_by,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    return jsonb_build_object('ok', true);
end $$;

create or replace function worship_unarchive(p_article uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
    if not worship_can_approve() then
        raise exception 'Вернуть из архива может старший пуджари' using errcode = '42501';
    end if;
    update worship_articles
       set status = 'published', archived_at = null, archived_by = null,
           archive_reason = null, replaced_by_id = null,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article and status = 'archived';
    if not found then raise exception 'Статья не в архиве'; end if;
    return jsonb_build_object('ok', true);
end $$;

-- ── вернуть прежнюю версию в черновик ─────────────────────────────────────────
-- Молча подменить действующий стандарт нельзя: старый текст становится черновиком
-- и проходит утверждение обычным порядком.
create or replace function worship_restore_version(p_version uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_исходник worship_versions%rowtype;
    v_черновик worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Вернуть прежнюю версию может пуджари' using errcode = '42501';
    end if;

    select * into v_исходник from worship_versions where id = p_version;
    if not found then raise exception 'Версия не найдена'; end if;
    if v_исходник.status = 'draft' then raise exception 'Это и есть черновик'; end if;

    perform 1 from worship_articles where id = v_исходник.article_id for update;

    select * into v_черновик from worship_versions
     where article_id = v_исходник.article_id and status in ('draft', 'submitted');
    if found and v_черновик.status = 'submitted' then
        raise exception 'Правка уже отправлена на утверждение: отзовите её';
    end if;

    if found then
        update worship_versions
           set title = v_исходник.title, doc = v_исходник.doc, plain_text = v_исходник.plain_text,
               change_note = format('возврат к версии %s', v_исходник.version_no), updated_at = now()
         where id = v_черновик.id
        returning * into v_черновик;
    else
        insert into worship_versions (article_id, status, title, doc, plain_text, change_note, created_by)
        values (v_исходник.article_id, 'draft', v_исходник.title, v_исходник.doc, v_исходник.plain_text,
                format('возврат к версии %s', v_исходник.version_no), auth.uid())
        returning * into v_черновик;
    end if;

    return jsonb_build_object('ok', true, 'version_id', v_черновик.id);
end $$;

-- ── удаление черновика ────────────────────────────────────────────────────────
-- Только у статьи, которая никогда не действовала: утверждённое не удаляется.
create or replace function worship_delete_draft(p_article uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_статья worship_articles%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Удалить черновик может пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;
    if v_статья.status <> 'draft' then
        raise exception 'У этой статьи уже была действующая версия: её можно только архивировать';
    end if;

    delete from worship_articles where id = p_article;
    return jsonb_build_object('ok', true);
end $$;

-- ── права на исполнение ───────────────────────────────────────────────────────
-- Supabase выдаёт EXECUTE роли authenticated по умолчанию, и отзыв у public
-- с anon этого не снимает: отзываем у всех и выдаём явно.
do $$
declare f text;
begin
    foreach f in array array[
        'worship_save_draft(jsonb)', 'worship_submit(uuid)', 'worship_withdraw(uuid)',
        'worship_approve(uuid)', 'worship_return(uuid,text)',
        'worship_archive(uuid,text,uuid)', 'worship_unarchive(uuid)',
        'worship_restore_version(uuid)', 'worship_delete_draft(uuid)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
