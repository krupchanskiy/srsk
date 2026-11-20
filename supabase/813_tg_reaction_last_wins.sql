-- Последняя реакция на сообщение побеждает (ВГ, 20.11.2026).
-- 02.11 кассы 2 этажа перепровели «остаток минус размен»: в одной транзакции
-- сторно поставило 👎, а новый приход — 👍 на то же сообщение. Каждая реакция
-- уходит в Telegram отдельным запросом pg_net, запросы идут параллельно, и на
-- пяти сообщениях последним долетел 👎 — в чате выглядело «отменено», хотя
-- деньги учтены.
--
-- Теперь новая реакция на то же сообщение снимает предыдущие, ещё ждущие:
-- строка помечается 'superseded' (повтор её не трогает), а запрос, если он ещё
-- в очереди pg_net (та же транзакция — воркер его не видел), удаляется.

ALTER TABLE public.tg_reactions DROP CONSTRAINT tg_reactions_status_check;
ALTER TABLE public.tg_reactions ADD CONSTRAINT tg_reactions_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'superseded'));

CREATE OR REPLACE FUNCTION public.tg_set_reaction(p_chat bigint, p_message bigint, p_emoji text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_id bigint;
BEGIN
  IF p_chat IS NULL OR p_message IS NULL THEN RETURN; END IF;

  WITH old AS (
    UPDATE tg_reactions
       SET status = 'superseded'
     WHERE chat_id = p_chat AND message_id = p_message AND status = 'pending'
    RETURNING net_request_id
  )
  DELETE FROM net.http_request_queue q
   USING old WHERE q.id = old.net_request_id;

  INSERT INTO tg_reactions (chat_id, message_id, emoji)
  VALUES (p_chat, p_message, p_emoji)
  RETURNING id INTO v_id;
  PERFORM tg_reaction_try(v_id);
EXCEPTION WHEN OTHERS THEN NULL;
END;
$function$;
