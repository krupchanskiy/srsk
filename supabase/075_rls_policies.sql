-- 075_rls_policies.sql
-- RLS политики для защиты данных на уровне БД
-- Функция проверки прав has_permission()

-- ============================================================================
-- ФУНКЦИЯ ПРОВЕРКИ НАЛИЧИЯ ПРАВА У ПОЛЬЗОВАТЕЛЯ
-- ============================================================================

CREATE OR REPLACE FUNCTION has_permission(user_uuid UUID, perm_code TEXT)
RETURNS BOOLEAN AS $$
DECLARE
    has_perm BOOLEAN;
    is_super BOOLEAN;
BEGIN
    -- Проверка на суперпользователя
    SELECT COALESCE(is_superuser, false) INTO is_super
    FROM vaishnavas
    WHERE user_id = user_uuid
      AND is_active = true
      AND is_deleted = false;

    -- Суперпользователь имеет все права
    IF is_super THEN
        RETURN true;
    END IF;

    -- Проверка права через роли
    SELECT EXISTS(
        SELECT 1
        FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = user_uuid
          AND p.code = perm_code
          AND ur.is_active = true
    ) INTO has_perm;

    -- Проверка индивидуальных прав (переопределения)
    -- Если право есть через роль, проверить не отозвано ли оно индивидуально
    IF has_perm THEN
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
        -- Если права нет через роль, проверить не добавлено ли оно индивидуально
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

-- ============================================================================
-- RLS ПОЛИТИКИ ДЛЯ VAISHNAVAS
-- ============================================================================

-- Включаем RLS для vaishnavas
ALTER TABLE vaishnavas ENABLE ROW LEVEL SECURITY;

-- Политика просмотра вайшнавов
DROP POLICY IF EXISTS "Users can view vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can view vaishnavas based on permissions"
ON vaishnavas FOR SELECT
USING (
    -- Суперпользователи видят всех
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    -- Пользователи с правом view_vaishnavas
    has_permission(auth.uid(), 'view_vaishnavas')
    OR
    -- Пользователи с правом view_team (команда)
    (is_team_member = true AND has_permission(auth.uid(), 'view_team'))
    OR
    -- Пользователи с правом view_guests (гости)
    (is_team_member = false AND has_permission(auth.uid(), 'view_guests'))
    OR
    -- Пользователи видят себя
    user_id = auth.uid()
);

-- Политика редактирования вайшнавов
DROP POLICY IF EXISTS "Users can edit vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can edit vaishnavas based on permissions"
ON vaishnavas FOR UPDATE
USING (
    -- Суперпользователи могут редактировать всех
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    -- Пользователи с правом edit_vaishnava
    has_permission(auth.uid(), 'edit_vaishnava')
    OR
    -- Пользователи могут редактировать свой профиль
    (user_id = auth.uid() AND has_permission(auth.uid(), 'edit_own_profile'))
);

-- Политика создания вайшнавов
DROP POLICY IF EXISTS "Users can create vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can create vaishnavas based on permissions"
ON vaishnavas FOR INSERT
WITH CHECK (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'create_vaishnava')
);

-- Политика удаления вайшнавов (soft delete через is_deleted)
DROP POLICY IF EXISTS "Users can delete vaishnavas based on permissions" ON vaishnavas;
CREATE POLICY "Users can delete vaishnavas based on permissions"
ON vaishnavas FOR UPDATE
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'delete_vaishnava')
);

-- ============================================================================
-- RLS ПОЛИТИКИ ДЛЯ BOOKINGS (если таблица существует)
-- ============================================================================

-- Проверяем существование таблицы bookings
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'bookings') THEN
        -- Включаем RLS
        ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

        -- Политика просмотра бронирований
        DROP POLICY IF EXISTS "Users can view bookings based on permissions" ON bookings;
        EXECUTE 'CREATE POLICY "Users can view bookings based on permissions"
        ON bookings FOR SELECT
        USING (
            EXISTS(
                SELECT 1 FROM vaishnavas v
                WHERE v.user_id = auth.uid()
                  AND v.is_superuser = true
                  AND v.is_active = true
                  AND v.is_deleted = false
            )
            OR
            has_permission(auth.uid(), ''view_bookings'')
        )';

        -- Политика создания бронирований
        DROP POLICY IF EXISTS "Users can create bookings based on permissions" ON bookings;
        EXECUTE 'CREATE POLICY "Users can create bookings based on permissions"
        ON bookings FOR INSERT
        WITH CHECK (
            EXISTS(
                SELECT 1 FROM vaishnavas v
                WHERE v.user_id = auth.uid()
                  AND v.is_superuser = true
                  AND v.is_active = true
                  AND v.is_deleted = false
            )
            OR
            has_permission(auth.uid(), ''create_booking'')
        )';

        -- Политика редактирования бронирований
        DROP POLICY IF EXISTS "Users can edit bookings based on permissions" ON bookings;
        EXECUTE 'CREATE POLICY "Users can edit bookings based on permissions"
        ON bookings FOR UPDATE
        USING (
            EXISTS(
                SELECT 1 FROM vaishnavas v
                WHERE v.user_id = auth.uid()
                  AND v.is_superuser = true
                  AND v.is_active = true
                  AND v.is_deleted = false
            )
            OR
            has_permission(auth.uid(), ''edit_booking'')
        )';

        -- Политика удаления бронирований
        DROP POLICY IF EXISTS "Users can delete bookings based on permissions" ON bookings;
        EXECUTE 'CREATE POLICY "Users can delete bookings based on permissions"
        ON bookings FOR DELETE
        USING (
            EXISTS(
                SELECT 1 FROM vaishnavas v
                WHERE v.user_id = auth.uid()
                  AND v.is_superuser = true
                  AND v.is_active = true
                  AND v.is_deleted = false
            )
            OR
            has_permission(auth.uid(), ''delete_booking'')
        )';
    END IF;
END $$;

-- ============================================================================
-- RLS ПОЛИТИКИ ДЛЯ ROOMS
-- ============================================================================

-- Включаем RLS для rooms
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

-- Политика просмотра комнат
DROP POLICY IF EXISTS "Users can view rooms based on permissions" ON rooms;
CREATE POLICY "Users can view rooms based on permissions"
ON rooms FOR SELECT
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'view_rooms')
);

-- Политика создания комнат
DROP POLICY IF EXISTS "Users can create rooms based on permissions" ON rooms;
CREATE POLICY "Users can create rooms based on permissions"
ON rooms FOR INSERT
WITH CHECK (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'create_room')
);

-- Политика редактирования комнат
DROP POLICY IF EXISTS "Users can edit rooms based on permissions" ON rooms;
CREATE POLICY "Users can edit rooms based on permissions"
ON rooms FOR UPDATE
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'edit_room')
);

-- Политика удаления комнат
DROP POLICY IF EXISTS "Users can delete rooms based on permissions" ON rooms;
CREATE POLICY "Users can delete rooms based on permissions"
ON rooms FOR DELETE
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'delete_room')
);

-- ============================================================================
-- RLS ПОЛИТИКИ ДЛЯ BUILDINGS
-- ============================================================================

-- Включаем RLS для buildings
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;

-- Политика просмотра зданий
DROP POLICY IF EXISTS "Users can view buildings based on permissions" ON buildings;
CREATE POLICY "Users can view buildings based on permissions"
ON buildings FOR SELECT
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'view_buildings')
);

-- Политика редактирования зданий
DROP POLICY IF EXISTS "Users can edit buildings based on permissions" ON buildings;
CREATE POLICY "Users can edit buildings based on permissions"
ON buildings FOR UPDATE
USING (
    EXISTS(
        SELECT 1 FROM vaishnavas v
        WHERE v.user_id = auth.uid()
          AND v.is_superuser = true
          AND v.is_active = true
          AND v.is_deleted = false
    )
    OR
    has_permission(auth.uid(), 'edit_buildings')
);

-- Комментарий к функции
COMMENT ON FUNCTION has_permission IS 'Проверяет наличие права у пользователя через роли и индивидуальные настройки';
