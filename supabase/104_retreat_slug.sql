-- ============================================
-- Добавление slug для retreats
-- ============================================

-- Добавляем колонку slug для ЧПУ
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS slug VARCHAR(100) UNIQUE;

-- Индекс для быстрого поиска по slug
CREATE INDEX IF NOT EXISTS idx_retreats_slug ON retreats(slug);

-- Обновляем существующие ретриты, генерируя slug из названия
UPDATE retreats
SET slug = LOWER(
    REGEXP_REPLACE(
        REGEXP_REPLACE(
            COALESCE(name_en, name_ru),
            '[^a-zA-Z0-9\s-]', '', 'g'
        ),
        '\s+', '-', 'g'
    )
) || '-' || EXTRACT(YEAR FROM start_date)::TEXT
WHERE slug IS NULL;

-- Комментарий к колонке
COMMENT ON COLUMN retreats.slug IS 'ЧПУ для публичных ссылок (например: vrindavan-2025)';
