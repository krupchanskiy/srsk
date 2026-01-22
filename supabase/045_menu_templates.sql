-- ============================================
-- Шаблоны меню
-- ============================================

-- Шаблоны меню
CREATE TABLE IF NOT EXISTS menu_templates (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
    name_ru VARCHAR(255) NOT NULL,
    name_en VARCHAR(255),
    name_hi VARCHAR(255),
    description_ru TEXT,
    description_en TEXT,
    description_hi TEXT,
    day_count INTEGER NOT NULL DEFAULT 7,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Приёмы пищи в шаблоне (день 1, 2, 3...)
CREATE TABLE IF NOT EXISTS menu_template_meals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    template_id UUID NOT NULL REFERENCES menu_templates(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL, -- 1, 2, 3...
    meal_type VARCHAR(20) NOT NULL, -- 'breakfast', 'lunch', 'dinner', 'menu'
    portions INTEGER DEFAULT 50,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(template_id, day_number, meal_type)
);

-- Блюда в шаблоне
CREATE TABLE IF NOT EXISTS menu_template_dishes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    template_meal_id UUID NOT NULL REFERENCES menu_template_meals(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    portion_size DECIMAL(10,2),
    portion_unit VARCHAR(20),
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_menu_templates_location ON menu_templates(location_id);
CREATE INDEX IF NOT EXISTS idx_menu_template_meals_template ON menu_template_meals(template_id);
CREATE INDEX IF NOT EXISTS idx_menu_template_dishes_meal ON menu_template_dishes(template_meal_id);

-- Триггер для updated_at
DROP TRIGGER IF EXISTS update_menu_templates_updated_at ON menu_templates;
CREATE TRIGGER update_menu_templates_updated_at BEFORE UPDATE ON menu_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- RLS политики
-- ============================================

ALTER TABLE menu_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public insert menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public update menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public delete menu_templates" ON menu_templates;
CREATE POLICY "Public read menu_templates" ON menu_templates FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert menu_templates" ON menu_templates FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update menu_templates" ON menu_templates FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete menu_templates" ON menu_templates FOR DELETE TO anon USING (true);

ALTER TABLE menu_template_meals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public insert menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public update menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public delete menu_template_meals" ON menu_template_meals;
CREATE POLICY "Public read menu_template_meals" ON menu_template_meals FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert menu_template_meals" ON menu_template_meals FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update menu_template_meals" ON menu_template_meals FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete menu_template_meals" ON menu_template_meals FOR DELETE TO anon USING (true);

ALTER TABLE menu_template_dishes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public insert menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public update menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public delete menu_template_dishes" ON menu_template_dishes;
CREATE POLICY "Public read menu_template_dishes" ON menu_template_dishes FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert menu_template_dishes" ON menu_template_dishes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update menu_template_dishes" ON menu_template_dishes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete menu_template_dishes" ON menu_template_dishes FOR DELETE TO anon USING (true);

-- ============================================
-- Переводы
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('nav_menu_templates', 'Шаблоны', 'Templates', 'टेम्पलेट', 'layout'),
    ('menu_templates_title', 'Шаблоны меню', 'Menu Templates', 'मेनू टेम्पलेट', 'menu-templates'),
    ('add_template', 'Создать шаблон', 'Create template', 'टेम्पलेट बनाएं', 'menu-templates'),
    ('template_name', 'Название шаблона', 'Template name', 'टेम्पलेट का नाम', 'menu-templates'),
    ('day_count', 'Количество дней', 'Number of days', 'दिनों की संख्या', 'menu-templates'),
    ('day_n', 'День', 'Day', 'दिन', 'menu-templates'),
    ('apply_template', 'Применить шаблон', 'Apply template', 'टेम्पलेट लागू करें', 'menu-templates'),
    ('select_template', 'Выберите шаблон', 'Select template', 'टेम्पलेट चुनें', 'menu-templates'),
    ('select_start_date', 'Выберите начальную дату', 'Select start date', 'प्रारंभ तिथि चुनें', 'menu-templates'),
    ('will_apply_to', 'Будет применено к датам', 'Will apply to dates', 'इन तिथियों पर लागू होगा', 'menu-templates'),
    ('overwrite_existing', 'Меню на эти даты уже существует. Перезаписать?', 'Menu for these dates already exists. Overwrite?', 'इन तिथियों के लिए मेनू पहले से मौजूद है। अधिलेखित करें?', 'menu-templates'),
    ('save_as_template', 'Сохранить как шаблон', 'Save as template', 'टेम्पलेट के रूप में सहेजें', 'menu'),
    ('template_saved', 'Шаблон сохранён', 'Template saved', 'टेम्पलेट सहेजा गया', 'menu-templates'),
    ('template_applied', 'Шаблон применён', 'Template applied', 'टेम्पलेट लागू किया गया', 'menu-templates'),
    ('template_deleted', 'Шаблон удалён', 'Template deleted', 'टेम्पलेट हटाया गया', 'menu-templates'),
    ('confirm_delete_template', 'Удалить шаблон?', 'Delete template?', 'टेम्पलेट हटाएं?', 'menu-templates'),
    ('no_templates', 'Нет шаблонов', 'No templates', 'कोई टेम्पलेट नहीं', 'menu-templates'),
    ('edit_template', 'Редактировать', 'Edit', 'संपादित करें', 'menu-templates'),
    ('date_from', 'С даты', 'From date', 'तिथि से', 'menu-templates'),
    ('date_to', 'По дату', 'To date', 'तिथि तक', 'menu-templates'),
    ('days', 'дней', 'days', 'दिन', 'menu-templates'),
    ('filter_all', 'Все', 'All', 'सभी', 'common'),
    ('import_from_menu', 'Импортировать из меню', 'Import from menu', 'मेनू से आयात करें', 'menu-templates'),
    ('import', 'Импортировать', 'Import', 'आयात करें', 'menu-templates')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
