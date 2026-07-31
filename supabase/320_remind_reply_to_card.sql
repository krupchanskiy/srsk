-- Напоминание должно вести к кнопкам, а не «куда-то вверх».
--
-- Замечание Адриана (30.07.2026): «А как человеку понять куда кликать?».
-- Формулировка «ответьте на карточку выше» бесполезна: за неделю карточка ушла
-- на сотни сообщений вверх. Теперь напоминание — это ОТВЕТ на саму карточку,
-- и в Telegram появляется цитата, по клику на которую чат прыгает к кнопкам.
--
-- Карточка записана не у всех заявок (card_message_id заполняется не всегда) —
-- тогда отвечаем на исходное сообщение человека и просим прислать трату заново:
-- бот задаст вопрос снова и пришлёт свежую карточку.

create or replace function tg_send_chat(p_chat bigint, p_text text, p_reply_to bigint)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_token text;
BEGIN
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name='telegram_bot_token';
  PERFORM net.http_post(
    url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat, 'text', p_text, 'parse_mode','HTML',
                               'disable_web_page_preview', true)
            || case when p_reply_to is null then '{}'::jsonb
                    else jsonb_build_object('reply_to_message_id', p_reply_to) end);
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;

grant execute on function tg_send_chat(bigint, text, bigint) to authenticated;

-- Старая двухаргументная версия остаётся обёрткой: ею пользуются другие сигналы
create or replace function tg_send_chat(p_chat bigint, p_text text)
returns void
language sql
security definer
set search_path to 'public'
as $$ SELECT tg_send_chat(p_chat, p_text, null::bigint) $$;

create or replace function tg_remind_unfinished()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  r record;
  v_who   text;
  v_tail  text;
  v_sent  integer := 0;
BEGIN
  FOR r IN
    SELECT d.id, d.chat_id, d.source_message_id, d.card_message_id, d.amount, d.currency,
           d.purpose, d.tg_user_id,
           (current_date - d.created_at::date) AS days,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'Прабху') AS person
    FROM tg_drafts d
    LEFT JOIN vaishnavas v ON v.id = d.author_vaishnava_id
    WHERE d.status = 'proposed'
      AND d.created_at < now() - interval '1 day'
      AND d.chat_id IS NOT NULL
  LOOP
    v_who := CASE WHEN r.tg_user_id IS NOT NULL
                  THEN format('<a href="tg://user?id=%s">%s</a>', r.tg_user_id, tg_escape(r.person))
                  ELSE tg_escape(r.person) END;

    -- Карточка сохранена — ведём прямо к ней; нет — просим прислать заново
    v_tail := CASE WHEN r.card_message_id IS NOT NULL
                   THEN 'Нажмите кнопку на карточке — она в цитате над этим сообщением.'
                   ELSE 'Пришлите эту трату заново одним сообщением — я задам вопрос и пришлю новую карточку.'
              END;

    PERFORM tg_send_chat(r.chat_id,
      v_who || ', заявка не дошла до конца — я задал вопрос, а ответа не было.'
      || coalesce(E'\n' || tg_escape(r.purpose), '')
      || coalesce(' · ' || r.amount::text || ' ' || tg_escape(coalesce(r.currency, '')), '')
      || format(E'\nВисит %s дн. ', r.days) || v_tail,
      coalesce(r.card_message_id, r.source_message_id));

    v_sent := v_sent + 1;
  END LOOP;

  RETURN v_sent;
END;
$function$;
