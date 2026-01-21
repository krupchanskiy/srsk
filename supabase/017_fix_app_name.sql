-- ============================================
-- Исправление названия: Sri Rupa Seva Kunj (без "a" на конце на английском)
-- ============================================

UPDATE translations
SET en = 'Sri Rupa Seva Kunj'
WHERE key = 'app_name';
