-- ============================================
-- Добавляем группировку переводов по страницам
-- ============================================

-- Добавляем колонку page
ALTER TABLE translations ADD COLUMN IF NOT EXISTS page text;

-- Создаём индекс для быстрой фильтрации
CREATE INDEX IF NOT EXISTS idx_translations_page ON translations(page);

-- Обновляем существующие переводы по страницам
-- Общие (используются везде)
UPDATE translations SET page = 'common' WHERE key IN (
    'app_name', 'save', 'cancel', 'delete', 'edit', 'close',
    'loading', 'error', 'success', 'confirm_delete', 'yes', 'no',
    'print', 'back_to_top'
);

-- Навигация (хедер, меню)
UPDATE translations SET page = 'navigation' WHERE key IN (
    'nav_kitchen', 'nav_stock', 'nav_ashram', 'nav_settings',
    'nav_menu', 'nav_recipes', 'nav_products',
    'nav_inventory', 'nav_requests', 'nav_receive', 'nav_issue',
    'nav_retreats', 'nav_team', 'nav_accommodation',
    'nav_general', 'nav_users', 'nav_holidays'
);

-- Страница Рецепты
UPDATE translations SET page = 'recipes' WHERE key IN (
    'recipes_title', 'add_recipe', 'search_placeholder', 'show_photos',
    'all', 'minutes', 'output', 'portion', 'no_recipes'
);

-- Страница Продукты
UPDATE translations SET page = 'products' WHERE key IN (
    'products_title', 'add_product', 'col_name', 'col_category',
    'col_unit', 'col_price_range'
);

-- Страница Меню
UPDATE translations SET page = 'menu' WHERE key IN (
    'menu_title', 'breakfast', 'lunch', 'dinner', 'servings'
);

-- Страница Команда
UPDATE translations SET page = 'team' WHERE key IN (
    'team_title', 'add_member', 'total_members', 'present_now', 'expected'
);

-- Страница Ретриты
UPDATE translations SET page = 'retreats' WHERE key IN (
    'retreats_title', 'add_retreat', 'list_view', 'calendar_view', 'participants'
);

-- Фильтры (используются на разных страницах)
UPDATE translations SET page = 'filters' WHERE key IN (
    'filter_all', 'filter_present', 'filter_absent'
);

-- Устанавливаем 'common' для всех оставшихся без page
UPDATE translations SET page = 'common' WHERE page IS NULL;
