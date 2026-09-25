-- «Вкушающие» в боте: детализация полностью скрыта, раскрывается кнопкой
-- «Подробнее» (просьба ВГ 25.09.2026). Свёрнутая цитата Телеграма всё равно
-- показывает первые ~3 строки, поэтому от неё отказались.
--
-- tg_eating_text(p_date, p_detail):
--   p_detail = false — шапка, «Завтрак: N», «Обед: N»;
--   p_detail = true  — плюс разбивка по категориям и пояснение про «Ожидаются».
-- Кнопку и её обработку добавляет tg-webhook (callback eat:…); утренний план
-- кухни отправляется из базы, поэтому очередь tg_outbox научена reply_markup.

ALTER TABLE tg_outbox ADD COLUMN IF NOT EXISTS reply_markup jsonb;

CREATE OR REPLACE FUNCTION public.tg_outbox_try(p_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

DROP FUNCTION IF EXISTS public.tg_eating_text(date);

CREATE OR REPLACE FUNCTION public.tg_eating_text(p_date date, p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bf record; ln record;
  v_line text;
  parts text;
BEGIN
  SELECT * INTO bf FROM eating_counts(p_date, p_date) WHERE meal = 'breakfast';
  SELECT * INTO ln FROM eating_counts(p_date, p_date) WHERE meal = 'lunch';
  IF bf IS NULL THEN RETURN NULL; END IF;

  v_line := format('🍽 <b>Вкушающие %s</b>', to_char(p_date, 'DD.MM.YYYY'));

  parts := concat_ws(E'\n',
    CASE WHEN bf.team > 0 THEN 'Команда – ' || bf.team END,
    CASE WHEN bf.volunteers > 0 THEN 'Волонтёры – ' || bf.volunteers END,
    CASE WHEN bf.vips > 0 THEN 'Важные гости – ' || bf.vips END,
    CASE WHEN bf.guests > 0 THEN 'Гости – ' || bf.guests END,
    CASE WHEN bf.groups > 0 THEN 'Группы – ' || bf.groups END,
    CASE WHEN bf.expected > 0 THEN 'Ожидаются – ' || bf.expected END,
    CASE WHEN bf.expected > 0 THEN '<i>«Ожидаются» — бронь есть, гость ещё не заселён.</i>' END);
  v_line := v_line || format(E'\n☀️ Завтрак: <b>%s</b>',
                             bf.team + bf.volunteers + bf.vips + bf.guests + bf.groups + bf.expected)
                   || CASE WHEN p_detail AND parts <> '' THEN E'\n<blockquote>' || parts || '</blockquote>' ELSE '' END;

  parts := concat_ws(E'\n',
    CASE WHEN ln.team > 0 THEN 'Команда – ' || ln.team END,
    CASE WHEN ln.volunteers > 0 THEN 'Волонтёры – ' || ln.volunteers END,
    CASE WHEN ln.vips > 0 THEN 'Важные гости – ' || ln.vips END,
    CASE WHEN ln.guests > 0 THEN 'Гости – ' || ln.guests END,
    CASE WHEN ln.groups > 0 THEN 'Группы – ' || ln.groups END,
    CASE WHEN ln.expected > 0 THEN 'Ожидаются – ' || ln.expected END,
    CASE WHEN ln.expected > 0 THEN '<i>«Ожидаются» — бронь есть, гость ещё не заселён.</i>' END);
  v_line := v_line || format(E'\n🍛 Обед: <b>%s</b>',
                             ln.team + ln.volunteers + ln.vips + ln.guests + ln.groups + ln.expected)
                   || CASE WHEN p_detail AND parts <> '' THEN E'\n<blockquote>' || parts || '</blockquote>' ELSE '' END;

  RETURN v_line;
END;
$function$;

grant execute on function tg_eating_text(date, boolean) to authenticated, service_role, anon;

-- Кнопка «Подробнее» под сообщением. Формат callback: eat:<1|0>:<дата>:<p|s>,
-- p — сообщение с шапкой «План на завтра», s — ответ на /сколько.
CREATE OR REPLACE FUNCTION public.tg_kitchen_morning()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_chat bigint; v_txt text; v_id bigint;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат кухни не привязан');
  END IF;

  v_txt := tg_eating_text(current_date + 1, false);
  IF v_txt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'нет данных'); END IF;

  -- tg_send_chat не умеет кнопки — пишем в очередь сами, с той же страховкой
  BEGIN
    INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
    VALUES (v_chat, '📋 <b>План на завтра</b>' || E'\n' || v_txt, NULL, 'notify',
            jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
              jsonb_build_object('text', 'Подробнее',
                                 'callback_data', format('eat:1:%s:p', current_date + 1))))))
    RETURNING id INTO v_id;
    PERFORM tg_outbox_try(v_id);
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN jsonb_build_object('ok', true, 'date', current_date + 1);
END;
$function$;
