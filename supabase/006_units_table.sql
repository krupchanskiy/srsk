-- ============================================
-- Справочник единиц измерения
-- ============================================

-- Создаём таблицу
CREATE TABLE IF NOT EXISTS units (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    code text UNIQUE NOT NULL,    -- 'kg', 'g', 'l', 'ml', 'pcs'
    name_ru text NOT NULL,
    name_en text NOT NULL,
    name_hi text NOT NULL,
    short_ru text NOT NULL,       -- 'кг', 'г', 'л'
    short_en text NOT NULL,       -- 'kg', 'g', 'l'
    short_hi text NOT NULL,       -- 'किग्रा', 'ग्राम'
    type text NOT NULL,           -- 'weight', 'volume', 'count'
    base_unit text,               -- код базовой единицы (g для kg, ml для l)
    to_base_ratio decimal(10,6),  -- 1000 для kg->g, 1000 для l->ml
    sort_order int DEFAULT 0,
    created_at timestamptz DEFAULT now()
);

-- Начальные данные
INSERT INTO units (code, name_ru, name_en, name_hi, short_ru, short_en, short_hi, type, base_unit, to_base_ratio, sort_order) VALUES
-- Вес
('kg', 'Килограмм', 'Kilogram', 'किलोग्राम', 'кг', 'kg', 'किग्रा', 'weight', 'g', 1000, 1),
('g', 'Грамм', 'Gram', 'ग्राम', 'г', 'g', 'ग्राम', 'weight', NULL, 1, 2),
-- Объём
('l', 'Литр', 'Liter', 'लीटर', 'л', 'l', 'ली', 'volume', 'ml', 1000, 3),
('ml', 'Миллилитр', 'Milliliter', 'मिलीलीटर', 'мл', 'ml', 'मिली', 'volume', NULL, 1, 4),
-- Количество
('pcs', 'Штука', 'Piece', 'टुकड़ा', 'шт', 'pcs', 'पीस', 'count', NULL, 1, 5),
('bunch', 'Пучок', 'Bunch', 'गुच्छा', 'пуч.', 'bunch', 'गुच्छा', 'count', NULL, 1, 6),
('pack', 'Упаковка', 'Pack', 'पैक', 'уп.', 'pack', 'पैक', 'count', NULL, 1, 7),
-- Объём (дополнительно)
('cup', 'Стакан', 'Cup', 'कप', 'стак.', 'cup', 'कप', 'volume', 'ml', 250, 8),
('tbsp', 'Столовая ложка', 'Tablespoon', 'बड़ा चम्मच', 'ст.л.', 'tbsp', 'बड़ा चम्मच', 'volume', 'ml', 15, 9),
('tsp', 'Чайная ложка', 'Teaspoon', 'छोटा चम्मच', 'ч.л.', 'tsp', 'छोटा चम्मच', 'volume', 'ml', 5, 10)
ON CONFLICT (code) DO NOTHING;

-- RLS
ALTER TABLE units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read units" ON units;
CREATE POLICY "Public read units" ON units FOR SELECT USING (true);

DROP POLICY IF EXISTS "Admin manage units" ON units;
CREATE POLICY "Admin manage units" ON units FOR ALL USING (true); -- TODO: проверка роли

-- Индекс
CREATE INDEX IF NOT EXISTS idx_units_type ON units(type);
CREATE INDEX IF NOT EXISTS idx_units_code ON units(code);
