-- Модуль "Управление" (admin)
-- 1. Добавляем переводы для нового модуля

INSERT INTO translations (key, ru, en, hi) VALUES
    ('module_admin', 'Управление', 'Administration', 'प्रशासन'),
    ('module_admin_subtitle', 'Ретриты, доступ, система', 'Retreats, access, system', 'रिट्रीट, पहुँच, सिस्टम'),
    ('nav_access', 'Доступ', 'Access', 'पहुँच'),
    ('nav_system', 'Система', 'System', 'सिस्टम'),
    ('nav_team', 'Команда', 'Team', 'टीम')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;

-- 2. Удаляем гостевую кухню
DELETE FROM locations WHERE slug = 'guest';
