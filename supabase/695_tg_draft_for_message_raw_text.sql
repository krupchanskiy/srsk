-- Телеграм присылает «исправленное сообщение» не только при настоящей правке,
-- но и когда меняется что-то вокруг него — например, реакция (бот ставит 👀
-- после «✅ Записать»). Текст при этом прежний, а бот отвечал «правка на заявку
-- не влияет» (ВГ 15.10.2026, размен кафе Нитьи-виласини). Боту нужен исходный
-- текст, чтобы предупреждать только при настоящей правке.

DROP FUNCTION IF EXISTS public.tg_draft_for_message(bigint, bigint);

CREATE FUNCTION public.tg_draft_for_message(p_chat bigint, p_message_id bigint)
RETURNS TABLE (id uuid, status text, amount numeric, currency text, purpose text, raw_text text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id, d.status, d.amount, d.currency, d.purpose, d.raw_text
  FROM tg_drafts d
  WHERE d.chat_id = p_chat AND d.source_message_id = p_message_id;
$$;

REVOKE ALL ON FUNCTION public.tg_draft_for_message(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_draft_for_message(bigint, bigint) TO service_role;

COMMENT ON FUNCTION public.tg_draft_for_message(bigint, bigint) IS
  'Заявка по исходному сообщению чата. Нужна боту, чтобы на настоящую правку уже принятого сообщения ответить правилом, а на «правку» без изменения текста — промолчать.';
