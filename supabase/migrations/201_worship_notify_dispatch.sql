-- Блок 1.6: отправщик.
--
-- Отправщик группирует, а не шлёт по событию на сообщение: несколько утверждений
-- подряд — одно сообщение в чат отдела, несколько замечаний за вечер — одно письмо
-- человеку. Событие в таблице и сообщение в чате — разные вещи.
--
-- Пока чат отдела не подключён, функция работает вхолостую: собирает текст,
-- пишет его в журнал и НЕ помечает события отправленными. Так видно, что ушло бы.

create or replace function worship_notify_pack(p_dry boolean default true)
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_batch   uuid := gen_random_uuid();
    v_строка  record;
    v_текст   text;
    v_штук    integer;
    v_всего   integer := 0;
    v_писем   integer := 0;
    v_итог    jsonb := '[]'::jsonb;
begin
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

        -- утверждения: одной строкой, даже если их двадцать
        select case when count(*) = 0 then ''
                    when count(*) = 1 then
                        format('Утверждён стандарт «%s» (версия %s).%s',
                               max(payload->>'заголовок'), max(payload->>'номер'),
                               coalesce(' ' || max(payload->>'примечание'), ''))
                    else format('Утверждены стандарты (%s): %s.', count(*),
                                string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
               end
          into v_текст
          from worship_notifications
         where id = any(v_строка.события) and kind = 'approved';

        -- ждут решения
        v_текст := v_текст || coalesce((
            select case when count(*) = 0 then null
                        when count(*) = 1 then
                            format(E'\nЖдёт вашего решения: «%s».%s', max(payload->>'заголовок'),
                                   coalesce(' ' || max(payload->>'примечание'), ''))
                        else format(E'\nЖдут вашего решения (%s): %s.', count(*),
                                    string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
                   end
              from worship_notifications
             where id = any(v_строка.события) and kind = 'submitted'), '');

        -- возвраты: причина важнее краткости, поэтому по одной строке на каждый
        v_текст := v_текст || coalesce((
            select string_agg(format(E'\nВернули на доработку «%s»: %s',
                                     payload->>'заголовок', payload->>'причина'), '' order by created_at)
              from worship_notifications
             where id = any(v_строка.события) and kind = 'returned'), '');

        -- замечания
        v_текст := v_текст || coalesce((
            select string_agg(format(E'\nЗамечание к «%s»: %s',
                                     payload->>'заголовок', payload->>'текст'), '' order by created_at)
              from worship_notifications
             where id = any(v_строка.события) and kind = 'remark'), '');

        -- висят дольше месяца
        v_текст := v_текст || coalesce((
            select format(E'\nДольше месяца ждут решения: %s.',
                          string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
              from worship_notifications
             where id = any(v_строка.события) and kind = 'stale'), '');

        v_текст := btrim(v_текст);
        if v_текст = '' then continue; end if;

        insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
        values (v_batch, v_строка.recipient, v_текст, v_штук, p_dry);

        if not p_dry then
            update worship_notifications
               set sent_at = now(), batch_id = v_batch
             where id = any(v_строка.события);
        end if;

        v_писем := v_писем + 1;
        v_всего := v_всего + v_штук;
        v_итог := v_итог || jsonb_build_object(
            'кому', coalesce(v_строка.recipient::text, 'чат отдела'),
            'событий', v_штук, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'batch_id', v_batch,
                              'писем', v_писем, 'событий', v_всего, 'сообщения', v_итог);
end $$;

-- ── зависшие дольше месяца ────────────────────────────────────────────────────
-- Раз в месяц напоминают о себе автору и старшему. Иначе очередь превращается
-- в свалку, на которую перестают смотреть. Ключ события содержит месяц,
-- поэтому повторный запуск в том же месяце ничего не добавляет.
create or replace function worship_notify_stale()
returns jsonb
language plpgsql security definer set search_path to 'public', 'pg_temp'
as $$
declare
    v_строка record;
    v_кому   uuid;
    v_метка  text := to_char(now(), 'YYYY-MM');
    v_штук   integer := 0;
begin
    for v_строка in
        select v.id, v.article_id, v.title, v.created_by, v.updated_at
          from worship_versions v
         where v.status = 'submitted' and v.updated_at < now() - interval '30 days'
    loop
        for v_кому in
            select distinct x from (
                select v_строка.created_by as x
                union select worship_holders('worship_approve')
            ) s where x is not null
        loop
            perform worship_event('stale', v_строка.article_id, v_строка.id, null, v_кому,
                                  'stale:' || v_строка.id || ':' || v_кому || ':' || v_метка,
                                  jsonb_build_object('заголовок', v_строка.title,
                                                     'ждёт_с', v_строка.updated_at));
            v_штук := v_штук + 1;
        end loop;
    end loop;

    return jsonb_build_object('ok', true, 'событий', v_штук);
end $$;

-- Служебные: из браузера их не вызывают. Запускает расписание базы
-- под служебной ролью.
revoke all on function worship_notify_pack(boolean) from public, anon, authenticated;
revoke all on function worship_notify_stale() from public, anon, authenticated;
