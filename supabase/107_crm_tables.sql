-- ============================================
-- CRM-модуль: Таблицы, триггеры, RLS, seed-данные
-- ============================================

-- ═══════════════════════════════════════════════════════════════
-- СПРАВОЧНИКИ
-- ═══════════════════════════════════════════════════════════════

-- Валюты
CREATE TABLE crm_currencies (
    code TEXT PRIMARY KEY,              -- RUB, USD, EUR, INR
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_hi TEXT,
    symbol TEXT NOT NULL,               -- ₽, $, €, ₹
    rate_to_inr NUMERIC NOT NULL,       -- курс к рупии
    is_default BOOLEAN DEFAULT FALSE,   -- INR = true
    sort_order INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Типы размещения (для предварительного бронирования)
CREATE TABLE crm_accommodation_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,          -- single, double, shared, self
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_hi TEXT,
    capacity INT DEFAULT 1,
    sort_order INT DEFAULT 0
);

-- Услуги (прайс-лист)
CREATE TABLE crm_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,          -- org_fee, room_single, meals_full, etc.
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_hi TEXT,
    category TEXT NOT NULL,             -- accommodation, meals, transport, other
    unit TEXT,                          -- day, piece, person
    default_price NUMERIC DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0
);

-- Цены по ретритам (переопределение базовых цен)
CREATE TABLE crm_retreat_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retreat_id UUID NOT NULL REFERENCES retreats(id) ON DELETE CASCADE,
    service_id UUID NOT NULL REFERENCES crm_services(id) ON DELETE CASCADE,
    price NUMERIC NOT NULL,
    UNIQUE(retreat_id, service_id)
);

-- Теги гостей (справочник)
CREATE TABLE crm_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_hi TEXT,
    color TEXT DEFAULT '#6b7280',       -- серый по умолчанию
    sort_order INT DEFAULT 0
);

-- Причины отмены (справочник)
CREATE TABLE crm_cancellation_reasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_hi TEXT,
    sort_order INT DEFAULT 0
);

-- Шаблоны сообщений
CREATE TABLE crm_message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,          -- welcome, payment_details, reminder, etc.
    name_ru TEXT NOT NULL,
    name_en TEXT NOT NULL,
    template_ru TEXT NOT NULL,
    template_en TEXT NOT NULL,
    template_hi TEXT,
    sort_order INT DEFAULT 0
);

-- ═══════════════════════════════════════════════════════════════
-- ОСНОВНЫЕ ТАБЛИЦЫ
-- ═══════════════════════════════════════════════════════════════

-- Сделки (одна сделка = один гость на один ретрит)
CREATE TABLE crm_deals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retreat_id UUID NOT NULL REFERENCES retreats(id),
    vaishnava_id UUID NOT NULL REFERENCES vaishnavas(id),

    -- Воронка (10 статусов)
    status TEXT NOT NULL DEFAULT 'lead',
    -- Допустимые: lead, contacted, invoice_sent, prepaid, tickets,
    --             room_booked, checked_in, fully_paid, completed, upsell, cancelled

    -- Режим работы
    work_mode TEXT DEFAULT 'active',    -- active, long_term, paused

    -- Источник
    source TEXT,                        -- website, telegram, referral, repeat, portal
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    referrer_id UUID REFERENCES vaishnavas(id), -- кто порекомендовал

    -- Групповая заявка
    group_id UUID,                      -- связывает семью/группу
    is_group_main BOOLEAN DEFAULT FALSE,-- главный контакт

    -- Менеджер
    manager_id UUID REFERENCES vaishnavas(id),

    -- Предпочтения
    accommodation_preference TEXT,      -- in_ashram, nearby, self
    meals_preference TEXT,              -- ashram, self

    -- Размещение
    accommodation_type_id UUID REFERENCES crm_accommodation_types(id),
    room_id UUID REFERENCES rooms(id),
    booking_id UUID REFERENCES bookings(id),

    -- Финансы (автовычисляемые триггером)
    total_charged NUMERIC DEFAULT 0,
    total_paid NUMERIC DEFAULT 0,
    deposit_balance NUMERIC DEFAULT 0,

    -- Отмена
    cancellation_reason_id UUID REFERENCES crm_cancellation_reasons(id),
    cancellation_note TEXT,

    -- Апсейл
    upsell_result TEXT,                 -- interested, not_now, declined
    upsell_next_retreat_id UUID REFERENCES retreats(id),

    notes TEXT,

    -- Время контактов (для алертов)
    first_contacted_at TIMESTAMPTZ,
    last_contacted_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Теги сделок (many-to-many)
CREATE TABLE crm_deal_tags (
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    tag_id UUID NOT NULL REFERENCES crm_tags(id) ON DELETE CASCADE,
    PRIMARY KEY (deal_id, tag_id)
);

-- История статусов
CREATE TABLE crm_deal_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by UUID REFERENCES vaishnavas(id),
    changed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- РАБОТА МЕНЕДЖЕРОВ
-- ═══════════════════════════════════════════════════════════════

-- Задачи
CREATE TABLE crm_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    assignee_id UUID REFERENCES vaishnavas(id),
    title TEXT NOT NULL,
    description TEXT,
    due_date DATE,
    due_time TIME,
    priority TEXT DEFAULT 'normal',     -- low, normal, high, urgent
    is_auto_created BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    created_by UUID REFERENCES vaishnavas(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Коммуникации
CREATE TABLE crm_communications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                 -- call, whatsapp, telegram, email, note
    direction TEXT,                     -- inbound, outbound, internal
    summary TEXT NOT NULL,
    content TEXT,
    created_by UUID REFERENCES vaishnavas(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Журнал действий менеджеров
CREATE TABLE crm_activity_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID REFERENCES crm_deals(id) ON DELETE SET NULL,
    manager_id UUID REFERENCES vaishnavas(id),
    action_type TEXT NOT NULL,          -- status_change, payment_added, task_created, communication_added, deal_assigned
    action_details JSONB,               -- {old_status, new_status}, {amount, currency}, etc.
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════
-- ФИНАНСЫ
-- ═══════════════════════════════════════════════════════════════

-- Услуги в сделке (начисления)
CREATE TABLE crm_deal_services (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    service_id UUID REFERENCES crm_services(id),
    description TEXT,                   -- доп. описание или кастомная услуга
    quantity NUMERIC DEFAULT 1,
    unit_price NUMERIC NOT NULL,
    total_price NUMERIC NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Оплаты
CREATE TABLE crm_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,

    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL,             -- RUB, USD, EUR, INR
    rate_to_inr NUMERIC NOT NULL,
    amount_inr NUMERIC NOT NULL,        -- автовычисление: amount * rate_to_inr

    payment_type TEXT NOT NULL,         -- org_fee, accommodation, meals, deposit, other
    payment_method TEXT,                -- cash, card, transfer

    received_by UUID REFERENCES vaishnavas(id),
    received_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Траты из депозита
CREATE TABLE crm_deposit_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,

    amount NUMERIC NOT NULL,            -- в INR
    expense_type TEXT NOT NULL,         -- transfer, trip, sim_card, laundry, other
    description TEXT,

    created_by UUID REFERENCES vaishnavas(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Финальные расчёты
CREATE TABLE crm_final_settlements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,

    total_charged NUMERIC NOT NULL,
    total_paid NUMERIC NOT NULL,
    deposit_expenses NUMERIC NOT NULL,
    balance NUMERIC NOT NULL,           -- + вернуть / - доплата

    settlement_type TEXT,               -- refund_cash, refund_card, donation, extra_payment
    settlement_amount NUMERIC,

    settled_by UUID REFERENCES vaishnavas(id),
    settled_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT
);

-- ═══════════════════════════════════════════════════════════════
-- НАСТРОЙКИ
-- ═══════════════════════════════════════════════════════════════

-- Менеджеры ретритов (кто работает с каким ретритом)
CREATE TABLE crm_retreat_managers (
    retreat_id UUID NOT NULL REFERENCES retreats(id) ON DELETE CASCADE,
    manager_id UUID NOT NULL REFERENCES vaishnavas(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (retreat_id, manager_id)
);

-- Очередь распределения заявок (round-robin)
CREATE TABLE crm_manager_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manager_id UUID NOT NULL REFERENCES vaishnavas(id) ON DELETE CASCADE,
    last_assigned_at TIMESTAMPTZ,
    is_active BOOLEAN DEFAULT TRUE
);

-- ═══════════════════════════════════════════════════════════════
-- ИЗМЕНЕНИЯ СУЩЕСТВУЮЩИХ ТАБЛИЦ
-- ═══════════════════════════════════════════════════════════════

-- Добавить оргвзнос в ретриты (если ещё нет)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'retreats' AND column_name = 'org_fee'
    ) THEN
        ALTER TABLE retreats ADD COLUMN org_fee NUMERIC DEFAULT 0;
    END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════
-- ИНДЕКСЫ
-- ═══════════════════════════════════════════════════════════════

CREATE INDEX idx_crm_deals_retreat ON crm_deals(retreat_id);
CREATE INDEX idx_crm_deals_vaishnava ON crm_deals(vaishnava_id);
CREATE INDEX idx_crm_deals_manager ON crm_deals(manager_id);
CREATE INDEX idx_crm_deals_status ON crm_deals(status);
CREATE INDEX idx_crm_deals_group ON crm_deals(group_id);
CREATE INDEX idx_crm_deals_created ON crm_deals(created_at);

CREATE INDEX idx_crm_tasks_deal ON crm_tasks(deal_id);
CREATE INDEX idx_crm_tasks_assignee ON crm_tasks(assignee_id);
CREATE INDEX idx_crm_tasks_due ON crm_tasks(due_date);
CREATE INDEX idx_crm_tasks_completed ON crm_tasks(completed_at);

CREATE INDEX idx_crm_communications_deal ON crm_communications(deal_id);
CREATE INDEX idx_crm_payments_deal ON crm_payments(deal_id);
CREATE INDEX idx_crm_deal_services_deal ON crm_deal_services(deal_id);
CREATE INDEX idx_crm_deposit_expenses_deal ON crm_deposit_expenses(deal_id);
CREATE INDEX idx_crm_activity_log_deal ON crm_activity_log(deal_id);
CREATE INDEX idx_crm_activity_log_manager ON crm_activity_log(manager_id);
CREATE INDEX idx_crm_activity_log_created ON crm_activity_log(created_at);

-- ═══════════════════════════════════════════════════════════════
-- ТРИГГЕРЫ
-- ═══════════════════════════════════════════════════════════════

-- Автообновление updated_at для crm_deals
CREATE TRIGGER crm_deals_updated_at
    BEFORE UPDATE ON crm_deals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Автообновление updated_at для crm_currencies
CREATE TRIGGER crm_currencies_updated_at
    BEFORE UPDATE ON crm_currencies
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Автовычисление amount_inr в payments
CREATE OR REPLACE FUNCTION crm_calc_payment_inr()
RETURNS TRIGGER AS $$
BEGIN
    NEW.amount_inr := NEW.amount * NEW.rate_to_inr;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crm_payments_calc_inr
    BEFORE INSERT OR UPDATE ON crm_payments
    FOR EACH ROW EXECUTE FUNCTION crm_calc_payment_inr();

-- Запись в историю при смене статуса
CREATE OR REPLACE FUNCTION crm_log_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO crm_deal_history (deal_id, old_status, new_status, changed_by)
        VALUES (NEW.id, OLD.status, NEW.status,
            (SELECT id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER crm_deals_status_history
    AFTER UPDATE ON crm_deals
    FOR EACH ROW EXECUTE FUNCTION crm_log_status_change();

-- Пересчёт финансов в сделке
CREATE OR REPLACE FUNCTION crm_recalc_deal_finances()
RETURNS TRIGGER AS $$
DECLARE
    v_deal_id UUID;
    v_charged NUMERIC;
    v_paid NUMERIC;
    v_deposit_in NUMERIC;
    v_deposit_out NUMERIC;
BEGIN
    -- Определяем deal_id
    v_deal_id := COALESCE(NEW.deal_id, OLD.deal_id);

    -- Сумма начислений
    SELECT COALESCE(SUM(total_price), 0) INTO v_charged
    FROM crm_deal_services WHERE deal_id = v_deal_id;

    -- Сумма оплат
    SELECT COALESCE(SUM(amount_inr), 0) INTO v_paid
    FROM crm_payments WHERE deal_id = v_deal_id;

    -- Депозит внесён
    SELECT COALESCE(SUM(amount_inr), 0) INTO v_deposit_in
    FROM crm_payments WHERE deal_id = v_deal_id AND payment_type = 'deposit';

    -- Депозит потрачен
    SELECT COALESCE(SUM(amount), 0) INTO v_deposit_out
    FROM crm_deposit_expenses WHERE deal_id = v_deal_id;

    UPDATE crm_deals SET
        total_charged = v_charged,
        total_paid = v_paid,
        deposit_balance = v_deposit_in - v_deposit_out
    WHERE id = v_deal_id;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER crm_services_recalc
    AFTER INSERT OR UPDATE OR DELETE ON crm_deal_services
    FOR EACH ROW EXECUTE FUNCTION crm_recalc_deal_finances();

CREATE TRIGGER crm_payments_recalc
    AFTER INSERT OR UPDATE OR DELETE ON crm_payments
    FOR EACH ROW EXECUTE FUNCTION crm_recalc_deal_finances();

CREATE TRIGGER crm_expenses_recalc
    AFTER INSERT OR UPDATE OR DELETE ON crm_deposit_expenses
    FOR EACH ROW EXECUTE FUNCTION crm_recalc_deal_finances();

-- Логирование действий в activity_log при изменении статуса
CREATE OR REPLACE FUNCTION crm_log_activity_on_status_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO crm_activity_log (deal_id, manager_id, action_type, action_details)
        VALUES (
            NEW.id,
            (SELECT id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1),
            'status_change',
            jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status)
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER crm_deals_activity_log
    AFTER UPDATE ON crm_deals
    FOR EACH ROW EXECUTE FUNCTION crm_log_activity_on_status_change();

-- ═══════════════════════════════════════════════════════════════
-- RLS ПОЛИТИКИ
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE crm_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_accommodation_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_retreat_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_cancellation_reasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deposit_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_final_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_retreat_managers ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_manager_queue ENABLE ROW LEVEL SECURITY;

-- Политики для всех CRM таблиц (authenticated users)
CREATE POLICY "crm_currencies_all" ON crm_currencies FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_accommodation_types_all" ON crm_accommodation_types FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_services_all" ON crm_services FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_retreat_prices_all" ON crm_retreat_prices FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_tags_all" ON crm_tags FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_cancellation_reasons_all" ON crm_cancellation_reasons FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_message_templates_all" ON crm_message_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_deals_all" ON crm_deals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_deal_tags_all" ON crm_deal_tags FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_deal_history_all" ON crm_deal_history FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_tasks_all" ON crm_tasks FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_communications_all" ON crm_communications FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_activity_log_all" ON crm_activity_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_deal_services_all" ON crm_deal_services FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_payments_all" ON crm_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_deposit_expenses_all" ON crm_deposit_expenses FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_final_settlements_all" ON crm_final_settlements FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_retreat_managers_all" ON crm_retreat_managers FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "crm_manager_queue_all" ON crm_manager_queue FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Политики для анонимных (только чтение справочников для публичной формы)
CREATE POLICY "crm_currencies_anon_read" ON crm_currencies FOR SELECT TO anon USING (true);
CREATE POLICY "crm_accommodation_types_anon_read" ON crm_accommodation_types FOR SELECT TO anon USING (true);
CREATE POLICY "crm_services_anon_read" ON crm_services FOR SELECT TO anon USING (true);

-- ═══════════════════════════════════════════════════════════════
-- REALTIME
-- ═══════════════════════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE crm_deals;
ALTER PUBLICATION supabase_realtime ADD TABLE crm_tasks;
ALTER PUBLICATION supabase_realtime ADD TABLE crm_communications;
ALTER PUBLICATION supabase_realtime ADD TABLE crm_payments;

-- ═══════════════════════════════════════════════════════════════
-- SEED-ДАННЫЕ
-- ═══════════════════════════════════════════════════════════════

-- Валюты
INSERT INTO crm_currencies (code, name_ru, name_en, symbol, rate_to_inr, is_default, sort_order) VALUES
('INR', 'Рупия', 'Rupee', '₹', 1, TRUE, 1),
('RUB', 'Рубль', 'Ruble', '₽', 1.05, FALSE, 2),
('USD', 'Доллар', 'Dollar', '$', 83, FALSE, 3),
('EUR', 'Евро', 'Euro', '€', 89, FALSE, 4);

-- Типы размещения
INSERT INTO crm_accommodation_types (code, name_ru, name_en, capacity, sort_order) VALUES
('single', 'Одноместный', 'Single', 1, 1),
('double', 'Двухместный', 'Double', 2, 2),
('shared', 'Общий', 'Shared', 4, 3),
('self', 'Самостоятельно', 'Self-arranged', 1, 4);

-- Базовые услуги
INSERT INTO crm_services (code, name_ru, name_en, category, unit, default_price, sort_order) VALUES
('org_fee', 'Оргвзнос', 'Organization fee', 'other', 'piece', 5000, 1),
('room_single', 'Одноместный номер', 'Single room', 'accommodation', 'day', 1200, 2),
('room_double', 'Двухместный номер', 'Double room', 'accommodation', 'day', 800, 3),
('room_shared', 'Общий номер', 'Shared room', 'accommodation', 'day', 500, 4),
('meals_full', 'Полное питание', 'Full meals', 'meals', 'day', 600, 5),
('transfer_airport', 'Трансфер аэропорт', 'Airport transfer', 'transport', 'piece', 2500, 6),
('trip_vrindavan', 'Поездка во Вриндаван', 'Vrindavan trip', 'transport', 'piece', 1200, 7),
('sim_card', 'Сим-карта', 'SIM card', 'other', 'piece', 500, 8);

-- Причины отмены
INSERT INTO crm_cancellation_reasons (code, name_ru, name_en, sort_order) VALUES
('financial', 'Финансовые причины', 'Financial reasons', 1),
('visa', 'Не получил визу', 'Visa denied', 2),
('plans_changed', 'Изменились планы', 'Plans changed', 3),
('dates', 'Не устроили даты', 'Dates not suitable', 4),
('other_place', 'Выбрал другое место', 'Chose another place', 5),
('no_response', 'Не ответил / пропал', 'No response', 6),
('other', 'Другое', 'Other', 7);

-- Теги
INSERT INTO crm_tags (code, name_ru, name_en, color, sort_order) VALUES
('vip', 'VIP', 'VIP', '#eab308', 1),
('family', 'Семья с детьми', 'Family with kids', '#22c55e', 2),
('vegan', 'Веган', 'Vegan', '#10b981', 3),
('first_india', 'Первый раз в Индии', 'First time in India', '#3b82f6', 4),
('english_only', 'English only', 'English only', '#8b5cf6', 5);

-- Шаблоны сообщений
INSERT INTO crm_message_templates (code, name_ru, name_en, template_ru, template_en, sort_order) VALUES
('welcome', 'Приветствие', 'Welcome',
 'Харе Кришна! Спасибо за заявку на ретрит "{retreat_name}". Меня зовут {manager_name}, я буду помогать вам с организацией поездки.',
 'Hare Krishna! Thank you for applying to "{retreat_name}" retreat. My name is {manager_name}, I will help you organize your trip.',
 1),
('payment_details', 'Реквизиты для оплаты', 'Payment details',
 'Для оплаты оргвзноса ({org_fee} ₹) используйте следующие реквизиты:

[реквизиты]',
 'To pay the organization fee ({org_fee} ₹), please use the following details:

[details]',
 2),
('reminder', 'Напоминание об оплате', 'Payment reminder',
 'Харе Кришна! Напоминаю об оплате оргвзноса. Если у вас возникли вопросы — пишите!',
 'Hare Krishna! This is a reminder about the organization fee payment. If you have any questions, please let me know!',
 3),
('tickets_request', 'Запрос билетов', 'Tickets request',
 'Харе Кришна! Пожалуйста, пришлите информацию о ваших билетах (дата, время, рейс), чтобы мы организовали трансфер.',
 'Hare Krishna! Please send your flight details (date, time, flight number) so we can arrange the transfer.',
 4),
('checkin_info', 'Информация о заселении', 'Check-in info',
 'Харе Кришна! Ваш номер готов. Ресепшен работает круглосуточно. Адрес: [адрес]. Ждём вас!',
 'Hare Krishna! Your room is ready. Reception is open 24/7. Address: [address]. See you soon!',
 5);
