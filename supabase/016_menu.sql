-- ============================================
-- Меню: приёмы пищи и блюда
-- ============================================

-- Приёмы пищи (завтрак/обед/ужин за конкретный день)
CREATE TABLE IF NOT EXISTS menu_meals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    meal_type VARCHAR(20) NOT NULL, -- 'breakfast', 'lunch', 'dinner'
    portions INTEGER DEFAULT 50,
    cook_id UUID REFERENCES team_members(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(location_id, date, meal_type)
);

-- Блюда в приёме пищи
CREATE TABLE IF NOT EXISTS menu_dishes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    meal_id UUID NOT NULL REFERENCES menu_meals(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    portion_size DECIMAL(10,2),
    portion_unit VARCHAR(20),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(meal_id, recipe_id)
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_menu_meals_date ON menu_meals(date);
CREATE INDEX IF NOT EXISTS idx_menu_meals_location_date ON menu_meals(location_id, date);
CREATE INDEX IF NOT EXISTS idx_menu_dishes_meal ON menu_dishes(meal_id);

-- Триггер для updated_at
DROP TRIGGER IF EXISTS update_menu_meals_updated_at ON menu_meals;
CREATE TRIGGER update_menu_meals_updated_at BEFORE UPDATE ON menu_meals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE menu_meals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public insert menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public update menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public delete menu_meals" ON menu_meals;
CREATE POLICY "Public read menu_meals" ON menu_meals FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert menu_meals" ON menu_meals FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update menu_meals" ON menu_meals FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete menu_meals" ON menu_meals FOR DELETE TO anon USING (true);

ALTER TABLE menu_dishes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public insert menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public update menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public delete menu_dishes" ON menu_dishes;
CREATE POLICY "Public read menu_dishes" ON menu_dishes FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert menu_dishes" ON menu_dishes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update menu_dishes" ON menu_dishes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete menu_dishes" ON menu_dishes FOR DELETE TO anon USING (true);

-- ============================================
-- Добавляем ekadashi поле в recipes (если нет)
-- ============================================
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS ekadashi BOOLEAN DEFAULT false;

-- Обновляем рецепты, подходящие для экадаши
UPDATE recipes SET ekadashi = true WHERE name_en IN (
    'Aloo Gobi', 'Palak Paneer', 'Kachumber Salad', 'Cucumber Raita',
    'Nimbu Pani', 'Sweet Lassi', 'Salted Lassi', 'Aloo Sabji',
    'Sabudana Khichdi', 'Fruit Salad'
);

-- ============================================
-- RLS для holidays (если не настроено)
-- ============================================
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read holidays" ON holidays;
DROP POLICY IF EXISTS "Public insert holidays" ON holidays;
DROP POLICY IF EXISTS "Public update holidays" ON holidays;
DROP POLICY IF EXISTS "Public delete holidays" ON holidays;
CREATE POLICY "Public read holidays" ON holidays FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert holidays" ON holidays FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update holidays" ON holidays FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete holidays" ON holidays FOR DELETE TO anon USING (true);

-- ============================================
-- Переводы для страницы меню
-- ============================================
INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('menu_title', 'Меню', 'Menu', 'मेनू', 'menu'),
    ('today', 'Сегодня', 'Today', 'आज', 'menu'),
    ('week', 'Неделя', 'Week', 'सप्ताह', 'menu'),
    ('month', 'Месяц', 'Month', 'महीना', 'menu'),
    ('breakfast', 'Завтрак', 'Breakfast', 'नाश्ता', 'menu'),
    ('lunch', 'Обед', 'Lunch', 'दोपहर का भोजन', 'menu'),
    ('dinner', 'Ужин', 'Dinner', 'रात का खाना', 'menu'),
    ('portions', 'порций', 'portions', 'पोर्शन', 'menu'),
    ('persons', 'чел.', 'ppl', 'लोग', 'menu'),
    ('cook', 'Повар', 'Cook', 'रसोइया', 'menu'),
    ('select_cook', 'выбрать', 'select', 'चुनें', 'menu'),
    ('add_dish', 'Добавить блюдо', 'Add dish', 'व्यंजन जोड़ें', 'menu'),
    ('search_recipe', 'Поиск', 'Search', 'खोज', 'menu'),
    ('by_category', 'По категории', 'By category', 'श्रेणी द्वारा', 'menu'),
    ('portion_size', 'Размер порции', 'Portion size', 'पोर्शन का आकार', 'menu'),
    ('per_person', 'на человека', 'per person', 'प्रति व्यक्ति', 'menu'),
    ('ekadashi', 'Экадаши', 'Ekadashi', 'एकादशी', 'menu'),
    ('ekadashi_warning', 'не для экадаши', 'not for ekadashi', 'एकादशी के लिए नहीं', 'menu'),
    ('no_retreat', 'Нет ретрита', 'No retreat', 'कोई रिट्रीट नहीं', 'menu'),
    ('print_menu', 'Распечатать', 'Print', 'प्रिंट', 'menu'),
    ('shopping_list', 'Список закупок', 'Shopping list', 'खरीदारी सूची', 'menu'),
    ('nothing_found', 'Ничего не найдено', 'Nothing found', 'कुछ नहीं मिला', 'menu'),
    ('already_added', 'Это блюдо уже добавлено', 'This dish is already added', 'यह व्यंजन पहले से जोड़ा गया है', 'menu'),
    ('confirm_ekadashi', 'день Экадаши! Блюдо содержит зерновые или бобовые. Всё равно добавить?', 'is Ekadashi day! This dish contains grains or legumes. Add anyway?', 'एकादशी का दिन है! इस व्यंजन में अनाज या दालें हैं। फिर भी जोड़ें?', 'menu')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;

-- ============================================
-- Тестовые данные для праздников
-- ============================================
INSERT INTO holidays (date, name_ru, name_en, name_hi, type, fasting_level) VALUES
    ('2025-01-10', 'Шаттила Экадаши', 'Shattila Ekadashi', 'षट्तिला एकादशी', 'ekadashi', 'grain'),
    ('2025-01-25', 'Джая Экадаши', 'Jaya Ekadashi', 'जया एकादशी', 'ekadashi', 'grain'),
    ('2025-02-08', 'Виджая Экадаши', 'Vijaya Ekadashi', 'विजया एकादशी', 'ekadashi', 'grain'),
    ('2025-02-23', 'Амалаки Экадаши', 'Amalaki Ekadashi', 'आमलकी एकादशी', 'ekadashi', 'grain'),
    ('2025-03-10', 'Папамочани Экадаши', 'Papamochani Ekadashi', 'पापमोचनी एकादशी', 'ekadashi', 'grain'),
    ('2025-03-14', 'Гаура Пурнима', 'Gaura Purnima', 'गौर पूर्णिमा', 'appearance', 'grain'),
    ('2025-03-25', 'Камада Экадаши', 'Kamada Ekadashi', 'कामदा एकादशी', 'ekadashi', 'grain')
ON CONFLICT DO NOTHING;

-- ============================================
-- Тестовые данные для меню
-- ============================================
DO $$
DECLARE
    main_loc_id UUID;
    rice_id UUID;
    dal_id UUID;
    chapati_id UUID;
    khichdi_id UUID;
    oats_id UUID;
    salad_id UUID;
    cook1_id UUID;
    cook2_id UUID;
    meal1_id UUID;
    meal2_id UUID;
    meal3_id UUID;
BEGIN
    -- Получаем ID локации
    SELECT id INTO main_loc_id FROM locations WHERE slug = 'main' LIMIT 1;

    -- Получаем ID рецептов
    SELECT id INTO rice_id FROM recipes WHERE name_en = 'Steamed Basmati Rice' LIMIT 1;
    SELECT id INTO dal_id FROM recipes WHERE name_en = 'Dal Tadka' LIMIT 1;
    SELECT id INTO chapati_id FROM recipes WHERE name_en = 'Chapati' LIMIT 1;
    SELECT id INTO khichdi_id FROM recipes WHERE name_en = 'Vegetable Khichdi' LIMIT 1;
    SELECT id INTO oats_id FROM recipes WHERE name_en = 'Oatmeal Porridge' LIMIT 1;
    SELECT id INTO salad_id FROM recipes WHERE name_en = 'Kachumber Salad' LIMIT 1;

    -- Получаем ID поваров
    SELECT id INTO cook1_id FROM team_members LIMIT 1;
    SELECT id INTO cook2_id FROM team_members OFFSET 1 LIMIT 1;

    -- Если есть данные, создаём тестовое меню на сегодня
    IF main_loc_id IS NOT NULL AND rice_id IS NOT NULL THEN
        -- Завтрак
        INSERT INTO menu_meals (location_id, date, meal_type, portions, cook_id)
        VALUES (main_loc_id, CURRENT_DATE, 'breakfast', 50, cook1_id)
        ON CONFLICT (location_id, date, meal_type) DO UPDATE SET portions = 50
        RETURNING id INTO meal1_id;

        IF khichdi_id IS NOT NULL THEN
            INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
            VALUES (meal1_id, khichdi_id, 200, 'г', 1)
            ON CONFLICT (meal_id, recipe_id) DO NOTHING;
        END IF;

        -- Обед
        INSERT INTO menu_meals (location_id, date, meal_type, portions, cook_id)
        VALUES (main_loc_id, CURRENT_DATE, 'lunch', 55, cook2_id)
        ON CONFLICT (location_id, date, meal_type) DO UPDATE SET portions = 55
        RETURNING id INTO meal2_id;

        INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
        VALUES (meal2_id, rice_id, 150, 'г', 1)
        ON CONFLICT (meal_id, recipe_id) DO NOTHING;

        IF dal_id IS NOT NULL THEN
            INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
            VALUES (meal2_id, dal_id, 150, 'г', 2)
            ON CONFLICT (meal_id, recipe_id) DO NOTHING;
        END IF;

        IF salad_id IS NOT NULL THEN
            INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
            VALUES (meal2_id, salad_id, 80, 'г', 3)
            ON CONFLICT (meal_id, recipe_id) DO NOTHING;
        END IF;

        -- Ужин
        INSERT INTO menu_meals (location_id, date, meal_type, portions, cook_id)
        VALUES (main_loc_id, CURRENT_DATE, 'dinner', 50, cook1_id)
        ON CONFLICT (location_id, date, meal_type) DO UPDATE SET portions = 50
        RETURNING id INTO meal3_id;

        IF chapati_id IS NOT NULL THEN
            INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
            VALUES (meal3_id, chapati_id, 3, 'шт', 1)
            ON CONFLICT (meal_id, recipe_id) DO NOTHING;
        END IF;

        IF dal_id IS NOT NULL THEN
            INSERT INTO menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
            VALUES (meal3_id, dal_id, 150, 'г', 2)
            ON CONFLICT (meal_id, recipe_id) DO NOTHING;
        END IF;
    END IF;
END $$;
