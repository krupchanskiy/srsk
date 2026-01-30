-- 076_user_roles_permissions.sql
-- Таблицы для назначения ролей и прав пользователям
-- Упрощённая версия 047 без team_members и locations

-- ============================================
-- 1. РОЛИ ПОЛЬЗОВАТЕЛЯ
-- ============================================
CREATE TABLE IF NOT EXISTS user_roles (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    is_active BOOLEAN DEFAULT true,
    assigned_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role_id);

-- ============================================
-- 2. ИСКЛЮЧЕНИЯ ПРАВ (+/-)
-- ============================================
CREATE TABLE IF NOT EXISTS user_permissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    is_granted BOOLEAN NOT NULL, -- true = добавить право, false = отнять
    reason TEXT,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, permission_id)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_permission ON user_permissions(permission_id);

-- ============================================
-- RLS POLICIES
-- ============================================
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_permissions ENABLE ROW LEVEL SECURITY;

-- User roles: пользователь видит свои роли
DROP POLICY IF EXISTS "Users can read own roles" ON user_roles;
CREATE POLICY "Users can read own roles" ON user_roles
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- User permissions: пользователь видит свои исключения
DROP POLICY IF EXISTS "Users can read own permissions" ON user_permissions;
CREATE POLICY "Users can read own permissions" ON user_permissions
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

-- Временно: anon может читать (для разработки)
DROP POLICY IF EXISTS "Public read user_roles" ON user_roles;
CREATE POLICY "Public read user_roles" ON user_roles FOR SELECT TO anon USING (true);

DROP POLICY IF EXISTS "Public read user_permissions" ON user_permissions;
CREATE POLICY "Public read user_permissions" ON user_permissions FOR SELECT TO anon USING (true);

-- Комментарии
COMMENT ON TABLE user_roles IS 'Роли назначенные пользователям';
COMMENT ON TABLE user_permissions IS 'Индивидуальные переопределения прав (добавить/убрать конкретное право)';
COMMENT ON COLUMN user_permissions.is_granted IS 'true = добавить право, false = убрать право';
