-- Окно бота о получении денег (ВГ, 02.11.2026): остаётся напоминанием, кнопка «📥 Внести» ведёт во
-- вкладку «Поступления». Окно исчезает и ставится 👍 только после настоящего внесения, а не по
-- кнопке «Принял»: иначе в чате видно «учтено», хотя в кассе прихода нет.
ALTER TABLE tg_incoming ADD COLUMN IF NOT EXISTS tag_message_id bigint;

-- Сообщение сохранено как поступление — значит, окну можно дать кнопку «Внести»
CREATE OR REPLACE FUNCTION public.tg_receipt_saved(p_chat bigint, p_message bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM tg_incoming i
                  WHERE i.chat_id = p_chat AND i.message_id = p_message AND i.is_receipt);
$$;
REVOKE ALL ON FUNCTION public.tg_receipt_saved(bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_receipt_saved(bigint, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_receipt_set_tag(p_chat bigint, p_message bigint, p_tag bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE tg_incoming SET tag_message_id = p_tag WHERE chat_id = p_chat AND message_id = p_message;
$$;
REVOKE ALL ON FUNCTION public.tg_receipt_set_tag(bigint, bigint, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_receipt_set_tag(bigint, bigint, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_tg_receipt_set(p_id bigint, p_status text, p_operation uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r tg_incoming%ROWTYPE;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Нет прав');
  END IF;
  IF p_status NOT IN ('new','posted','linked','dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Неизвестный статус');
  END IF;
  SELECT * INTO r FROM tg_incoming WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Сообщение не найдено');
  END IF;
  IF p_status = 'posted' AND p_operation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Не указан приход');
  END IF;
  -- Один приход — одно сообщение; живой приход не отвязываем молча
  IF p_operation IS NOT NULL AND EXISTS (
       SELECT 1 FROM tg_incoming u WHERE u.operation_id = p_operation AND u.id <> p_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Этот приход уже привязан к другому сообщению');
  END IF;
  IF r.receipt_status IN ('posted','linked') AND p_status IN ('posted','linked')
     AND r.operation_id IS NOT NULL AND NOT (SELECT is_reversed FROM fin_operations WHERE id = r.operation_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Это сообщение уже внесено');
  END IF;

  UPDATE tg_incoming
     SET receipt_status = p_status,
         is_receipt = is_receipt OR p_status = 'new',
         operation_id = p_operation,
         resolved_by = CASE WHEN p_status = 'new' THEN NULL ELSE auth.uid() END,
         resolved_at = CASE WHEN p_status = 'new' THEN NULL ELSE now() END
   WHERE id = p_id;

  IF p_status IN ('posted','linked') AND r.message_id IS NOT NULL THEN
    PERFORM tg_set_reaction(r.chat_id, r.message_id, '👍');
  END IF;
  -- Деньги разобраны — окно с упоминанием казначея больше не нужно
  IF p_status <> 'new' AND r.tag_message_id IS NOT NULL THEN
    PERFORM tg_schedule_delete(r.chat_id, r.tag_message_id, 0);
    UPDATE tg_incoming SET tag_message_id = NULL WHERE id = p_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Сторно прихода: 👍 на сообщении менялся бы только у заявок (tg_drafts), у поступлений нет связи
CREATE OR REPLACE FUNCTION public.tg_on_reversal_receipt_reaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT chat_id, message_id FROM tg_incoming
            WHERE operation_id = NEW.original_operation_id AND message_id IS NOT NULL
  LOOP
    PERFORM tg_set_reaction(r.chat_id, r.message_id, '👎');
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_tg_reversal_receipt_reaction ON public.fin_operations;
CREATE TRIGGER trg_tg_reversal_receipt_reaction AFTER INSERT ON public.fin_operations
  FOR EACH ROW WHEN (NEW.type = 'reversal'::fin_operation_type AND NEW.original_operation_id IS NOT NULL)
  EXECUTE FUNCTION tg_on_reversal_receipt_reaction();
