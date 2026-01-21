-- ============================================
-- ЛОКАЛИЗАЦИЯ ЗАКУПЩИКОВ
-- Добавляем поля name_ru, name_en, name_hi
-- ============================================

-- Добавляем новые поля
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS name_ru TEXT;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS name_en TEXT;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS name_hi TEXT;
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- Мигрируем данные из name в name_ru (если name существует и name_ru пустое)
UPDATE buyers SET name_ru = name WHERE name_ru IS NULL AND name IS NOT NULL;

-- Устанавливаем sort_order если не задан
UPDATE buyers SET sort_order = (
    SELECT COUNT(*) FROM buyers b2 WHERE b2.created_at <= buyers.created_at
) WHERE sort_order IS NULL;

-- NOT NULL constraint на name_ru (основной язык)
-- ALTER TABLE buyers ALTER COLUMN name_ru SET NOT NULL;
-- Пока не ставим, чтобы не сломать существующие данные

-- Удаляем старое поле name (опционально, закомментировано для безопасности)
-- ALTER TABLE buyers DROP COLUMN IF EXISTS name;
