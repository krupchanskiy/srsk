-- Блок 1.6: доставка собранных писем.
--
-- Труба в телеграм в проекте уже есть: tg_outbox + tg_outbox_flush раз в пять
-- секунд. Личный адрес берётся из карточки вайшнава, общий чат отдела — из
-- настройки ниже, потому что чата ещё нет.
--
-- Рассылка выключена рубильником и до его включения работает вхолостую:
-- собирает текст, пишет в журнал, события оставляет неотправленными. Это
-- даёт сухой прогон на боевых данных, не рассылая ничего живым людям.
create table if not exists worship_settings (
    key        text primary key,
    value      text,
    comment    text,
    updated_at timestamptz not null default now(),
    updated_by uuid
);

insert into worship_settings (key, value, comment) values
    ('notify_enabled', 'false', 'Рубильник рассылки. Пока false — всё уходит только в журнал.'),
    ('department_chat_id', null, 'Чат пуджарского отдела в телеграме для сводных сообщений.')
on conflict (key) do nothing;

alter table worship_settings enable row level security;
create policy "worship settings view" on worship_settings for select
    using (worship_can_approve());

-- ── отправщик с доставкой ─────────────────────────────────────────────────────
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
    v_живьём  boolean;
    v_чат     bigint;
    v_адрес   bigint;
begin
    -- рубильник сильнее аргумента: пока рассылка выключена, боевого режима нет
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

        -- куда уйдёт: личный адрес из карточки вайшнава либо общий чат отдела
        if v_строка.recipient is null then
            v_адрес := v_чат;
        else
            select telegram_chat_id into v_адрес from vaishnavas
             where user_id = v_строка.recipient and telegram_chat_id is not null;
        end if;

        insert into worship_notification_log (batch_id, recipient, message, events, dry_run)
        values (v_batch, v_строка.recipient, v_текст, v_штук, p_dry or v_адрес is null);

        -- без адреса письмо остаётся в журнале и ждёт: человек не подключил бота,
        -- чат отдела не заведён. Событие при этом не считается отправленным.
        if not p_dry and v_адрес is not null then
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
            'событий', v_штук, 'текст', v_текст);
    end loop;

    return jsonb_build_object('ok', true, 'сухой_прогон', p_dry, 'batch_id', v_batch,
                              'писем', v_писем, 'событий', v_всего, 'сообщения', v_итог);
end $$;

revoke all on function worship_notify_pack(boolean) from public, anon, authenticated;

-- ── расписание ────────────────────────────────────────────────────────────────
-- Напоминание о зависших — первого числа. Отправка — каждые полчаса: пока
-- рубильник выключен, она ничего не делает, кроме записи в журнал, а после
-- включения не придётся ничего заводить.
select cron.schedule('worship-stale-monthly', '0 3 1 * *', 'select public.worship_notify_stale()');
select cron.schedule('worship-notify', '*/30 * * * *', 'select public.worship_notify_pack(false)');
