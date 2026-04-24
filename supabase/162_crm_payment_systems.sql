-- =============================================================================
-- Миграция 162: Справочник платёжных систем
-- =============================================================================
-- Создаёт таблицу crm_payment_systems и поле payment_system_id в crm_payments.
-- Переносит данные из deprecated-поля payment_method (cash/card/transfer) в
-- новый справочник: cash → Наличные, card/transfer → Другое.
-- Само поле payment_method оставляем как legacy до финальной проверки.
-- =============================================================================

-- Справочник
CREATE TABLE IF NOT EXISTS crm_payment_systems (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    name_ru TEXT NOT NULL,
    name_en TEXT,
    is_archived BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE crm_payment_systems IS 'Справочник платёжных систем (Т-Банк, PayPal, Наличные, и т.д.)';

-- Сид
INSERT INTO crm_payment_systems (code, name_ru, name_en, sort_order) VALUES
    ('tbank', 'Т-Банк', 'T-Bank', 10),
    ('paypal', 'PayPal', 'PayPal', 20),
    ('cash', 'Наличные', 'Cash', 30),
    ('sberbank', 'Сбербанк', 'Sberbank', 40),
    ('usdt', 'USDT', 'USDT', 50),
    ('western_union', 'Western Union', 'Western Union', 60),
    ('other', 'Другое', 'Other', 70)
ON CONFLICT (code) DO NOTHING;

-- Поле в crm_payments
ALTER TABLE crm_payments
    ADD COLUMN IF NOT EXISTS payment_system_id UUID REFERENCES crm_payment_systems(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_crm_payments_payment_system ON crm_payments(payment_system_id);

-- Перенос legacy: payment_method → payment_system_id
UPDATE crm_payments SET payment_system_id = (SELECT id FROM crm_payment_systems WHERE code='cash')
    WHERE payment_system_id IS NULL AND payment_method='cash';

UPDATE crm_payments SET payment_system_id = (SELECT id FROM crm_payment_systems WHERE code='other')
    WHERE payment_system_id IS NULL AND payment_method IN ('card', 'transfer');

-- RLS (по аналогии с crm_currencies — читать всем авторизованным, менять суперюзерам)
ALTER TABLE crm_payment_systems ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_payment_systems_read ON crm_payment_systems
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY crm_payment_systems_write ON crm_payment_systems
    FOR ALL TO authenticated
    USING (EXISTS (SELECT 1 FROM superusers WHERE user_id = auth.uid()))
    WITH CHECK (EXISTS (SELECT 1 FROM superusers WHERE user_id = auth.uid()));
