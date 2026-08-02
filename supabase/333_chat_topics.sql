-- Темы в чатах департаментов.
--
-- Просьба Адриана (02.08.2026): в Гест-хаусе заведены две темы — «Счёт
-- Гест-хаус» для финансовых операций и «Ресепшен» для оповещений о приезде,
-- отъезде, долгах и нерасселённых. Финансы и быт не должны мешаться.
--
-- У темы в Telegram нет постоянного имени в API — только номер, и узнать его
-- бот может лишь из сообщения, написанного прямо в ней. Поэтому привязка
-- делается командой «/тема финансы» или «/тема ресепшен» в нужной теме.

create or replace function tg_set_topic(p_chat bigint, p_thread int, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_name text; v_col text;
BEGIN
  IF p_thread IS NULL THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Эту команду нужно писать внутри темы, а не в общем чате');
  END IF;

  SELECT department_name INTO v_name FROM tg_chat_links WHERE chat_id = p_chat AND is_active;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Чат не привязан к департаменту');
  END IF;

  IF p_kind = 'finance' THEN
    UPDATE tg_chat_links SET topic_finance = p_thread WHERE chat_id = p_chat;
  ELSIF p_kind = 'notify' THEN
    UPDATE tg_chat_links SET topic_notify = p_thread WHERE chat_id = p_chat;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'Не понял, какая это тема');
  END IF;

  RETURN jsonb_build_object('ok', true, 'department', v_name, 'kind', p_kind);
END;
$function$;

grant execute on function tg_set_topic(bigint, int, text) to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Отправка с учётом темы. Финансовые сообщения идут в тему счёта, оповещения
-- ресепшена — в свою. Если тема не привязана (или чат не форум), уходит в чат
-- целиком, как раньше.
-- ---------------------------------------------------------------------------
create or replace function tg_send_chat(p_chat bigint, p_text text, p_reply_to bigint, p_kind text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_token text; v_thread int;
BEGIN
  SELECT CASE WHEN p_kind = 'notify' THEN topic_notify ELSE topic_finance END
    INTO v_thread FROM tg_chat_links WHERE chat_id = p_chat AND is_active;

  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='telegram_bot_token';
  PERFORM net.http_post(
    url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text, 'parse_mode','HTML',
                               'disable_web_page_preview', true)
            || CASE WHEN p_reply_to IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('reply_to_message_id', p_reply_to) END
            || CASE WHEN v_thread IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('message_thread_id', v_thread) END);
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;

-- Старые вызовы (двух- и трёхпараметрический) остаются рабочими и по умолчанию
-- шлют в финансовую тему — все нынешние уведомления про деньги.
create or replace function tg_send_chat(p_chat bigint, p_text text, p_reply_to bigint)
returns void
language sql
security definer
set search_path to 'public'
as $function$ SELECT tg_send_chat(p_chat, p_text, p_reply_to, 'finance') $function$;

create or replace function tg_send_chat(p_chat bigint, p_text text)
returns void
language sql
security definer
set search_path to 'public'
as $function$ SELECT tg_send_chat(p_chat, p_text, null::bigint, 'finance') $function$;
