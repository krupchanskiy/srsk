-- =============================================================================
-- Миграция 168: Уточнение семантики баланса
-- =============================================================================
-- Баланс участника в валюте =
--   Σ по предоплатам, у которых ЕСТЬ операции:
--       max(0, p.amount − Σ операций с этим payment_id)
-- − Σ операций с payment_id IS NULL (размещение с баланса).
--
-- Подтверждённая предоплата без операций НЕ идёт в баланс — она остаётся
-- "зарезервирована" под исходный ретрит сделки.
-- =============================================================================

CREATE OR REPLACE FUNCTION recalc_participant_balance(p_vaishnava_id UUID, p_currency TEXT)
RETURNS VOID AS $$
DECLARE
    sum_payment_remainders NUMERIC(14,2);
    sum_balance_outflows   NUMERIC(14,2);
    balance                NUMERIC(14,2);
BEGIN
    IF p_vaishnava_id IS NULL OR p_currency IS NULL THEN RETURN; END IF;

    -- Сумма остатков по тем предоплатам, у которых есть хотя бы одна операция
    SELECT COALESCE(SUM(GREATEST(p.amount - COALESCE(ops.total, 0), 0)), 0)
      INTO sum_payment_remainders
      FROM crm_payments p
      JOIN crm_deals d ON d.id = p.deal_id
      JOIN LATERAL (
          SELECT SUM(o.amount) AS total, COUNT(*) AS cnt
            FROM crm_prepayment_operations o
           WHERE o.payment_id = p.id
      ) ops ON TRUE
     WHERE d.vaishnava_id  = p_vaishnava_id
       AND p.currency      = p_currency
       AND p.payment_type  = 'org_fee'
       AND p.is_confirmed  = TRUE
       AND ops.cnt > 0;

    -- Операции, размещённые с баланса (payment_id IS NULL) — уменьшают баланс
    SELECT COALESCE(SUM(o.amount), 0)
      INTO sum_balance_outflows
      FROM crm_prepayment_operations o
     WHERE o.vaishnava_id = p_vaishnava_id
       AND o.currency     = p_currency
       AND o.payment_id   IS NULL;

    balance := sum_payment_remainders - sum_balance_outflows;

    IF balance > 0 THEN
        INSERT INTO crm_participant_balance(vaishnava_id, currency, amount, updated_at)
        VALUES (p_vaishnava_id, p_currency, balance, NOW())
        ON CONFLICT (vaishnava_id, currency) DO UPDATE
           SET amount = EXCLUDED.amount, updated_at = NOW();
    ELSE
        DELETE FROM crm_participant_balance
         WHERE vaishnava_id = p_vaishnava_id AND currency = p_currency;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Пересчитать все существующие балансы
TRUNCATE crm_participant_balance;
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
