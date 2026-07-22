-- Этап 6 интеграции: флаг долга для шахматки (вопрос 9 интеграционных ответов, §3.2 разбора).
-- Шахматка НЕ получает доступ к деньгам: только «есть долг / нет долга», без сумм.
-- Доступ — любой сотрудник (is_staff), т.к. шахматку ведёт ресепшен без fin-прав.
-- Детали долга — по переходу в финмодуль, там свои права.

CREATE OR REPLACE FUNCTION public.fin_has_debt(p_participant uuid, p_retreat uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_participant IS NULL OR p_retreat IS NULL THEN
    RETURN false;
  END IF;
  RETURN COALESCE(
    (fin_private_participant_balance(p_participant, p_retreat)->>'total_debt')::numeric, 0) > 0;
END;
$function$;

-- Пакетная версия: должники ретрита одним вызовом (подсветка всей шахматки без N+1).
-- Перебираются только участники, у которых есть хоть какие-то фин-данные по ретриту.
CREATE OR REPLACE FUNCTION public.fin_retreat_debtors(p_retreat uuid)
RETURNS TABLE (participant_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  IF p_retreat IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT x.pid FROM (
    SELECT DISTINCT c.participant_id AS pid FROM fin_charges c
      WHERE c.retreat_id = p_retreat AND NOT c.is_cancelled
    UNION
    SELECT DISTINCT b.participant_id FROM fin_participant_opening_balances b
      WHERE b.retreat_id = p_retreat
    UNION
    SELECT DISTINCT p.participant_id FROM fin_postings p
      JOIN fin_accounting_objects o ON o.id = p.object_id
      WHERE o.retreat_id = p_retreat AND p.participant_id IS NOT NULL
        AND p.participant_balance_kind IS NOT NULL AND p.participant_balance_kind <> 'none'
  ) x
  WHERE COALESCE(
    (fin_private_participant_balance(x.pid, p_retreat)->>'total_debt')::numeric, 0) > 0;
END;
$function$;

-- Переводы этапа 6
INSERT INTO translations (key, ru, en, hi) VALUES
  ('timeline_has_debt', 'Есть долг по ретриту', 'Has outstanding debt', 'बकाया राशि है'),
  ('timeline_debt_warning', 'У гостя есть непогашенный долг по ретриту. Выписка не блокируется, но долг проще решить, пока человек ещё здесь. Всё равно выписать?', 'This guest has an outstanding debt for the retreat. Checkout is not blocked, but the debt is easier to settle while the guest is still here. Check out anyway?', 'इस अतिथि पर रिट्रीट का बकाया है। चेक-आउट रोका नहीं जाता, पर बकाया व्यक्ति के यहाँ रहते सुलझाना आसान है। फिर भी चेक-आउट करें?'),
  ('timeline_finance_card', 'Финансы участника', 'Participant finances', 'प्रतिभागी वित्त')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
