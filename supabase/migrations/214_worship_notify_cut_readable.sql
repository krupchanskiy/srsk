-- Поправка к 213: обрезка длинного письма оборвалась на полуслове
-- («…стандарта номер 8»), потому что искала перевод строки, которого
-- в сводке-перечислении нет. Режем по последнему разделителю — переводу
-- строки, запятой или пробелу, что ближе к пределу.
create or replace function worship_cut(p_text text, p_limit integer default 3900)
returns text
language plpgsql immutable
as $$
declare
    v_кусок text;
    v_место integer;
begin
    if p_text is null or length(p_text) <= p_limit then return p_text; end if;

    v_кусок := left(p_text, p_limit);
    v_место := greatest(
        coalesce(length(v_кусок) - strpos(reverse(v_кусок), E'\n') + 1, 0),
        coalesce(length(v_кусок) - strpos(reverse(v_кусок), ', ') + 1, 0),
        coalesce(length(v_кусок) - strpos(reverse(v_кусок), ' ') + 1, 0));

    if v_место < p_limit / 2 then v_место := p_limit; end if;   -- разделителя нет вовсе

    return btrim(btrim(left(v_кусок, v_место), ' ,' || E'\n'))
           || E'\n… и ещё. Весь список — в модуле «Поклонение».';
end $$;

revoke all on function worship_cut(text, integer) from public, anon;

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
    v_старьё  integer := 0;
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

    if not p_dry then
        update worship_notifications
           set sent_at = now(), batch_id = v_batch
         where sent_at is null and created_at < now() - interval '14 days';
        get diagnostics v_старьё = row_count;
    end if;

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

        v_текст := worship_cut(btrim(v_текст));
        if coalesce(v_текст, '') = '' then continue; end if;

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
                              'писем', v_писем, 'событий', v_всего,
                              'просрочено', v_старьё, 'сообщения', v_итог);
end $$;

revoke all on function worship_notify_pack(boolean, boolean) from public, anon, authenticated;
