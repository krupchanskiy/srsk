-- Блок 1.6: события пишутся в жизненном цикле, утверждение пакетом,
-- замечания закрываются с пометкой.

-- ── запись события ────────────────────────────────────────────────────────────
-- event_key — то, чем событие отличается от собственного повтора. Повторный
-- вызов (двойной клик, повтор функции) молча ничего не добавляет.
create or replace function worship_event(
    p_kind text, p_article uuid, p_version uuid, p_remark uuid,
    p_recipient uuid, p_key text, p_payload jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path to 'public', 'pg_temp'
as $$
    insert into worship_notifications (kind, article_id, version_id, remark_id, recipient, event_key, payload)
    values (p_kind, p_article, p_version, p_remark, p_recipient, p_key, p_payload)
    on conflict (event_key) do nothing;
$$;

-- ── отправка на утверждение: событие старшим ──────────────────────────────────
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

    update worship_versions set status = 'submitted', updated_at = now() where id = v_version.id;
    update worship_articles
       set submitted_at = now(), submitted_by = auth.uid(),
           returned_at = null, returned_by = null, return_reason = null,
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

-- ── утверждение: событие в чат отдела ─────────────────────────────────────────
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
           approved_at = now(), approved_by = auth.uid(), updated_at = now()
     where id = v_version.id;

    update worship_articles
       set status = 'published', current_version_id = v_version.id, title = v_version.title,
           submitted_at = null, submitted_by = null,
           returned_at = null, returned_by = null, return_reason = null,
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    -- в общий чат отдела: получатель не указан, отправщик соберёт
    -- несколько утверждений подряд в одно сообщение
    perform worship_event('approved', p_article, v_version.id, null, null,
                          'approved:' || v_version.id,
                          jsonb_build_object('заголовок', v_version.title,
                                             'номер', v_номер,
                                             'примечание', v_version.change_note));

    return jsonb_build_object('ok', true, 'version_id', v_version.id, 'номер', v_номер);
end $$;

-- ── возврат автору: событие автору правки ─────────────────────────────────────
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

    update worship_versions set status = 'draft', updated_at = now() where id = v_version.id;
    update worship_articles
       set returned_at = now(), returned_by = auth.uid(), return_reason = btrim(p_reason),
           submitted_at = null, submitted_by = null,
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

-- ── утверждение пакетом ───────────────────────────────────────────────────────
-- Первое наполнение — это полсотни статей за вечер, и утверждать их по одной
-- старший не станет. Ошибка на одной статье не роняет остальные: отчёт
-- возвращается построчно.
create or replace function worship_approve_many(p_articles uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_id    uuid;
    v_ответ jsonb;
    v_итог  jsonb := '[]'::jsonb;
begin
    if not worship_can_approve() then
        raise exception 'Утверждать стандарты может старший пуджари' using errcode = '42501';
    end if;

    foreach v_id in array coalesce(p_articles, array[]::uuid[]) loop
        begin
            v_ответ := worship_approve(v_id);
            v_итог := v_итог || jsonb_build_object('article_id', v_id, 'ok', true,
                                                   'номер', v_ответ->'номер',
                                                   'повтор', coalesce(v_ответ->'повтор', 'false'::jsonb));
        exception when others then
            v_итог := v_итог || jsonb_build_object('article_id', v_id, 'ok', false, 'ошибка', sqlerrm);
        end;
    end loop;

    return jsonb_build_object('ok', true, 'строки', v_итог);
end $$;

-- ── замечания ─────────────────────────────────────────────────────────────────
create or replace function worship_remark_add(p_article uuid, p_body text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_remark   uuid;
    v_статья   worship_articles%rowtype;
    v_автор    uuid;
    v_кому     uuid;
begin
    if not worship_can_view() then
        raise exception 'Нет доступа к модулю' using errcode = '42501';
    end if;
    if coalesce(btrim(p_body), '') = '' then
        raise exception 'Пустое замечание ни о чём не говорит';
    end if;

    select * into v_статья from worship_articles where id = p_article;
    if not found then raise exception 'Статья не найдена'; end if;

    insert into worship_remarks (article_id, body, created_by)
    values (p_article, btrim(p_body), auth.uid())
    returning id into v_remark;

    -- автору последней версии и старшим: замечание без адресата умирает в списке
    select created_by into v_автор from worship_versions
     where article_id = p_article order by coalesce(approved_at, updated_at) desc limit 1;

    for v_кому in
        select distinct x from (
            select v_автор as x
            union select worship_holders('worship_approve')
        ) s where x is not null and x <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
    loop
        perform worship_event('remark', p_article, null, v_remark, v_кому,
                              'remark:' || v_remark || ':' || v_кому,
                              jsonb_build_object('заголовок', v_статья.title,
                                                 'текст', btrim(p_body)));
    end loop;

    return jsonb_build_object('ok', true, 'remark_id', v_remark);
end $$;

create or replace function worship_remark_close(p_remark uuid, p_state text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_замечание worship_remarks%rowtype;
begin
    if not worship_can_write() then
        raise exception 'Закрывать замечания может пуджари' using errcode = '42501';
    end if;
    if p_state not in ('accepted', 'declined') then
        raise exception 'Замечание закрывается пометкой «учтено» либо «не согласен»';
    end if;
    if p_state = 'declined' and coalesce(btrim(p_reason), '') = '' then
        raise exception 'Несогласие без одной строки «почему» выглядит как молчание';
    end if;

    select * into v_замечание from worship_remarks where id = p_remark for update;
    if not found then raise exception 'Замечание не найдено'; end if;
    if v_замечание.state <> 'open' then
        return jsonb_build_object('ok', true, 'повтор', true);
    end if;

    update worship_remarks
       set state = p_state, closed_at = now(), closed_by = auth.uid(),
           close_reason = nullif(btrim(coalesce(p_reason, '')), '')
     where id = p_remark;

    return jsonb_build_object('ok', true);
end $$;

-- ── права на исполнение ───────────────────────────────────────────────────────
do $$
declare f text;
begin
    foreach f in array array[
        'worship_submit(uuid)', 'worship_approve(uuid)', 'worship_return(uuid,text)',
        'worship_approve_many(uuid[])', 'worship_remark_add(uuid,text)',
        'worship_remark_close(uuid,text,text)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;

    -- внутренние: исполняются только из других функций и служебной ролью
    foreach f in array array['worship_event(text,uuid,uuid,uuid,uuid,text,jsonb)', 'worship_holders(text)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
    end loop;
end $$;
