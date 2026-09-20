-- Шахматка: флаг «мы должны участнику» (парный к fin_retreat_debtors из 222).
-- Только факт, без сумм; доступ — любой сотрудник (is_staff), как у fin_retreat_debtors.
--
-- Аванс сам по себе долгом не считается: у того, кому ещё не заводили карточку
-- (начислений нет), он просто лежит нераспределённым. Поэтому «мы должны»:
--   • по ретриту есть хотя бы одно неотменённое начисление, и
--   • общий баланс в пользу участника (net < 0), и
--   • долга нет (total_debt = 0) — если долг есть, участник и так помечен как должник.

CREATE OR REPLACE FUNCTION public.fin_retreat_creditors(p_retreat uuid)
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
  ) x
  CROSS JOIN LATERAL (
    SELECT fin_private_participant_balance(x.pid, p_retreat) AS j
  ) b
  WHERE COALESCE((b.j->>'net')::numeric, 0) < 0
    AND COALESCE((b.j->>'total_debt')::numeric, 0) = 0;
END;
$function$;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('timeline_we_owe', 'Мы должны участнику', 'We owe the participant', 'हमें प्रतिभागी को देना है')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
