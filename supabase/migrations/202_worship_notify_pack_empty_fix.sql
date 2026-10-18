-- Починка, замеченная на сухом прогоне: в письме появлялась строка
-- «Дольше месяца ждут решения: .» даже когда таких правок не было.
-- Агрегат по пустой выборке возвращает строку с NULL внутри, а format()
-- превращает её в текст — coalesce снаружи уже ничего не спасает.
-- Пустоту надо ловить до форматирования, как в остальных ветках.
create or replace function worship_notify_pack(p_dry boolean default true)
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
        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Утверждён стандарт «%s» (версия %s).%s',
                               max(payload->>'заголовок'), max(payload->>'номер'),
                               coalesce(' ' || max(payload->>'примечание'), ''))
                    else format('Утверждены стандарты (%s): %s.', count(*),
                                string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'approved';
        if v_часть is not null then v_текст := v_текст || v_часть; end if;

        -- ждут решения
        select case when count(*) = 0 then null
                    when count(*) = 1 then
                        format('Ждёт вашего решения: «%s».%s', max(payload->>'заголовок'),
                               coalesce(' ' || max(payload->>'примечание'), ''))
                    else format('Ждут вашего решения (%s): %s.', count(*),
                                string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'submitted';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        -- возвраты: причина важнее краткости, поэтому по строке на каждый
        select string_agg(format('Вернули на доработку «%s»: %s',
                                 payload->>'заголовок', payload->>'причина'), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'returned';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        -- замечания
        select string_agg(format('Замечание к «%s»: %s',
                                 payload->>'заголовок', payload->>'текст'), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'remark';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        -- висят дольше месяца
        select case when count(*) = 0 then null
                    else format('Дольше месяца ждут решения: %s.',
                                string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'stale';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

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

revoke all on function worship_notify_pack(boolean) from public, anon, authenticated;
