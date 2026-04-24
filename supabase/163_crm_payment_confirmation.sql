-- =============================================================================
-- Миграция 163: Подтверждение платежей и история изменений
-- =============================================================================
-- 1. Поля is_confirmed / confirmed_at / confirmed_by в crm_payments.
-- 2. Таблица crm_payment_history (лог изменений).
-- 3. Триггер update_deal_total_paid пересчитывает сумму ТОЛЬКО по подтверждённым.
-- 4. Триггер записи в историю при создании/изменении платежа.
-- =============================================================================

-- Поля подтверждения
ALTER TABLE crm_payments
    ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES vaishnavas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_payments_is_confirmed ON crm_payments(is_confirmed);

COMMENT ON COLUMN crm_payments.is_confirmed IS 'TRUE — платёж подтверждён, учитывается в финансах сделки';

-- -----------------------------------------------------------------------------
-- История изменений
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crm_payment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES crm_payments(id) ON DELETE CASCADE,
    action TEXT NOT NULL, -- 'created', 'confirmed', 'unconfirmed', 'updated', 'deleted'
    field TEXT,           -- имя изменённого поля (для 'updated')
    old_value TEXT,
    new_value TEXT,
    changed_by UUID REFERENCES vaishnavas(id) ON DELETE SET NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_payment_history_payment ON crm_payment_history(payment_id, changed_at DESC);

COMMENT ON TABLE crm_payment_history IS 'Лог изменений платежей: подтверждения, правки суммы/валюты/системы/даты';

ALTER TABLE crm_payment_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_payment_history_read ON crm_payment_history
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY crm_payment_history_write ON crm_payment_history
    FOR INSERT TO authenticated
    WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- Триггер записи в историю
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm_payment_log_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_user_vaishnava_id UUID;
BEGIN
    SELECT id INTO v_user_vaishnava_id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO crm_payment_history (payment_id, action, new_value, changed_by)
        VALUES (NEW.id, 'created', NEW.amount::TEXT || ' ' || NEW.currency, v_user_vaishnava_id);
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.is_confirmed IS DISTINCT FROM NEW.is_confirmed THEN
            INSERT INTO crm_payment_history (payment_id, action, field, old_value, new_value, changed_by)
            VALUES (NEW.id,
                    CASE WHEN NEW.is_confirmed THEN 'confirmed' ELSE 'unconfirmed' END,
                    'is_confirmed', OLD.is_confirmed::TEXT, NEW.is_confirmed::TEXT,
                    v_user_vaishnava_id);
        END IF;

        IF OLD.payment_system_id IS DISTINCT FROM NEW.payment_system_id THEN
            INSERT INTO crm_payment_history (payment_id, action, field, old_value, new_value, changed_by)
            VALUES (NEW.id, 'updated', 'payment_system_id',
                    OLD.payment_system_id::TEXT, NEW.payment_system_id::TEXT,
                    v_user_vaishnava_id);
        END IF;

        IF OLD.amount IS DISTINCT FROM NEW.amount OR OLD.currency IS DISTINCT FROM NEW.currency OR OLD.rate_to_inr IS DISTINCT FROM NEW.rate_to_inr THEN
            INSERT INTO crm_payment_history (payment_id, action, field, old_value, new_value, changed_by)
            VALUES (NEW.id, 'updated', 'amount',
                    OLD.amount::TEXT || ' ' || OLD.currency,
                    NEW.amount::TEXT || ' ' || NEW.currency,
                    v_user_vaishnava_id);
        END IF;

        IF OLD.received_at IS DISTINCT FROM NEW.received_at THEN
            INSERT INTO crm_payment_history (payment_id, action, field, old_value, new_value, changed_by)
            VALUES (NEW.id, 'updated', 'received_at',
                    OLD.received_at::TEXT, NEW.received_at::TEXT,
                    v_user_vaishnava_id);
        END IF;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS crm_payment_history_trigger ON crm_payments;
CREATE TRIGGER crm_payment_history_trigger
    AFTER INSERT OR UPDATE ON crm_payments
    FOR EACH ROW EXECUTE FUNCTION crm_payment_log_history();

-- -----------------------------------------------------------------------------
-- Пересчёт total_paid: только подтверждённые платежи
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_deal_total_paid()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_deal_id UUID;
BEGIN
    v_deal_id := COALESCE(NEW.deal_id, OLD.deal_id);
    UPDATE crm_deals
       SET total_paid = COALESCE(
           (SELECT SUM(amount_inr) FROM crm_payments
             WHERE deal_id = v_deal_id AND is_confirmed = TRUE),
           0)
     WHERE id = v_deal_id;
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Бэкфилл: исторические платежи автоподтверждаем (до появления фичи подтверждения
-- всё что в БД — по определению валидные приходы). Новые будут в is_confirmed=FALSE
-- по дефолту и ждать подтверждения Нитьи-виласини.
UPDATE crm_payments
   SET is_confirmed = TRUE,
       confirmed_at = COALESCE(received_at, created_at, NOW())
 WHERE is_confirmed = FALSE;

-- Разовый пересчёт всех сделок по новой логике
UPDATE crm_deals d SET total_paid = COALESCE(
    (SELECT SUM(amount_inr) FROM crm_payments WHERE deal_id = d.id AND is_confirmed = TRUE),
    0);
