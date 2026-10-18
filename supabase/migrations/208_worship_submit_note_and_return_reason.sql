-- Две починки по итогам сверки с ТЗ.
--
-- 1. Регресс между 196 и 200: переписывая worship_submit ради событий, потеряли
--    проверку «что изменилось». Браузер её спрашивает, но функция выдана роли
--    вошедших, и прямой вызов давал правку действующего стандарта без строки
--    изменений — пустая история и пустое сообщение отделу.
--
-- 2. ТЗ относит причину возврата к тому, что видно только пуджари. Она лежала
--    в worship_articles, строка которой отдаётся любому сотруднику, и пряталась
--    в браузере — ровно тот класс ошибки, от которого ТЗ отдельно предупреждает.
--    Переносим её в версию: незавершённая версия и так видна только пуджари,
--    значит защита становится правилом доступа, а не поведением интерфейса.

alter table worship_versions add column if not exists return_reason text;
alter table worship_versions add column if not exists returned_at timestamptz;
alter table worship_versions add column if not exists returned_by uuid;

-- переносим то, что уже записано
update worship_versions v
   set return_reason = a.return_reason,
       returned_at = a.returned_at,
       returned_by = a.returned_by
  from worship_articles a
 where v.article_id = a.id
   and a.return_reason is not null
   and v.status in ('draft', 'submitted');

create or replace function worship_return(p_article uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_version worship_versions%rowtype;
begin
    if not worship_can_approve() then
        raise exception 'Возвращать правки может старший пуджари' using errcode = '42501';
    end if;
    if coalesce(btrim(p_reason), '') = '' then
        raise exception 'Без причины возврат бессмыслен: автор не поймёт, что поправить';
    end if;

    perform 1 from worship_articles where id = p_article for update;

    select * into v_version from worship_versions
     where article_id = p_article and status = 'submitted';
    if not found then raise exception 'На утверждении ничего нет'; end if;

    update worship_versions
       set status = 'draft', updated_at = now(),
           return_reason = btrim(p_reason), returned_at = now(), returned_by = auth.uid()
     where id = v_version.id;

    update worship_articles
       set submitted_at = null, submitted_by = null,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    if v_version.created_by is not null and v_version.created_by <> auth.uid() then
        perform worship_event('returned', p_article, v_version.id, null, v_version.created_by,
                              'returned:' || v_version.id || ':' || extract(epoch from now())::bigint,
                              jsonb_build_object('заголовок', v_version.title,
                                                 'причина', btrim(p_reason)));
    end if;

    return jsonb_build_object('ok', true);
end $$;

-- причина возврата живёт в версии и уходит вместе с ней: отправили заново —
-- замечание старшего больше не висит над текстом
create or replace function worship_submit(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_статья  worship_articles%rowtype;
    v_version worship_versions%rowtype;
    v_кому    uuid;
begin
    if not worship_can_write() then
        raise exception 'Отправлять на утверждение может пуджари' using errcode = '42501';
    end if;

    select * into v_статья from worship_articles where id = p_article for update;
    if not found then raise exception 'Статья не найдена'; end if;

    select * into v_version from worship_versions
     where article_id = p_article and status in ('draft', 'submitted');
    if not found then raise exception 'Отправлять нечего: черновика нет'; end if;

    if v_version.status = 'submitted' then
        return jsonb_build_object('ok', true, 'повтор', true, 'version_id', v_version.id);
    end if;

    -- правка действующего стандарта без строки «что изменилось» оставляет
    -- пустую историю и пустое сообщение отделу; у первой версии не спрашиваем
    if coalesce(btrim(v_version.change_note), '') = ''
       and exists (select 1 from worship_versions
                    where article_id = p_article and status in ('published', 'superseded')) then
        raise exception 'Напишите одной строкой, что изменилось';
    end if;

    update worship_versions
       set status = 'submitted', updated_at = now(),
           return_reason = null, returned_at = null, returned_by = null
     where id = v_version.id;

    update worship_articles
       set submitted_at = now(), submitted_by = auth.uid(),
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    for v_кому in select worship_holders('worship_approve') loop
        if v_кому <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid) then
            perform worship_event('submitted', p_article, v_version.id, null, v_кому,
                                  'submitted:' || v_version.id || ':' || v_кому,
                                  jsonb_build_object('заголовок', v_version.title,
                                                     'примечание', v_version.change_note));
        end if;
    end loop;

    return jsonb_build_object('ok', true, 'version_id', v_version.id);
end $$;

-- утверждение больше не чистит причину возврата в статье: её там нет
create or replace function worship_approve(p_article uuid)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
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
           approved_at = now(), approved_by = auth.uid(), updated_at = now(),
           return_reason = null, returned_at = null, returned_by = null
     where id = v_version.id;

    update worship_articles
       set status = 'published', current_version_id = v_version.id, title = v_version.title,
           submitted_at = null, submitted_by = null,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    perform worship_event('approved', p_article, v_version.id, null, null,
                          'approved:' || v_version.id,
                          jsonb_build_object('заголовок', v_version.title,
                                             'номер', v_номер,
                                             'примечание', v_version.change_note));

    return jsonb_build_object('ok', true, 'version_id', v_version.id, 'номер', v_номер);
end $$;

alter table worship_articles drop column if exists return_reason;
alter table worship_articles drop column if exists returned_at;
alter table worship_articles drop column if exists returned_by;

do $$
declare f text;
begin
    foreach f in array array['worship_submit(uuid)', 'worship_approve(uuid)', 'worship_return(uuid,text)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
