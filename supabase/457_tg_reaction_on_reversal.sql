-- При сторно проведённой заявки реакция на исходном сообщении в чате меняется
-- с 👍 на 👎 (ВГ, 21.09.2026): раньше 👍 оставался, хотя операция отменена, и
-- по чату казалось, что трата в силе. Правило общее — срабатывает на любое
-- сторно, откуда бы оно ни пришло (веб, RPC, ручная правка).
--
-- Заявка может породить несколько операций (разбивка по департаментам): 👎
-- ставим, только если в силе не осталось ни одной — при частичном сторно
-- часть денег всё ещё проведена, и 👍 остаётся честным.

CREATE OR REPLACE FUNCTION public.tg_on_reversal_reaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d record;
BEGIN
  IF NEW.type::text <> 'reversal' OR NEW.original_operation_id IS NULL THEN RETURN NEW; END IF;

  FOR v_d IN
    SELECT d.id, d.chat_id, d.source_message_id
      FROM tg_drafts d
     WHERE d.status = 'posted'
       AND (d.id IN (SELECT dop.draft_id FROM tg_draft_operations dop WHERE dop.operation_id = NEW.original_operation_id)
            OR d.operation_id = NEW.original_operation_id)
  LOOP
    -- в силе остаётся хоть одна операция заявки (кроме отменяемой) — 👍 не трогаем
    IF EXISTS (
      SELECT 1
        FROM fin_operations o
       WHERE o.id <> NEW.original_operation_id
         AND o.type::text <> 'reversal'
         AND NOT o.is_reversed
         AND (o.id IN (SELECT dop.operation_id FROM tg_draft_operations dop WHERE dop.draft_id = v_d.id)
              OR o.id = (SELECT d2.operation_id FROM tg_drafts d2 WHERE d2.id = v_d.id))
    ) THEN
      CONTINUE;
    END IF;

    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_on_reversal_reaction() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tg_reversal_reaction ON public.fin_operations;
CREATE TRIGGER trg_tg_reversal_reaction
  AFTER INSERT ON public.fin_operations
  FOR EACH ROW
  WHEN (NEW.type = 'reversal')
  EXECUTE FUNCTION public.tg_on_reversal_reaction();
