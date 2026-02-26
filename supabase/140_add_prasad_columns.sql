-- Столбцы для питания
ALTER TABLE residents ADD COLUMN IF NOT EXISTS breakfast BOOLEAN DEFAULT true;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS lunch BOOLEAN DEFAULT true;

-- Столбцы для групп
ALTER TABLE residents ADD COLUMN IF NOT EXISTS group_name TEXT;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS group_count INTEGER DEFAULT 0;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS group_breakfast INTEGER DEFAULT 0;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS group_lunch INTEGER DEFAULT 0;

-- Категория «Группа»
INSERT INTO resident_categories (slug, name_ru, name_en, name_hi, color, sort_order)
VALUES ('group', 'Группа', 'Group', 'समूह', '#f97316', 3)
ON CONFLICT DO NOTHING;
