-- Правило ВГ (25.07.2026): сообщение, которое бот уже принял в работу, нельзя
-- править и удалять — иначе в чате и во «Входящих» расходятся данные. Правит
-- только фин-администратор при проведении, при необходимости минусует и вносит
-- заново. Бот должен об этом сказать, а не молчать.
--
-- Раньше правка уходила в tg_create_draft, ловилась ON CONFLICT DO NOTHING и
-- возвращала NULL: дубля не возникало, но человек не получал никакого ответа
-- и был уверен, что заявка обновилась.

CREATE OR REPLACE FUNCTION public.tg_draft_for_message(p_chat bigint, p_message_id bigint)
RETURNS TABLE (id uuid, status text, amount numeric, currency text, purpose text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id, d.status, d.amount, d.currency, d.purpose
  FROM tg_drafts d
  WHERE d.chat_id = p_chat AND d.source_message_id = p_message_id;
$$;

REVOKE ALL ON FUNCTION public.tg_draft_for_message(bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_draft_for_message(bigint, bigint) TO service_role;

COMMENT ON FUNCTION public.tg_draft_for_message(bigint, bigint) IS
  'Заявка по исходному сообщению чата. Нужна боту, чтобы на правку уже принятого сообщения ответить правилом, а не молчать.';
