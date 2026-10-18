-- Чужую работу решает автор или старший, а не любой пуджари.
-- Решение Адриана 19.10.2026 («нет» на вопрос «так и задумано?»).
--
-- Было: любой с правом записи мог
--   * отозвать с утверждения чужую правку (worship_withdraw);
--   * удалить чужой черновик новой статьи (worship_delete_draft);
--   * сменить раздел и описание ДЕЙСТВУЮЩЕГО стандарта без утверждения —
--     через сохранение черновика (worship_save_draft): эти поля пишутся
--     прямо в статью, мимо очереди на утверждение.
-- Стало: первые два — автор или старший; третье — только старший.
-- Сам текст правки по-прежнему пишут сообща: это не меняется.

create or replace function public.worship_withdraw(p_article uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set timezone to 'Asia/Kolkata'
as $function$
declare v_version worship_versions%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Отзывать правку может пуджари' using errcode = '42501';
    end if;

    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;

    -- отозвать с утверждения — решение автора правки или старшего:
    -- иначе любой мог снять чужую работу со стола у старшего
    if v_version.created_by is distinct from auth.uid() and not worship_can_approve() then
        raise exception 'Отозвать правку может её автор или старший пуджари' using errcode = '42501';
    end if;

    update worship_versions set status = 'draft', updated_at = now() where id = v_version.id;

    -- письмо о том, чего больше нет на столе, только сбивает
    delete from worship_notifications
     where kind = 'submitted' and version_id = v_version.id and sent_at is null;

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;
    return jsonb_build_object('ok', true);
end $function$;

create or replace function public.worship_delete_draft(p_article uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set timezone to 'Asia/Kolkata'
as $function$
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
    if v_статья.created_by is distinct from auth.uid() and not worship_can_approve() then
        raise exception 'Удалить черновик может его автор или старший пуджари' using errcode = '42501';
    end if;

    delete from worship_articles where id = p_article;
    return jsonb_build_object('ok', true);
end $function$;

-- worship_save_draft: правим живое определение, вставляя одну проверку
-- сразу после загрузки статьи (полный текст функции — в 253/254)
do $$
declare
    тело text := pg_get_functiondef('public.worship_save_draft(jsonb)'::regprocedure);
    якорь text := E'        v_kind := v_статья.kind;\n    end if;';
    вставка text := E'        v_kind := v_статья.kind;\n'
        || E'        -- раздел и описание действующего стандарта пишутся прямо в статью,\n'
        || E'        -- мимо утверждения, поэтому менять их может только старший\n'
        || E'        if v_статья.status = ''published'' and v_статья.kind = ''standard''\n'
        || E'           and not worship_can_approve()\n'
        || E'           and ((payload ? ''section_id''\n'
        || E'                 and nullif(payload->>''section_id'', '''')::uuid is distinct from v_статья.section_id)\n'
        || E'             or (payload ? ''summary''\n'
        || E'                 and nullif(btrim(payload->>''summary''), '''') is distinct from v_статья.summary)) then\n'
        || E'            raise exception ''Раздел и описание действующего стандарта меняет старший пуджари''\n'
        || E'                using errcode = ''42501'';\n'
        || E'        end if;\n'
        || E'    end if;';
begin
    if position(якорь in тело) = 0 then
        raise exception 'worship_save_draft изменилась: не найдено место для проверки';
    end if;
    execute replace(тело, якорь, вставка);
end $$;
