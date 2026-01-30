-- ============================================
-- 095: Включить RLS обратно с простейшей политикой
-- ============================================

-- Включить RLS обратно
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;

-- Удалить все старые политики на INSERT
DROP POLICY IF EXISTS "Superusers can insert permissions" ON user_permissions;
DROP POLICY IF EXISTS "Anyone can insert" ON user_permissions;

-- Создать функцию БЕЗ SECURITY DEFINER (попробуем другой подход)
CREATE OR REPLACE FUNCTION user_is_in_superusers()
RETURNS BOOLEAN AS $$
BEGIN
    -- Простая проверка без SECURITY DEFINER
    RETURN auth.uid() = ANY(
        SELECT user_id FROM superusers
    );
END;
$$ LANGUAGE plpgsql STABLE;

-- Создать максимально простую политику
CREATE POLICY "Superusers can manage permissions"
ON user_permissions
FOR ALL  -- FOR ALL вместо отдельных INSERT/UPDATE/DELETE
TO authenticated
USING (user_is_in_superusers())
WITH CHECK (user_is_in_superusers());
