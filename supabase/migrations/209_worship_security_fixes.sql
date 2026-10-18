-- Починки по итогам аудита прав.

-- ── 1. Текст от читателя уходит в телеграм без экранирования ─────────────────
-- tg_outbox_try отправляет с parse_mode=HTML, а замечание пишет любой, кто видит
-- модуль. Два следствия: произвольная кликабельная ссылка в сообщении от имени
-- бота ашрама (ровно то, ради чего отправку уводили из браузера), и потеря
-- уведомлений на обычных «<» и «&» — Telegram отвечает 400, строка помечается
-- failed, а события к тому моменту уже отмечены отправленными.
create or replace function worship_html(p_text text)
returns text
language sql immutable
as $$ select replace(replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') $$;

create or replace function worship_notify_pack(
    p_dry boolean default true,
    p_log boolean default true)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_batch   uuid := gen_random_uuid();
    v_строка  record;
    v_текст   text;
    v_часть   text;
    v_штук    integer;
    v_всего   integer := 0;
    v_писем   integer := 0;
    v_итог    jsonb := '[]'::jsonb;
    v_живьём  boolean;
    v_чат     bigint;
    v_адрес   bigint;
    v_ушло    boolean;
begin
    select coalesce(value = 'true', false) into v_живьём
      from worship_settings where key = 'notify_enabled';
    if not coalesce(v_живьём, false) then p_dry := true; end if;

    select nullif(value, '')::bigint into v_чат
      from worship_settings where key = 'department_chat_id';

    for v_строка in
        select n.recipient,
               array_agg(n.id order by n.created_at) as события,
               count(*) as штук
          from worship_notifications n
         where n.sent_at is null
         group by n.recipient
    loop
        v_текст := '';
        v_штук := v_строка.штук;

        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Утверждён стандарт «%s» (версия %s).%s',
                               worship_html(max(payload->>'заголовок')), max(payload->>'номер'),
                               coalesce(' ' || worship_html(max(payload->>'примечание')), ''))
                    else format('Утверждены стандарты (%s): %s.', count(*),
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'approved';
        if v_часть is not null then v_текст := v_текст || v_часть; end if;

        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Ждёт вашего решения: «%s».%s',
                               worship_html(max(payload->>'заголовок')),
                               coalesce(' ' || worship_html(max(payload->>'примечание')), ''))
                    else format('Ждут вашего решения (%s): %s.', count(*),
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'submitted';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select string_agg(format('Вернули на доработку «%s»: %s',
                                 worship_html(payload->>'заголовок'),
                                 worship_html(payload->>'причина')), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'returned';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select string_agg(format('Замечание к «%s»: %s',
                                 worship_html(payload->>'заголовок'),
                                 worship_html(payload->>'текст')), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'remark';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select case when count(*) = 0 then null
                    else format('Дольше месяца ждут решения: %s.',
                                string_agg(format('«%s»', worship_html(payload->>'заголовок')),
                                           ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'stale';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        v_текст := btrim(v_текст);
        if v_текст = '' then continue; end if;

        if v_строка.recipient is null then
            v_адрес := v_чат;
        else
            select telegram_chat_id into v_адрес from vaishnavas
             where user_id = v_строка.recipient and telegram_chat_id is not null;
        end if;

        v_ушло := not p_dry and v_адрес is not null;

        if p_log or v_ушло then
            insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
            values (v_batch, v_строка.recipient, v_текст, v_штук, not v_ушло);
        end if;

        if v_ушло then
            insert into tg_outbox (chat_id, text, kind) values (v_адрес, v_текст, 'worship');
            update worship_notifications
               set sent_at = now(), batch_id = v_batch
             where id = any(v_строка.события);
        end if;

        v_писем := v_писем + 1;
        v_всего := v_всего + v_штук;
        v_итог := v_итог || jsonb_build_object(
            'кому', coalesce(v_строка.recipient::text, 'чат отдела'),
            'адрес_есть', v_адрес is not null,
            'ушло', v_ушло,
            'событий', v_штук, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'batch_id', v_batch,
                              'писем', v_писем, 'событий', v_всего, 'сообщения', v_итог);
end $$;

revoke all on function worship_notify_pack(boolean, boolean) from public, anon, authenticated;
revoke all on function worship_html(text) from public, anon;

-- ── 2. Снимок должен открываться по тому же правилу, что и текст о нём ───────
-- Было: правило бакета. Читатель перечислял все пути и брал подписанную ссылку
-- на снимок из чужого черновика — картинка оказывалась доступна раньше текста.
drop policy if exists "worship files read" on storage.objects;
create policy "worship files read" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'worship'
        and worship_can_view()
        and (
            worship_can_write()                      -- отдел видит и незавершённое
            or exists (
                select 1
                  from worship_versions v,
                       lateral jsonb_array_elements(coalesce(v.doc->'blocks', '[]'::jsonb)) b
                 where v.status in ('published', 'superseded')
                   and b->>'path' = storage.objects.name)
        )
    );

-- ── 3. Замечание — только через функцию ──────────────────────────────────────
-- Прямая вставка позволяла подвесить замечание к невидимому черновику и обходила
-- запись события: обещание «замечание кого-то догоняет» не держалось.
drop policy if exists "worship remarks insert" on worship_remarks;

-- ── 4. Теневые копии состояния в статье ──────────────────────────────────────
-- submitted_at/by отдавались любому читателю и выдавали факт неутверждённой
-- правки, хотя сама правка ему не видна. Истина про отправку живёт в версии.
alter table worship_articles drop column if exists submitted_at;
alter table worship_articles drop column if exists submitted_by;

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

    if coalesce(btrim(v_version.change_note), '') = ''
       and exists (select 1 from worship_versions
                    where article_id = p_article and status in ('published', 'superseded')) then
        raise exception 'Напишите одной строкой, что изменилось';
    end if;

    update worship_versions
       set status = 'submitted', updated_at = now(),
           return_reason = null, returned_at = null, returned_by = null
     where id = v_version.id;

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;

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

create or replace function worship_return(p_article uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare v_version worship_versions%rowtype;
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

    update worship_articles set updated_at = now(), updated_by = auth.uid() where id = p_article;

    if v_version.created_by is not null and v_version.created_by <> auth.uid() then
        perform worship_event('returned', p_article, v_version.id, null, v_version.created_by,
                              'returned:' || v_version.id || ':' || extract(epoch from now())::bigint,
                              jsonb_build_object('заголовок', v_version.title,
                                                 'причина', btrim(p_reason)));
    end if;

    return jsonb_build_object('ok', true);
end $$;

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
           updated_at = now(), updated_by = auth.uid()
     where id = p_article;

    perform worship_event('approved', p_article, v_version.id, null, null,
                          'approved:' || v_version.id,
                          jsonb_build_object('заголовок', v_version.title,
                                             'номер', v_номер,
                                             'примечание', v_version.change_note));

    return jsonb_build_object('ok', true, 'version_id', v_version.id, 'номер', v_номер);
end $$;

do $$
declare f text;
begin
    foreach f in array array['worship_submit(uuid)', 'worship_approve(uuid)', 'worship_return(uuid,text)']
    loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to authenticated', f);
    end loop;
end $$;
