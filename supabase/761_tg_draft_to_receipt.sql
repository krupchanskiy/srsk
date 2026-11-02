-- Кнопка «📥 Приход» на карточке бота (ВГ, 02.11.2026). Если о получении денег написали
-- словами, которых бот не знает, раньше подходили только «Расход», «Передача», «Не про деньги».
-- Заявка закрывается, сообщение попадает в «Поступления» (760) в любом чате, даже где сохранение
-- сообщений выключено: сумма не должна потеряться. Проводит по-прежнему казначей.
CREATE OR REPLACE FUNCTION public.tg_draft_to_receipt(p_id uuid)
RETURNS TABLE(chat_id bigint, source_message_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  d tg_drafts%ROWTYPE;
BEGIN
  UPDATE tg_drafts t SET status = 'dismissed', resolved_at = now()
   WHERE t.id = p_id AND t.status = 'proposed'
  RETURNING * INTO d;
  IF NOT FOUND THEN RETURN; END IF;

  INSERT INTO tg_incoming (chat_id, tg_user_id, full_name, message_id, text, received_at,
                           department_id, amount, currency, is_receipt)
  SELECT d.chat_id, d.tg_user_id,
         COALESCE(NULLIF(v.spiritual_name, ''), TRIM(COALESCE(v.first_name, '') || ' ' || COALESCE(v.last_name, ''))),
         d.source_message_id, d.raw_text, d.created_at, d.department_id, d.amount, d.currency, true
    FROM (SELECT 1) x
    LEFT JOIN vaishnavas v ON v.id = d.author_vaishnava_id
  ON CONFLICT (chat_id, message_id) DO UPDATE
     SET is_receipt = true,
         amount = COALESCE(EXCLUDED.amount, tg_incoming.amount),
         currency = COALESCE(EXCLUDED.currency, tg_incoming.currency);

  chat_id := d.chat_id;
  source_message_id := d.source_message_id;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_draft_to_receipt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_draft_to_receipt(uuid) TO service_role;
