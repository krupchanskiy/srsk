-- 385: надёжная доставка сообщений бота — очередь с повторами
--
-- Проблема: 15.08 ВГ сделал два перевода и расход на две строки, а в чат
-- пришло по одному уведомлению. Триггеры отработали верно — все четыре
-- запроса ушли, но два оборвались на рукопожатии TLS:
--   «Timeout of 5000 ms reached … TCP/SSL handshake time: 4997 ms».
-- pg_net не повторяет запрос, а tg_send_chat глушит ошибки, поэтому
-- уведомление о движении денег пропадало молча. За доступный отрезок
-- истории — 2 потери из 10 отправок.
--
-- Решение: сообщение сначала ложится в журнал, потом отправляется. Раз в
-- минуту cron проверяет ответы и досылает то, что не дошло.

create table if not exists public.tg_outbox (
    id              bigserial primary key,
    chat_id         bigint not null,
    text            text   not null,
    reply_to        bigint,
    kind            text   not null default 'finance',
    status          text   not null default 'pending'
                    check (status in ('pending', 'sent', 'failed')),
    attempts        int    not null default 0,
    net_request_id  bigint,
    last_error      text,
    created_at      timestamptz not null default now(),
    last_try_at     timestamptz,
    sent_at         timestamptz
);

comment on table public.tg_outbox is
    'Исходящие сообщения бота: пишем до отправки, чтобы потерянные можно было дослать';

create index if not exists tg_outbox_pending_idx
    on public.tg_outbox (last_try_at) where status = 'pending';

alter table public.tg_outbox enable row level security;
revoke all on public.tg_outbox from public, anon;
grant select on public.tg_outbox to authenticated;

-- Журнал видят только финансовые администраторы: в тексте суммы и остатки
drop policy if exists tg_outbox_read_admin on public.tg_outbox;
create policy tg_outbox_read_admin on public.tg_outbox
    for select to authenticated using (fin_is_admin(auth.uid()));

-- Одна попытка отправки
create or replace function public.tg_outbox_try(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row  tg_outbox%rowtype;
    v_token text;
    v_thread int;
    v_req bigint;
begin
    select * into v_row from tg_outbox where id = p_id and status = 'pending' for update;
    if not found then return; end if;

    select case when v_row.kind = 'notify' then topic_notify else topic_finance end
      into v_thread from tg_chat_links where chat_id = v_row.chat_id and is_active;

    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';

    -- 15 секунд вместо стандартных пяти: обрывалось именно рукопожатие TLS
    select net.http_post(
        url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := jsonb_build_object('chat_id', v_row.chat_id, 'text', v_row.text,
                                   'parse_mode', 'HTML', 'disable_web_page_preview', true)
                || case when v_row.reply_to is null then '{}'::jsonb
                        else jsonb_build_object('reply_to_message_id', v_row.reply_to) end
                || case when v_thread is null then '{}'::jsonb
                        else jsonb_build_object('message_thread_id', v_thread) end,
        timeout_milliseconds := 15000
    ) into v_req;

    update tg_outbox
       set attempts = attempts + 1, last_try_at = now(), net_request_id = v_req
     where id = p_id;
exception when others then
    update tg_outbox
       set attempts = attempts + 1, last_try_at = now(), last_error = SQLERRM
     where id = p_id;
end;
$$;

-- Отправка: кладём в журнал и сразу пробуем доставить
create or replace function public.tg_send_chat(p_chat bigint, p_text text, p_reply_to bigint, p_kind text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
    insert into tg_outbox (chat_id, text, reply_to, kind)
    values (p_chat, p_text, p_reply_to, coalesce(p_kind, 'finance'))
    returning id into v_id;

    perform tg_outbox_try(v_id);
exception when others then
    -- Отправка не должна ронять денежную операцию: запись уже в журнале, дошлём
    null;
end;
$$;

-- Разбор результатов и повтор недоставленного
create or replace function public.tg_outbox_flush()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
    v_код int;
    v_ошибка text;
    v_тело text;
    v_есть_ответ boolean;
    v_доставлено int := 0;
    v_повторов int := 0;
    v_сдались int := 0;
begin
    for r in
        select * from tg_outbox
         where status = 'pending'
           and (last_try_at is null or last_try_at < now() - interval '45 second')
         order by id
         limit 100
    loop
        v_код := null; v_ошибка := null; v_тело := null; v_есть_ответ := false;
        if r.net_request_id is not null then
            select status_code, error_msg, content into v_код, v_ошибка, v_тело
              from net._http_response where id = r.net_request_id;
            v_есть_ответ := found;
        end if;
        -- Причина отказа лежит в теле ответа Telegram, а не в error_msg
        v_ошибка := coalesce(v_ошибка,
                             nullif(btrim(coalesce(v_тело::jsonb->>'description', '')), ''),
                             v_тело);

        if v_код between 200 and 299 then
            update tg_outbox set status = 'sent', sent_at = now(), last_error = null where id = r.id;
            v_доставлено := v_доставлено + 1;
            continue;
        end if;

        -- Ответа ещё нет — запрос может выполняться, даём ему время
        if not v_есть_ответ and r.last_try_at > now() - interval '2 minute' then
            continue;
        end if;

        -- Telegram отказал по существу (нет чата, бот выгнан, текст не тот) —
        -- повтор ничего не изменит. 429 и 5xx лечатся ожиданием, их повторяем.
        if v_код between 400 and 499 and v_код <> 429 then
            update tg_outbox set status = 'failed', last_error = v_ошибка where id = r.id;
            v_сдались := v_сдались + 1;
            continue;
        end if;

        if r.attempts >= 5 then
            update tg_outbox
               set status = 'failed',
                   last_error = coalesce(v_ошибка, r.last_error, 'нет ответа от Telegram')
             where id = r.id;
            v_сдались := v_сдались + 1;
            continue;
        end if;

        update tg_outbox set last_error = coalesce(v_ошибка, 'нет ответа') where id = r.id;
        perform tg_outbox_try(r.id);
        v_повторов := v_повторов + 1;
    end loop;

    return jsonb_build_object('доставлено', v_доставлено, 'повторов', v_повторов, 'сдались', v_сдались);
end;
$$;

revoke execute on function public.tg_outbox_try(bigint) from public, anon;
revoke execute on function public.tg_outbox_flush() from public, anon;
grant execute on function public.tg_outbox_flush() to service_role;

select cron.schedule('tg-outbox-flush', '* * * * *', 'SELECT public.tg_outbox_flush()');
