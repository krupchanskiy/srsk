-- Запросы ВГ от 25.07.2026:
--   1) «как чекнуть баланс департамента через бота?» — команды не было;
--   2) «отменил перевод сторнированием, а тут ничего не изменилось».
--
-- Причина (2): tg_notify_dept_credit срабатывал только на direction='in' и
-- type='transfer'. Сторно кладёт проводку 'out' типа 'reversal' — под условие
-- не попадало, и последняя цифра «на руках» в чате оставалась неверной.
--
-- Проблема шире отмены: молчали и расход, и передача другому департаменту,
-- и возврат. Показанный в чате остаток устаревал после любого из них.
-- Теперь сообщение уходит на ЛЮБОЕ движение по подотчётному счёту
-- департамента с привязанным чатом, а формулировка подбирается по случаю.

CREATE OR REPLACE FUNCTION public.tg_notify_dept_credit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
BEGIN
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id)
    INTO v_optype, v_orig_type
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;

  v_head := CASE
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'  THEN '📥 <b>Выдано под отчёт: %s%s</b>'
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' THEN '🔁 <b>Передано другому департаменту: %s%s</b>'
    WHEN v_optype = 'expense'                            THEN '💸 <b>Проведён расход: %s%s</b>'
    WHEN v_optype = 'refund'                             THEN '↩️ <b>Возврат: %s%s</b>'
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer' THEN '❌ <b>Выдача отменена: %s%s</b>'
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'  THEN '❌ <b>Расход отменён: %s%s</b>'
    WHEN v_optype = 'reversal'                           THEN '❌ <b>Операция отменена: %s%s</b>'
    WHEN NEW.direction = 'in'                            THEN '📥 <b>Приход: %s%s</b>'
    ELSE '📤 <b>Списание: %s%s</b>'
  END;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  PERFORM tg_send_chat(v_chat, format(
    v_head || E'\nНа руках у департамента: %s',
    v_sign, fin_fmt_money(NEW.amount, v_acc.currency_code),
    fin_fmt_money(v_bal, v_acc.currency_code)));
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tg_notify_dept_credit() IS
  'Сообщение в чат департамента на любое движение по его подотчётному счёту. До 25.07.2026 молчало обо всём, кроме выдачи, — цифра «на руках» в чате устаревала после первой же отмены или траты.';

-- Остаток департамента по запросу из чата (команда /balance или /баланс).
-- Заодно показываем непроведённые заявки: человек видит, что ещё не проведено,
-- и не считает остаток «неправильным».
--
-- Департаменты финмодуля живут в fin_departments (колонка name), а НЕ в
-- departments (name_ru/en/hi) — это другая, кадровая таблица. Тело plpgsql при
-- создании имена не разрешает, поэтому первые три версии этой функции
-- «применились» успешно и падали только при вызове. Проверять — вызовом.
CREATE OR REPLACE FUNCTION public.tg_department_balance(p_chat bigint)
RETURNS TABLE (department_name text, balance numeric, currency_code text,
               pending_drafts int, formatted text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_dept uuid;
BEGIN
  SELECT l.department_id INTO v_dept FROM tg_chat_links l
   WHERE l.chat_id = p_chat AND l.is_active;
  IF v_dept IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT d.name::text,
         COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)::numeric,
         a.currency_code::text,
         (SELECT count(*)::int FROM tg_drafts dr
           WHERE dr.department_id = v_dept AND dr.status = 'pending'),
         fin_fmt_money(COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0),
                       a.currency_code)::text
  FROM fin_accounts a
  JOIN fin_departments d ON d.id = a.department_id
  LEFT JOIN fin_postings p ON p.account_id = a.id
  WHERE a.department_id = v_dept AND a.kind = 'custodial' AND a.is_active
  GROUP BY d.name, a.currency_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_department_balance(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tg_department_balance(bigint) TO service_role;

COMMENT ON FUNCTION public.tg_department_balance(bigint) IS
  'Остаток подотчётного счёта департамента по chat_id — для команды /balance в чате департамента.';
