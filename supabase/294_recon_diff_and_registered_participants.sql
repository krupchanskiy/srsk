-- Два замечания ВГ от 26.07.2026.
--
-- 1) «Если есть расхождения, почему тут не отмечено и горит зелёным».
--    Блок «Давность сверки» показывал только свежесть. Сверка, закончившаяся
--    расхождением и корректировкой, выглядела здоровым зелёным «сегодня» —
--    сигнал о свежести прятал сам факт недостачи. Витрина счетов теперь отдаёт
--    расхождение последней сверки (original_difference — то, что нашли ДО
--    корректировки; после неё difference уже ноль и ни о чём не говорит).
--
-- 2) «Ретрит есть, а участников нет».
--    Список строился только из финансовых записей: начисления, открывающие
--    остатки, проводки. Гость, зарегистрированный на ретрит, но кому ещё
--    ничего не начислили, в список не попадал — а казначею именно его и нужно
--    найти, чтобы начислить. Добавлены зарегистрированные участники (кроме
--    отменённых) с нулевым балансом. На Сева-ретрите было 2 строки (обе —
--    тестовый мусор), стало 46.

CREATE OR REPLACE VIEW public.fin_v_account_balances AS
 SELECT a.id AS account_id, a.name, a.kind, a.reconciliation_mode, a.currency_code,
    a.group_name, a.responsible_person_id, a.default_cost_center_id, a.is_active,
    COALESCE(s.balance, 0::numeric)::numeric(14,2) AS balance,
    s.last_ledger_seq,
    COALESCE(s.balance, 0::numeric) < 0::numeric AS is_negative,
    r.cutoff_ledger_seq AS last_checkpoint_seq,
    r.performed_at AS last_checkpoint_at,
    ( SELECT count(*) FROM fin_postings p
       WHERE p.account_id = a.id AND p.ledger_seq > COALESCE(r.cutoff_ledger_seq, 0::bigint)) AS unreconciled_count,
    a.department_id,
    r.original_difference AS last_difference
   FROM fin_accounts a
     LEFT JOIN ( SELECT fin_postings.account_id,
            sum(CASE fin_postings.direction WHEN 'in'::fin_direction THEN fin_postings.amount
                     ELSE - fin_postings.amount END) AS balance,
            max(fin_postings.ledger_seq) AS last_ledger_seq
           FROM fin_postings GROUP BY fin_postings.account_id) s ON s.account_id = a.id
     LEFT JOIN LATERAL ( SELECT rr.cutoff_ledger_seq, rr.performed_at, rr.original_difference
           FROM fin_reconciliations rr WHERE rr.account_id = a.id
          ORDER BY rr.performed_at DESC, rr.cutoff_ledger_seq DESC LIMIT 1) r ON true
  WHERE fin_can_see_account(a.id);

CREATE OR REPLACE FUNCTION public.fin_list_retreat_participants(p_retreat uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'participant_id', ids.pid,
      'name', fin_private_person_name(ids.pid),
      'balance', fin_private_participant_balance(ids.pid, p_retreat)
    ) ORDER BY fin_private_person_name(ids.pid)
  ), '[]'::jsonb) INTO v_result
  FROM (
    SELECT DISTINCT participant_id AS pid FROM fin_charges WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT participant_id FROM fin_participant_opening_balances WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT p.participant_id FROM fin_postings p
    JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE o.retreat_id = p_retreat AND p.participant_id IS NOT NULL
    UNION
    -- Зарегистрированные на ретрит: их ещё нет в деньгах, но казначей должен
    -- их видеть, чтобы начислить. Отменённые регистрации не берём.
    SELECT DISTINCT rr.vaishnava_id FROM retreat_registrations rr
    WHERE rr.retreat_id = p_retreat AND rr.status <> 'cancelled' AND rr.vaishnava_id IS NOT NULL
  ) ids
  WHERE ids.pid IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'result', v_result);
END;
$function$;

NOTIFY pgrst, 'reload schema';
