-- ============================================
-- 063: Тип задачи уборки (уборка / смена белья)
-- ============================================

-- Добавляем колонку type в cleaning_tasks
ALTER TABLE cleaning_tasks ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'cleaning';

-- Комментарий для колонки
COMMENT ON COLUMN cleaning_tasks.type IS 'Тип задачи: cleaning (уборка), linen (смена белья)';

-- Переводы
INSERT INTO translations (key, ru, en, hi) VALUES
    ('add_linen', 'Постельное', 'Linen', 'बिस्तर'),
    ('add_linen_title', 'Назначить смену белья', 'Schedule Linen Change', 'बिस्तर बदलाव निर्धारित करें'),
    ('linen_change', 'Смена белья', 'Linen Change', 'बिस्तर बदलाव'),
    ('linen_date', 'Дата смены белья', 'Linen Change Date', 'बिस्तर बदलाव की तारीख')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;
