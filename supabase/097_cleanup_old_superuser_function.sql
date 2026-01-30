-- ============================================
-- 097: Очистка устаревших функций и политик
-- ============================================

-- Удалить старые политики, которые использовали check_is_superuser()
DROP POLICY IF EXISTS "Superusers can update permissions" ON user_permissions;
DROP POLICY IF EXISTS "Superusers can delete permissions" ON user_permissions;
DROP POLICY IF EXISTS "Superusers can insert permissions" ON user_permissions;

-- Удалить временную функцию с хардкодом UUID (миграция 088)
DROP FUNCTION IF EXISTS check_is_superuser();

-- Удалить старую функцию is_superuser (если есть)
DROP FUNCTION IF EXISTS is_superuser();

-- Теперь используется только user_is_in_superusers() из миграции 095
-- и политика "Superusers can manage user permissions" FOR ALL из миграции 096
