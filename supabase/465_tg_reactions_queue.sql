-- Надёжная установка реакций (ВГ, 22.09.2026): tg_set_reaction была «выстрелил
-- и забыл» — net.http_post асинхронный, ответ никогда не проверялся, а любая
-- ошибка глушилась EXCEPTION WHEN OTHERS THEN NULL. Из-за этого реакция могла
-- не долететь (сеть, лимит Telegram) и молча остаться прежней — сделка
-- проведена, а на сообщении по-прежнему висит 👀, человек думает, что не
-- обработано. Делаем так же, как для исходящих сообщений (tg_outbox): очередь
-- с проверкой ответа и повтором до 5 раз.

CREATE TABLE public.tg_reactions (
  id             bigint generated always as identity primary key,
  chat_id        bigint not null,
  message_id     bigint not null,
  emoji          text not null,
  status         text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts       int not null default 0,
  net_request_id bigint,
  last_error     text,
  created_at     timestamptz not null default now(),
  last_try_at    timestamptz,
  sent_at        timestamptz
);

CREATE INDEX tg_reactions_pending_idx ON public.tg_reactions (id) WHERE status = 'pending';

ALTER TABLE public.tg_reactions ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.tg_reaction_try(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_row  tg_reactions%rowtype;
    v_token text;
    v_req bigint;
begin
    select * into v_row from tg_reactions where id = p_id and status = 'pending' for update;
    if not found then return; end if;

    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';

    select net.http_post(
        url := format('https://api.telegram.org/bot%s/setMessageReaction', v_token),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := jsonb_build_object('chat_id', v_row.chat_id, 'message_id', v_row.message_id,
                'reaction', jsonb_build_array(jsonb_build_object('type','emoji','emoji',v_row.emoji))),
        timeout_milliseconds := 15000
    ) into v_req;

    update tg_reactions
       set attempts = attempts + 1, last_try_at = now(), net_request_id = v_req
     where id = p_id;
exception when others then
    update tg_reactions
       set attempts = attempts + 1, last_try_at = now(), last_error = SQLERRM
     where id = p_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.tg_reaction_try(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_reactions_flush()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        select * from tg_reactions
         where status = 'pending'
           and (last_try_at is null or last_try_at < now() - interval '45 second')
         order by id limit 100
    loop
        v_код := null; v_ошибка := null; v_тело := null; v_есть_ответ := false;
        if r.net_request_id is not null then
            select status_code, error_msg, content into v_код, v_ошибка, v_тело
              from net._http_response where id = r.net_request_id;
            v_есть_ответ := found;
        end if;
        v_ошибка := coalesce(v_ошибка,
                             nullif(btrim(coalesce(v_тело::jsonb->>'description', '')), ''),
                             v_тело);

        if v_код between 200 and 299 then
            update tg_reactions set status = 'sent', sent_at = now(), last_error = null where id = r.id;
            v_доставлено := v_доставлено + 1;
            continue;
        end if;

        if not v_есть_ответ and r.last_try_at > now() - interval '2 minute' then
            continue;
        end if;

        if v_код between 400 and 499 and v_код <> 429 then
            update tg_reactions set status = 'failed', last_error = v_ошибка where id = r.id;
            v_сдались := v_сдались + 1;
            continue;
        end if;

        if r.attempts >= 5 then
            update tg_reactions
               set status = 'failed',
                   last_error = coalesce(v_ошибка, r.last_error, 'нет ответа от Telegram')
             where id = r.id;
            v_сдались := v_сдались + 1;
            continue;
        end if;

        update tg_reactions set last_error = coalesce(v_ошибка, 'нет ответа') where id = r.id;
        perform tg_reaction_try(r.id);
        v_повторов := v_повторов + 1;
    end loop;

    return jsonb_build_object('доставлено', v_доставлено, 'повторов', v_повторов, 'сдались', v_сдались);
end;
$function$;

REVOKE ALL ON FUNCTION public.tg_reactions_flush() FROM PUBLIC, anon, authenticated;

-- tg_set_reaction теперь кладёт задачу в очередь вместо прямого (непроверяемого) http_post
CREATE OR REPLACE FUNCTION public.tg_set_reaction(p_chat bigint, p_message bigint, p_emoji text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  IF p_chat IS NULL OR p_message IS NULL THEN RETURN; END IF;
  INSERT INTO tg_reactions (chat_id, message_id, emoji)
  VALUES (p_chat, p_message, p_emoji)
  RETURNING id INTO v_id;
  PERFORM tg_reaction_try(v_id);
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;

SELECT cron.schedule('tg_reactions_flush', '* * * * *', $$SELECT public.tg_reactions_flush()$$);
