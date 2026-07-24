-- Разведочный лог входящих: пока настраиваем привязки, сюда падают все
-- сообщения из чатов, где сидит бот, — чтобы увидеть chat_id департаментов
-- и tg_user_id людей и заполнить tg_chat_links / tg_user_links.
CREATE TABLE IF NOT EXISTS tg_incoming (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chat_id bigint,
  chat_title text,
  chat_type text,
  tg_user_id bigint,
  username text,
  full_name text,
  message_id bigint,
  topic_id int,
  text text,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_incoming ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_incoming FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE tg_incoming IS
'Разведочный лог входящих сообщений бота (этап настройки привязок). После запуска приёма расходов чистится вместе с тестовыми данными.';

-- Секрет вебхука для Edge Function (сверка входящих вызовов Telegram)
CREATE OR REPLACE FUNCTION public.tg_webhook_secret() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'tg_webhook_secret' $$;
REVOKE ALL ON FUNCTION public.tg_webhook_secret() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_webhook_secret() TO service_role;

-- Приём разведочного сообщения (definer: пишет в закрытую таблицу)
CREATE OR REPLACE FUNCTION public.tg_log_incoming(p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO tg_incoming (chat_id, chat_title, chat_type, tg_user_id, username, full_name, message_id, topic_id, text)
  VALUES (
    (p->>'chat_id')::bigint, p->>'chat_title', p->>'chat_type',
    (p->>'tg_user_id')::bigint, p->>'username', p->>'full_name',
    (p->>'message_id')::bigint, (p->>'topic_id')::int, p->>'text'
  );
$$;
REVOKE ALL ON FUNCTION public.tg_log_incoming(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_log_incoming(jsonb) TO service_role;
