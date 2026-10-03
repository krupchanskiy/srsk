-- 632: сообщения бота — в каждый чат строго по порядку (ВГ, 03.10.2026).
-- Несколько сообщений одной операции уходили в Телеграм одновременно (pg_net шлёт
-- параллельно) и приходили вперемешку: в чате Ашиша «Приход» встал выше «Операция
-- отменена», хотя в базе было наоборот. Теперь следующее сообщение в чат уходит только
-- после того, как Телеграм подтвердил предыдущее. Очередь проверяется раз в 5 секунд,
-- журнал запусков расписания чистится раз в сутки (старше 7 дней).

create or replace function public.tg_outbox_try(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_row  tg_outbox%rowtype;
    v_token text;
    v_thread int;
    v_req bigint;
begin
    select * into v_row from tg_outbox where id = p_id and status = 'pending' for update;
    if not found then return; end if;

    -- В этот чат ещё не доставлено предыдущее — ждём своей очереди (632)
    if exists (select 1 from tg_outbox e
                where e.chat_id = v_row.chat_id and e.status = 'pending' and e.id < p_id) then
        return;
    end if;

    select case v_row.kind when 'notify' then topic_notify when 'menu' then topic_menu else topic_finance end
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
                        else jsonb_build_object('message_thread_id', v_thread) end
                || case when v_row.reply_markup is null then '{}'::jsonb
                        else jsonb_build_object('reply_markup', v_row.reply_markup) end,
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
$function$;

create or replace function public.tg_outbox_flush()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    r record;
    v_код int;
    v_ошибка text;
    v_тело text;
    v_есть_ответ boolean;
    v_доставлено int := 0;
    v_отправлено int := 0;
    v_повторов int := 0;
    v_сдались int := 0;
begin
    -- По порядку id: подтверждённое помечается доставленным, и следующее в тот же
    -- чат уходит в этом же проходе (632)
    for r in
        select * from tg_outbox
         where status = 'pending'
         order by id limit 100
    loop
        -- Ещё не отправлялось: ждёт очереди своего чата
        if r.net_request_id is null and r.attempts = 0 then
            if not exists (select 1 from tg_outbox e
                            where e.chat_id = r.chat_id and e.status = 'pending' and e.id < r.id) then
                perform tg_outbox_try(r.id);
                v_отправлено := v_отправлено + 1;
            end if;
            continue;
        end if;

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

        -- Повтор — не чаще раза в 45 секунд
        if r.last_try_at > now() - interval '45 second' then
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

    return jsonb_build_object('доставлено', v_доставлено, 'отправлено', v_отправлено,
                              'повторов', v_повторов, 'сдались', v_сдались);
end;
$function$;

select cron.alter_job((select jobid from cron.job where jobname = 'tg-outbox-flush'),
                      schedule := '5 seconds');

select cron.schedule('cron-history-cleanup', '15 22 * * *',
    $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
