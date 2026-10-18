-- Замечено сразу после 203: отправка по расписанию раз в полчаса при выключенном
-- рубильнике писала бы в журнал одни и те же неотправленные письма, и за сутки
-- он превратился бы в сорок восемь копий одного текста.
--
-- Поэтому запись в журнал теперь отделена от прогона: по расписанию пишем только
-- то, что действительно ушло (или не ушло из-за отсутствия адреса), а ручной
-- сухой прогон — пишет всё, он для того и нужен.
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
                               max(payload->>'заголовок'), max(payload->>'номер'),
                               coalesce(' ' || max(payload->>'примечание'), ''))
                    else format('Утверждены стандарты (%s): %s.', count(*),
                                string_agg(format('«%s»', payload->>'заголовок'), ', ' order by created_at))
               end
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'approved';
        if v_часть is not null then v_текст := v_текст || v_часть; end if;

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

        select string_agg(format('Вернули на доработку «%s»: %s',
                                 payload->>'заголовок', payload->>'причина'), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'returned';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

        select string_agg(format('Замечание к «%s»: %s',
                                 payload->>'заголовок', payload->>'текст'), E'\n' order by created_at)
          into v_часть
          from worship_notifications
         where id = any(v_строка.события) and kind = 'remark';
        if v_часть is not null then v_текст := btrim(v_текст || E'\n' || v_часть, E'\n'); end if;

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

drop function if exists worship_notify_pack(boolean);
revoke all on function worship_notify_pack(boolean, boolean) from public, anon, authenticated;

select cron.unschedule('worship-notify');
select cron.schedule('worship-notify', '*/30 * * * *', 'select public.worship_notify_pack(false, false)');
