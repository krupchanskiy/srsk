-- ============================================
-- ПРИВЯЗКА РЕЦЕПТОВ К ЛОКАЦИИ
-- ============================================

-- Добавляем поле location_id в recipes
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id) ON DELETE CASCADE;

-- Устанавливаем дефолтную локацию (main) для существующих рецептов
UPDATE recipes SET location_id = (SELECT id FROM locations WHERE slug = 'main' LIMIT 1) WHERE location_id IS NULL;

-- Комментарий
COMMENT ON COLUMN recipes.location_id IS 'Локация (кухня), которой принадлежит рецепт';

-- Индекс для быстрой фильтрации
CREATE INDEX IF NOT EXISTS idx_recipes_location_id ON recipes(location_id);

-- Перевод для типа приёма пищи "Меню дня" (для кафе)
INSERT INTO translations (key, ru, en, hi, page, context) VALUES
('menu', 'Меню дня', 'Menu of the day', 'दिन का मेनू', 'menu', 'Тип приёма пищи для кафе')
ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    page = excluded.page,
    context = excluded.context;
