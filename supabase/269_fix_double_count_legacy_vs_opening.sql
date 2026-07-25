-- КРИТИЧНО: удвоение оплат участников на cutover.
--
-- crm_calc_deal_totals складывал две величины, описывающие ОДНИ И ТЕ ЖЕ деньги:
--   v_legacy   — подтверждённые CRM-платежи без операции в финмодуле;
--   v_fin_paid — начальные остатки участника (kind <> 'debt').
--
-- До 1 августа это работало: начальных остатков нет, считался только v_legacy.
-- Но fin_load_crm_advances() создаёт остатки ИЗ ТЕХ ЖЕ платежей, а платежи
-- остаются без операции (автопроводка пропускает их как pre_cutover).
-- Проверка на живых данных: 77 сделок, 993 827 ₹ превращались в 1 987 654 ₹.
--
-- Штатная проверка totals_mismatch этого не ловила: она сверяет сохранённое
-- значение с этой же формулой — обе стороны согласны на удвоенном числе.
--
-- Исправление: если по сделке уже загружен начальный остаток (генератор
-- пишет source_row_id = id сделки), её исторические платежи больше не
-- складываются — они уже представлены остатком.

CREATE OR REPLACE FUNCTION crm_calc_deal_totals(p_deal uuid, OUT o_charged numeric, OUT o_paid numeric)
RETURNS record
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_vaishnava uuid;
  v_retreat uuid;
  v_primary uuid;
  v_services numeric := 0;
  v_legacy numeric := 0;
  v_fin_charged numeric := 0;
  v_fin_paid numeric := 0;
BEGIN
  SELECT vaishnava_id, retreat_id INTO v_vaishnava, v_retreat FROM crm_deals WHERE id = p_deal;

  SELECT COALESCE(SUM(total_price), 0) INTO v_services FROM crm_deal_services WHERE deal_id = p_deal;

  -- история: подтверждённые CRM-платежи, не имеющие операции в финмодуле
  -- и ещё не перенесённые в начальные остатки
  SELECT COALESCE(SUM(cp.amount_inr), 0) INTO v_legacy
  FROM crm_payments cp
  WHERE cp.deal_id = p_deal AND cp.is_confirmed
    AND NOT EXISTS (SELECT 1 FROM fin_operations fo WHERE fo.id = cp.id)
    AND NOT EXISTS (SELECT 1 FROM fin_participant_opening_balances ob
                    WHERE ob.source_row_id = p_deal::text);

  IF v_vaishnava IS NOT NULL AND v_retreat IS NOT NULL THEN
    SELECT id INTO v_primary FROM crm_deals
    WHERE vaishnava_id = v_vaishnava AND retreat_id = v_retreat
    ORDER BY (status = 'cancelled'), created_at DESC
    LIMIT 1;

    IF v_primary = p_deal THEN
      SELECT COALESCE(SUM(amount - discount_amount), 0) INTO v_fin_charged
      FROM fin_charges
      WHERE participant_id = v_vaishnava AND retreat_id = v_retreat AND NOT is_cancelled;

      SELECT v_fin_charged + COALESCE(SUM(CASE WHEN kind = 'debt' THEN amount ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN kind <> 'debt' THEN amount ELSE 0 END), 0)
        INTO v_fin_charged, v_fin_paid
      FROM fin_participant_opening_balances
      WHERE participant_id = v_vaishnava AND retreat_id = v_retreat;

      v_fin_paid := v_fin_paid + COALESCE((
        SELECT SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END)
        FROM fin_postings p
        JOIN fin_accounting_objects o ON o.id = p.object_id
        WHERE p.participant_id = v_vaishnava AND o.retreat_id = v_retreat
          AND p.participant_balance_kind IS NOT NULL
          AND p.participant_balance_kind <> 'none'), 0);
    END IF;
  END IF;

  o_paid := round(v_legacy + v_fin_paid, 2);
  o_charged := round(v_services + v_fin_charged, 2);
END;
$$;
