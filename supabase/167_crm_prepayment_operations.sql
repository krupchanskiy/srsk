-- =============================================================================
-- Миграция 167: Операции с предоплатой (Перенос / Возврат / Пожертвование)
--               + Баланс участника + триггеры пересчёта + права
-- =============================================================================
-- ТЗ: ТЗ_CRM_Возврат_Пожертвование_1.md (апрель 2026)
-- =============================================================================

-- 1) ОПЕРАЦИИ С ПРЕДОПЛАТОЙ ---------------------------------------------------

CREATE TABLE IF NOT EXISTS crm_prepayment_operations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Источник: предоплата (NULL если операция создаётся "с баланса")
    payment_id      UUID REFERENCES crm_payments(id) ON DELETE SET NULL,

    -- Кому принадлежит операция (обязательно — баланс ведётся по vaishnava + currency)
    vaishnava_id    UUID NOT NULL REFERENCES vaishnavas(id) ON DELETE RESTRICT,

    -- Сделка, из которой делалось распределение (для аудита; NULL если с карточки участника)
    deal_id         UUID REFERENCES crm_deals(id) ON DELETE SET NULL,

    operation_type  TEXT NOT NULL CHECK (operation_type IN ('transfer','refund','donation')),

    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency        TEXT NOT NULL,
    rate_to_inr     NUMERIC(14,4) NOT NULL DEFAULT 1,
    amount_inr      NUMERIC(14,2) NOT NULL,

    -- transfer
    target_deal_id     UUID REFERENCES crm_deals(id) ON DELETE SET NULL,
    target_retreat_id  UUID REFERENCES retreats(id)  ON DELETE SET NULL,
    transfer_note      TEXT,

    -- refund
    refund_status            TEXT CHECK (refund_status IN ('pending','paid')),
    refund_paid_at           TIMESTAMPTZ,
    refund_paid_by           UUID REFERENCES vaishnavas(id),
    refund_payment_system_id UUID REFERENCES crm_payment_systems(id),

    -- donation
    retreat_id     UUID REFERENCES retreats(id) ON DELETE SET NULL,  -- ретрит-получатель
    donation_note  TEXT,

    -- мета
    is_confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at   TIMESTAMPTZ,
    confirmed_by   UUID REFERENCES vaishnavas(id),

    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by     UUID REFERENCES vaishnavas(id),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- По типу операции — обязательность специфичных полей
    CHECK (
        (operation_type = 'transfer')
          OR (operation_type = 'refund'   AND refund_status IS NOT NULL)
          OR (operation_type = 'donation' AND retreat_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_ppo_vaishnava   ON crm_prepayment_operations(vaishnava_id);
CREATE INDEX IF NOT EXISTS idx_ppo_payment     ON crm_prepayment_operations(payment_id);
CREATE INDEX IF NOT EXISTS idx_ppo_deal        ON crm_prepayment_operations(deal_id);
CREATE INDEX IF NOT EXISTS idx_ppo_type        ON crm_prepayment_operations(operation_type);
CREATE INDEX IF NOT EXISTS idx_ppo_refund_status
    ON crm_prepayment_operations(refund_status)
 WHERE operation_type = 'refund';
CREATE INDEX IF NOT EXISTS idx_ppo_target_retreat
    ON crm_prepayment_operations(target_retreat_id)
 WHERE operation_type = 'transfer';

-- 2) БАЛАНС УЧАСТНИКА (одна строка на участника+валюту) -----------------------

CREATE TABLE IF NOT EXISTS crm_participant_balance (
    vaishnava_id  UUID NOT NULL REFERENCES vaishnavas(id) ON DELETE CASCADE,
    currency      TEXT NOT NULL,
    amount        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vaishnava_id, currency)
);

-- 3) ПЕРЕСЧЁТ БАЛАНСА ---------------------------------------------------------
-- Баланс участника в валюте =
--   Σ(подтверждённые предоплаты org_fee по сделкам этого участника в этой валюте)
-- − Σ(операций этого участника в этой валюте — любого типа).
--
-- Если результат > 0 — апсёртим строку, иначе удаляем.

CREATE OR REPLACE FUNCTION recalc_participant_balance(p_vaishnava_id UUID, p_currency TEXT)
RETURNS VOID AS $$
DECLARE
    total_paid       NUMERIC(14,2);
    total_operations NUMERIC(14,2);
    balance          NUMERIC(14,2);
BEGIN
    IF p_vaishnava_id IS NULL OR p_currency IS NULL THEN
        RETURN;
    END IF;

    SELECT COALESCE(SUM(p.amount), 0) INTO total_paid
      FROM crm_payments p
      JOIN crm_deals d ON d.id = p.deal_id
     WHERE d.vaishnava_id  = p_vaishnava_id
       AND p.currency      = p_currency
       AND p.payment_type  = 'org_fee'
       AND p.is_confirmed  = TRUE;

    SELECT COALESCE(SUM(o.amount), 0) INTO total_operations
      FROM crm_prepayment_operations o
     WHERE o.vaishnava_id = p_vaishnava_id
       AND o.currency     = p_currency;

    balance := total_paid - total_operations;

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

-- Триггер пересчёта при изменении операций
CREATE OR REPLACE FUNCTION trg_ppo_recalc_balance() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM recalc_participant_balance(OLD.vaishnava_id, OLD.currency);
        RETURN OLD;
    END IF;

    PERFORM recalc_participant_balance(NEW.vaishnava_id, NEW.currency);

    IF TG_OP = 'UPDATE' AND (OLD.vaishnava_id <> NEW.vaishnava_id OR OLD.currency <> NEW.currency) THEN
        PERFORM recalc_participant_balance(OLD.vaishnava_id, OLD.currency);
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ppo_recalc_balance ON crm_prepayment_operations;
CREATE TRIGGER ppo_recalc_balance
AFTER INSERT OR UPDATE OR DELETE ON crm_prepayment_operations
FOR EACH ROW EXECUTE FUNCTION trg_ppo_recalc_balance();

-- Триггер обновления updated_at (BEFORE)
CREATE OR REPLACE FUNCTION trg_ppo_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ppo_touch_updated_at ON crm_prepayment_operations;
CREATE TRIGGER ppo_touch_updated_at
BEFORE UPDATE ON crm_prepayment_operations
FOR EACH ROW EXECUTE FUNCTION trg_ppo_touch_updated_at();

-- Триггер пересчёта при изменении подтверждения/суммы/валюты предоплаты
CREATE OR REPLACE FUNCTION trg_payment_recalc_balance() RETURNS TRIGGER AS $$
DECLARE
    v_id_new UUID;
    v_id_old UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT vaishnava_id INTO v_id_old FROM crm_deals WHERE id = OLD.deal_id;
        IF v_id_old IS NOT NULL THEN
            PERFORM recalc_participant_balance(v_id_old, OLD.currency);
        END IF;
        RETURN OLD;
    END IF;

    SELECT vaishnava_id INTO v_id_new FROM crm_deals WHERE id = NEW.deal_id;
    IF v_id_new IS NOT NULL THEN
        PERFORM recalc_participant_balance(v_id_new, NEW.currency);
    END IF;

    IF TG_OP = 'UPDATE' THEN
        SELECT vaishnava_id INTO v_id_old FROM crm_deals WHERE id = OLD.deal_id;
        IF v_id_old IS NOT NULL AND (v_id_old <> v_id_new OR OLD.currency <> NEW.currency) THEN
            PERFORM recalc_participant_balance(v_id_old, OLD.currency);
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_recalc_balance ON crm_payments;
CREATE TRIGGER payment_recalc_balance
AFTER INSERT OR UPDATE OR DELETE ON crm_payments
FOR EACH ROW EXECUTE FUNCTION trg_payment_recalc_balance();

-- 4) ПРАВА --------------------------------------------------------------------

INSERT INTO permissions (code, name_ru, name_en, category, sort_order) VALUES
    ('confirm_refund', 'Подтверждение возврата предоплаты', 'Confirm prepayment refund', 'crm', 110)
ON CONFLICT (code) DO NOTHING;

-- Выдаём confirm_refund тому же пользователю, что и confirm_prepayment
-- (Нитья-виласини — id ee76f10d-cff9-4efe-8a28-3cad716673e9, см. миграцию 164)
INSERT INTO user_permissions (user_id, permission_id, is_granted, reason, granted_at)
SELECT 'ee76f10d-cff9-4efe-8a28-3cad716673e9',
       p.id,
       TRUE,
       'Первичная выдача по ТЗ «Возврат/Пожертвование»',
       NOW()
  FROM permissions p
 WHERE p.code = 'confirm_refund'
ON CONFLICT (user_id, permission_id) DO NOTHING;

-- 5) RLS ----------------------------------------------------------------------

ALTER TABLE crm_prepayment_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_participant_balance   ENABLE ROW LEVEL SECURITY;

-- Все авторизованные пользователи — могут читать (фильтрация по правам — на уровне UI)
DROP POLICY IF EXISTS ppo_select ON crm_prepayment_operations;
CREATE POLICY ppo_select ON crm_prepayment_operations
    FOR SELECT USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS ppo_insert ON crm_prepayment_operations;
CREATE POLICY ppo_insert ON crm_prepayment_operations
    FOR INSERT WITH CHECK (auth.role() = 'authenticated');

DROP POLICY IF EXISTS ppo_update ON crm_prepayment_operations;
CREATE POLICY ppo_update ON crm_prepayment_operations
    FOR UPDATE USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS ppo_delete ON crm_prepayment_operations;
CREATE POLICY ppo_delete ON crm_prepayment_operations
    FOR DELETE USING (auth.role() = 'authenticated');

DROP POLICY IF EXISTS pb_select ON crm_participant_balance;
CREATE POLICY pb_select ON crm_participant_balance
    FOR SELECT USING (auth.role() = 'authenticated');

-- 6) i18n ---------------------------------------------------------------------

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('crm_distribute_prepayment',    'Распределить предоплату',             'Distribute prepayment',          'अग्रिम वितरित करें',         'crm'),
    ('crm_distribute',                'Распределить',                       'Distribute',                     'वितरित करें',                 'crm'),
    ('crm_operation_transfer',        'Перенос на ретрит',                  'Transfer to retreat',            'रिट्रीट में स्थानांतरण',         'crm'),
    ('crm_operation_refund',          'Возврат',                            'Refund',                         'वापसी',                       'crm'),
    ('crm_operation_donation',        'Пожертвование',                      'Donation',                       'दान',                         'crm'),
    ('crm_operation_type',            'Тип операции',                       'Operation type',                 'ऑपरेशन प्रकार',                 'crm'),
    ('crm_retreat_undecided',         'Ретрит не определён',                'Retreat undecided',              'रिट्रीट तय नहीं',                'crm'),
    ('crm_refund_pending',            'Ожидает выплаты',                    'Pending payout',                 'भुगतान लंबित',                  'crm'),
    ('crm_refund_paid',               'Выплачен',                           'Paid',                           'भुगतान किया गया',                'crm'),
    ('crm_target_retreat',            'Ретрит-получатель',                  'Target retreat',                 'लक्ष्य रिट्रीट',                   'crm'),
    ('crm_total_distributed',         'Итого распределено',                 'Total distributed',              'कुल वितरित',                    'crm'),
    ('crm_balance_remainder',         'Остаток на балансе',                 'Balance remainder',              'शेष राशि',                      'crm'),
    ('crm_participant_balance',       'Баланс участника',                   'Participant balance',            'प्रतिभागी की शेष राशि',           'crm'),
    ('crm_no_operations',             'Нет операций',                       'No operations',                  'कोई ऑपरेशन नहीं',                'crm'),
    ('crm_balance_available_notice',  'У участника есть нераспределённый остаток', 'Participant has an unallocated balance', 'प्रतिभागी के पास अवितरित शेष है', 'crm'),
    ('crm_apply_to_deal',             'Применить к этой сделке',            'Apply to this deal',             'इस सौदे पर लागू करें',           'crm'),
    ('crm_place_balance',             'Разместить',                         'Place',                          'रखें',                          'crm'),
    ('crm_add_operation_row',         '+ Добавить строку',                  '+ Add row',                      '+ पंक्ति जोड़ें',                  'crm'),
    ('crm_filter_operation_type',     'Тип операции',                       'Operation type',                 'ऑपरेशन प्रकार',                 'crm'),
    ('crm_filter_has_balance',        'Есть остаток на балансе',            'Has balance remainder',          'शेष राशि है',                    'crm'),
    ('crm_operation_history',         'История операции',                   'Operation history',              'ऑपरेशन इतिहास',                  'crm'),
    ('crm_confirm_operation',         'Подтвердить',                        'Confirm',                        'पुष्टि करें',                      'crm'),
    ('crm_mark_refund_paid',          'Отметить выплаченным',               'Mark as paid',                   'भुगतान के रूप में चिह्नित करें',     'crm')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, page = EXCLUDED.page, updated_at = NOW();

-- 7) Первичный пересчёт баланса для существующих участников -------------------

DO $$
DECLARE
    rec RECORD;
BEGIN
    FOR rec IN
        SELECT DISTINCT d.vaishnava_id, p.currency
          FROM crm_payments p
          JOIN crm_deals d ON d.id = p.deal_id
         WHERE p.payment_type = 'org_fee' AND p.is_confirmed = TRUE
    LOOP
        PERFORM recalc_participant_balance(rec.vaishnava_id, rec.currency);
    END LOOP;
END $$;
