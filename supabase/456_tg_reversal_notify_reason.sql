-- Уведомление в чат департамента о сторно теперь объясняет, что произошло
-- (ВГ, 21.09.2026): раньше приходило голое «❌ Расход отменён: −300 ₹» — без
-- причины и без указания, какая именно трата отменена.
--
-- Что добавлено, только для операций типа 'reversal':
--   • «Причина: …» — fin_operations.reason (при сторно она обязательна);
--   • «На что: …» — назначение из заявки ИСХОДНОЙ операции (у самого сторно
--     заявки нет, поэтому раньше строки не было);
--   • ответ (reply) на исходное сообщение автора — то, из которого родилась
--     отменяемая трата. Отвечаем только если сообщение в том же чате,
--     куда идёт уведомление: иначе Telegram откажет («message to reply not found»).
--
-- Остальные виды операций работают как раньше.

CREATE OR REPLACE FUNCTION public.tg_notify_dept_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_orig_op uuid;        -- исходная операция (только у сторно)
  v_reason text;         -- причина сторно
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
  v_amount text;
  v_text text;
  v_other_acc text;      -- счёт второй стороны операции
  v_other_dept text;     -- её департамент (NULL, если это касса)
  v_purpose text;        -- назначение из заявки бота
  v_reply_to bigint;     -- исходное сообщение автора (для сторно)
  v_src_chat bigint;
BEGIN
  -- заявка из чата с разбивкой по департаментам сообщает о себе сама
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id),
         o.original_operation_id,
         NULLIF(btrim(o.reason), '')
    INTO v_optype, v_orig_type, v_orig_op, v_reason
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  -- Вторая сторона: обе проводки перевода вставляются одним оператором,
  -- поэтому к моменту срабатывания AFTER-триггера парная строка уже видна.
  SELECT a2.name, d2.name
    INTO v_other_acc, v_other_dept
    FROM fin_postings p2
    JOIN fin_accounts a2 ON a2.id = p2.account_id
    LEFT JOIN fin_departments d2 ON d2.id = a2.department_id
   WHERE p2.operation_id = NEW.operation_id
     AND p2.direction <> NEW.direction
   LIMIT 1;

  -- Назначение — из заявки бота: там оно написано человеческим языком
  -- («10 стульев для гест-хауса»), включая количество. У сторно своей заявки
  -- нет — берём заявку отменяемой операции, она же даёт исходное сообщение.
  SELECT NULLIF(btrim(dr.purpose), ''),
         CASE WHEN v_optype = 'reversal' THEN dr.source_message_id END,
         CASE WHEN v_optype = 'reversal' THEN dr.chat_id END
    INTO v_purpose, v_reply_to, v_src_chat
    FROM tg_drafts dr
   WHERE dr.id IN (SELECT dop.draft_id FROM tg_draft_operations dop
                    WHERE dop.operation_id = COALESCE(v_orig_op, NEW.operation_id))
      OR dr.operation_id = COALESCE(v_orig_op, NEW.operation_id)
   LIMIT 1;

  -- отвечать можно только в том же чате, где живёт исходное сообщение
  IF v_src_chat IS DISTINCT FROM v_chat THEN v_reply_to := NULL; END IF;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;
  v_amount := v_sign || fin_fmt_money(NEW.amount, v_acc.currency_code);

  v_head := CASE
    -- Перевод: называем вторую сторону поимённо
    WHEN v_optype = 'transfer' AND NEW.direction = 'in' AND v_other_dept IS NOT NULL
      THEN format('📥 <b>Получено от «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'
      THEN format('📥 <b>Выдано под отчёт: %s</b>', v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' AND v_other_dept IS NOT NULL
      THEN format('🔁 <b>Передано «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out'
      THEN format('📤 <b>Возвращено в кассу: %s</b>', v_amount)
    WHEN v_optype = 'expense'  THEN format('💸 <b>Проведён расход: %s</b>', v_amount)
    WHEN v_optype = 'refund'   THEN format('↩️ <b>Возврат: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer'
      THEN format('❌ <b>Выдача отменена: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'
      THEN format('❌ <b>Расход отменён: %s</b>', v_amount)
    WHEN v_optype = 'reversal' THEN format('❌ <b>Операция отменена: %s</b>', v_amount)
    WHEN NEW.direction = 'in'  THEN format('📥 <b>Приход: %s</b>', v_amount)
    ELSE format('📤 <b>Списание: %s</b>', v_amount)
  END;

  v_text := v_head;

  -- С какого счёта пришло / куда ушло — только для переводов, где это неочевидно
  IF v_optype = 'transfer' AND v_other_acc IS NOT NULL THEN
    v_text := v_text || format(E'\n%s: %s',
      CASE WHEN NEW.direction = 'in' THEN 'Со счёта' ELSE 'На счёт' END,
      tg_escape(v_other_acc));
  END IF;

  IF v_purpose IS NOT NULL THEN
    v_text := v_text || format(E'\nНа что: %s', tg_escape(v_purpose));
  END IF;

  -- Сторно без объяснения выглядит как просто отмена — причина обязательна
  IF v_optype = 'reversal' THEN
    v_text := v_text || format(E'\nПричина: %s', tg_escape(COALESCE(v_reason, 'не указана')));
  END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  v_text := v_text || format(E'\nНа руках у департамента: %s',
                             fin_fmt_money(v_bal, v_acc.currency_code));

  PERFORM tg_send_chat(v_chat, v_text, v_reply_to);
  RETURN NEW;
END;
$function$;
