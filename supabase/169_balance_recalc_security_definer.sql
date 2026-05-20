-- =============================================================================
-- Миграция 169: SECURITY DEFINER для триггерных функций пересчёта баланса
-- =============================================================================
-- Триггер recalc_participant_balance делает INSERT в crm_participant_balance,
-- которая под RLS (SELECT-only для authenticated). Без SECURITY DEFINER
-- триггер падает с "new row violates row-level security policy".
-- =============================================================================

ALTER FUNCTION recalc_participant_balance(UUID, TEXT) SECURITY DEFINER;
ALTER FUNCTION trg_ppo_recalc_balance()       SECURITY DEFINER;
ALTER FUNCTION trg_payment_recalc_balance()   SECURITY DEFINER;

-- Перерасчёт после применения (на всякий случай)
DO $$
DECLARE rec RECORD;
BEGIN
    FOR rec IN
        SELECT DISTINCT d.vaishnava_id, p.currency
          FROM crm_payments p JOIN crm_deals d ON d.id = p.deal_id
         WHERE p.payment_type = 'org_fee' AND p.is_confirmed = TRUE
    LOOP
        PERFORM recalc_participant_balance(rec.vaishnava_id, rec.currency);
    END LOOP;
END $$;
