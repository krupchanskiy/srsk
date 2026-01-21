-- ============================================
-- ДОБАВЛЕНИЕ ПОЛЯ "РАЗМЕЩЕНИЕ" В ТАБЛИЦУ STOCK
-- ============================================

ALTER TABLE stock ADD COLUMN IF NOT EXISTS placement text;

COMMENT ON COLUMN stock.placement IS 'Где хранится продукт (холодильник, полка и т.д.)';

-- Переводы
INSERT INTO translations (key, ru, en, hi, context) VALUES
('placement', 'Размещение', 'Placement', 'स्थान', 'Поле формы'),
('placement_hint', 'Где хранится (холодильник, полка...)', 'Where stored (fridge, shelf...)', 'कहाँ रखा है (फ्रिज, शेल्फ...)', 'Подсказка')
ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
