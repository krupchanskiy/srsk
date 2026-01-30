-- ============================================
-- 079: Исправление бесконечной рекурсии в RLS политиках
-- ============================================

-- Проблема: has_permission() делает SELECT from vaishnavas,
-- но политика на vaishnavas использует has_permission() → рекурсия

-- Решение: Пометить функции как SECURITY DEFINER чтобы они выполнялись
-- с правами владельца и игнорировали RLS

-- 1. Создать вспомогательную функцию для проверки суперпользователя
CREATE OR REPLACE FUNCTION is_superuser(user_uuid UUID)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN EXISTS(
        SELECT 1 FROM vaishnavas
        WHERE user_id = user_uuid
          AND is_superuser = true
          AND is_deleted = false
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Пересоздать has_permission() с SECURITY DEFINER
CREATE OR REPLACE FUNCTION has_permission(user_uuid UUID, perm_code TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    has_perm BOOLEAN;
BEGIN
    -- Проверка на суперпользователя через безопасную функцию
    IF is_superuser(user_uuid) THEN
        RETURN true;
    END IF;

    -- Проверка через роли
    SELECT EXISTS(
        SELECT 1
        FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = user_uuid
          AND p.code = perm_code
          AND ur.is_active = true
    ) INTO has_perm;

    -- Проверка индивидуальных прав (может переопределять роли)
    IF has_perm THEN
        -- Проверить не отозвано ли право индивидуально
        IF EXISTS(
            SELECT 1 FROM user_permissions up
            JOIN permissions p ON up.permission_id = p.id
            WHERE up.user_id = user_uuid
              AND p.code = perm_code
              AND up.is_granted = false
        ) THEN
            RETURN false;
        END IF;
    ELSE
        -- Проверить не добавлено ли право индивидуально
        IF EXISTS(
            SELECT 1 FROM user_permissions up
            JOIN permissions p ON up.permission_id = p.id
            WHERE up.user_id = user_uuid
              AND p.code = perm_code
              AND up.is_granted = true
        ) THEN
            RETURN true;
        END IF;
    END IF;

    RETURN has_perm;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Пересоздать политики на vaishnavas БЕЗ вложенных SELECT
DROP POLICY IF EXISTS "Users can view vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can view vaishnavas based on permissions"
ON vaishnavas FOR SELECT
USING (
    -- Используем функцию вместо прямого SELECT
    is_superuser(auth.uid())
    OR
    has_permission(auth.uid(), 'view_vaishnavas')
    OR
    -- Пользователи видят себя
    user_id = auth.uid()
);

-- 4. Политика редактирования
DROP POLICY IF EXISTS "Users can edit vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can edit vaishnavas based on permissions"
ON vaishnavas FOR UPDATE
USING (
    is_superuser(auth.uid())
    OR
    has_permission(auth.uid(), 'edit_vaishnava')
    OR
    (user_id = auth.uid() AND has_permission(auth.uid(), 'edit_own_profile'))
);

-- 5. Политика создания
DROP POLICY IF EXISTS "Users can create vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can create vaishnavas based on permissions"
ON vaishnavas FOR INSERT
WITH CHECK (
    is_superuser(auth.uid())
    OR
    has_permission(auth.uid(), 'create_vaishnava')
);

-- 6. Политика удаления
DROP POLICY IF EXISTS "Users can delete vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can delete vaishnavas based on permissions"
ON vaishnavas FOR DELETE
USING (
    is_superuser(auth.uid())
    OR
    has_permission(auth.uid(), 'delete_vaishnava')
);
