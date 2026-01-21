-- ============================================
-- Добавление поля waste_percent (% на очистку)
-- для расчёта закупок овощей и фруктов
-- ============================================

-- Добавляем колонку в таблицу products
ALTER TABLE products ADD COLUMN IF NOT EXISTS waste_percent decimal(5,2) DEFAULT NULL;

-- Комментарий к колонке
COMMENT ON COLUMN products.waste_percent IS 'Процент отходов при очистке (для овощей/фруктов). Используется при расчёте закупок.';

-- ============================================
-- Переводы для UI
-- ============================================
INSERT INTO translations (key, ru, en, hi) VALUES
    ('waste_percent', '% на очистку', 'Waste %', 'छिलका %'),
    ('waste_percent_hint', 'Процент отходов при чистке', 'Percentage of waste during peeling', 'छीलने पर बर्बादी का प्रतिशत'),
    ('waste_percent_example', 'Например: 20 для картофеля', 'Example: 20 for potatoes', 'उदाहरण: आलू के लिए 20')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;
