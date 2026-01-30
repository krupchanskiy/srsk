-- ============================================
-- 081: RLS политики для управления индивидуальными правами
-- ============================================

-- Разрешить INSERT для суперпользователей и пользователей с правом manage_users
DROP POLICY IF EXISTS "Managers can insert permissions" ON user_permissions;
CREATE POLICY "Managers can insert permissions"
ON user_permissions FOR INSERT
WITH CHECK (
    is_superuser(auth.uid())
    OR has_permission(auth.uid(), 'manage_users')
);

-- Разрешить UPDATE для суперпользователей и пользователей с правом manage_users
DROP POLICY IF EXISTS "Managers can update permissions" ON user_permissions;
CREATE POLICY "Managers can update permissions"
ON user_permissions FOR UPDATE
USING (
    is_superuser(auth.uid())
    OR has_permission(auth.uid(), 'manage_users')
);

-- Разрешить DELETE для суперпользователей и пользователей с правом manage_users
DROP POLICY IF EXISTS "Managers can delete permissions" ON user_permissions;
CREATE POLICY "Managers can delete permissions"
ON user_permissions FOR DELETE
USING (
    is_superuser(auth.uid())
    OR has_permission(auth.uid(), 'manage_users')
);
