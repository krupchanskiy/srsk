-- ============================================
-- 096: Политики INSERT/UPDATE для user_roles и user_permissions
-- ============================================

-- Суперпользователи могут управлять ролями других пользователей
DROP POLICY IF EXISTS "Superusers can manage user roles" ON user_roles;
CREATE POLICY "Superusers can manage user roles"
ON user_roles
FOR ALL
TO authenticated
USING (
    auth.uid() IN (SELECT user_id FROM superusers)
)
WITH CHECK (
    auth.uid() IN (SELECT user_id FROM superusers)
);

-- Суперпользователи могут управлять правами других пользователей
DROP POLICY IF EXISTS "Superusers can manage user permissions" ON user_permissions;
CREATE POLICY "Superusers can manage user permissions"
ON user_permissions
FOR ALL
TO authenticated
USING (
    auth.uid() IN (SELECT user_id FROM superusers)
)
WITH CHECK (
    auth.uid() IN (SELECT user_id FROM superusers)
);
