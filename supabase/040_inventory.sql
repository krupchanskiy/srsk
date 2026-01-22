-- ============================================
-- ИНВЕНТАРИЗАЦИЯ
-- ============================================

-- Сессии инвентаризации
CREATE TABLE IF NOT EXISTS stock_inventories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    inventory_date DATE NOT NULL DEFAULT CURRENT_DATE,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    number SERIAL
);

-- Позиции инвентаризации
CREATE TABLE IF NOT EXISTS stock_inventory_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventory_id UUID NOT NULL REFERENCES stock_inventories(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    expected_quantity NUMERIC NOT NULL DEFAULT 0,
    actual_quantity NUMERIC,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_stock_inventories_location ON stock_inventories(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_inventories_status ON stock_inventories(status);
CREATE INDEX IF NOT EXISTS idx_stock_inventory_items_inventory ON stock_inventory_items(inventory_id);
CREATE INDEX IF NOT EXISTS idx_stock_inventory_items_product ON stock_inventory_items(product_id);

-- Комментарии
COMMENT ON TABLE stock_inventories IS 'Сессии инвентаризации склада';
COMMENT ON TABLE stock_inventory_items IS 'Позиции инвентаризации с ожидаемым и фактическим количеством';
COMMENT ON COLUMN stock_inventories.status IS 'in_progress = в процессе, completed = завершена, cancelled = отменена';
COMMENT ON COLUMN stock_inventory_items.expected_quantity IS 'Количество по данным системы на момент создания';
COMMENT ON COLUMN stock_inventory_items.actual_quantity IS 'Фактически подсчитанное количество';
