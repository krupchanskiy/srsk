-- Бот сам регистрирует чат, когда его туда добавили (событие my_chat_member).
-- Раньше чат становился виден только когда кто-то в нём напишет — неудобно
-- при настройке: ВГ добавил бота, а chat_id взять неоткуда.
CREATE TABLE IF NOT EXISTS tg_known_chats (
  chat_id bigint PRIMARY KEY,
  title text,
  chat_type text,
  bot_status text,
  is_forum boolean DEFAULT false,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_known_chats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_known_chats FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_note_chat(p jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO tg_known_chats (chat_id, title, chat_type, bot_status, is_forum, last_seen)
  VALUES ((p->>'chat_id')::bigint, p->>'title', p->>'chat_type', p->>'bot_status',
          COALESCE((p->>'is_forum')::boolean, false), now())
  ON CONFLICT (chat_id) DO UPDATE
    SET title = COALESCE(EXCLUDED.title, tg_known_chats.title),
        chat_type = COALESCE(EXCLUDED.chat_type, tg_known_chats.chat_type),
        bot_status = COALESCE(EXCLUDED.bot_status, tg_known_chats.bot_status),
        is_forum = EXCLUDED.is_forum OR tg_known_chats.is_forum,
        last_seen = now();
$$;
REVOKE ALL ON FUNCTION public.tg_note_chat(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_note_chat(jsonb) TO service_role;

CREATE OR REPLACE VIEW public.fin_v_known_chats AS
SELECT k.chat_id, k.title, k.chat_type, k.bot_status, k.is_forum, k.last_seen,
       d.name AS linked_department
FROM tg_known_chats k
LEFT JOIN tg_chat_links l ON l.chat_id = k.chat_id AND l.is_active
LEFT JOIN fin_departments d ON d.id = l.department_id
WHERE fin_can_read_all(auth.uid())
ORDER BY k.last_seen DESC;
REVOKE ALL ON public.fin_v_known_chats FROM anon;
GRANT SELECT ON public.fin_v_known_chats TO authenticated;
