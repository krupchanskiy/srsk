-- Починка проверки параллельной правки, замеченная при сборке редактора.
--
-- Было: отметка времени черновика сверялась, только если её прислали. Но есть
-- случай, когда её не бывает по определению — пуджари открыл ДЕЙСТВУЮЩИЙ текст,
-- черновика ещё нет. Пока он писал, второй создал черновик из того же текста;
-- первое же сохранение затирало чужую работу молча — ровно то, чего проверка
-- должна не допускать.
--
-- Стало: клиент сообщает, что именно он видел при открытии:
--   base_known = true  — «я знаю состояние», и тогда:
--       base_updated_at = отметка черновика, либо отсутствует, если черновика не было;
--   base_known = false — сознательная перезапись поверх чужого («сохранить моё»).
create or replace function worship_save_draft(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_article   uuid := nullif(payload->>'article_id', '')::uuid;
    v_base      timestamptz := nullif(payload->>'base_updated_at', '')::timestamptz;
    v_known     boolean := coalesce((payload->>'base_known')::boolean, payload ? 'base_updated_at');
    v_title     text := coalesce(nullif(btrim(payload->>'title'), ''), 'Без названия');
    v_kind      text := coalesce(nullif(payload->>'kind', ''), 'standard');
    v_version   worship_versions%rowtype;
    v_статья    worship_articles%rowtype;
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
        -- чужая правка между открытием и сохранением: либо черновик изменился,
        -- либо он появился у того, кто начинал с действующего текста
        if v_known and v_base is distinct from v_version.updated_at then
            return jsonb_build_object(
                'ok', false,
                'конфликт', true,
                'сообщение', case when v_base is null
                                  then 'Пока вы писали, черновик завёл кто-то другой'
                                  else 'Пока вы писали, черновик изменил кто-то другой' end,
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
    -- у действующей статьи заголовок меняется только утверждением.
    -- Раздел снимается тоже: ключ прислан — значит выбор сделан осознанно.
    update worship_articles
       set title = case when status = 'published' then title else v_title end,
           section_id = case when payload ? 'section_id'
                             then nullif(payload->>'section_id', '')::uuid
                             else section_id end,
           updated_at = now(), updated_by = auth.uid()
     where id = v_article;

    return jsonb_build_object('ok', true, 'article_id', v_article,
                              'version_id', v_version.id,
                              'updated_at', v_version.updated_at);
end $$;

revoke all on function worship_save_draft(jsonb) from public, anon, authenticated;
grant execute on function worship_save_draft(jsonb) to authenticated;
