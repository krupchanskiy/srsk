-- =============================================================
-- Финмодуль: отвязка от superuser.
-- Суперпользователь БОЛЬШЕ НЕ получает фин-права автоматически —
-- только явные fin_admin / fin_observer / fin_account_user.
-- Порядок важен: сначала выдача прав АК и ВГ, потом смена гейтов.
-- =============================================================

-- 1. Явная выдача fin_admin: Адриан + Ванамали Гопал (идемпотентно)
INSERT INTO user_permissions (user_id, permission_id, is_granted, reason)
SELECT u.user_id, p.id, true, 'Отвязка финмодуля от superuser (миграция 201)'
FROM (VALUES
    ('2160b531-4e37-4d2a-ba46-cc1ee230cfeb'::uuid),  -- Адриан (Ачинтья Кришна дас)
    ('8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746'::uuid)   -- Ванамали Гопал дас
) AS u(user_id)
CROSS JOIN permissions p
WHERE p.code = 'fin_admin'
  AND NOT EXISTS (
    SELECT 1 FROM user_permissions up
    WHERE up.user_id = u.user_id AND up.permission_id = p.id AND up.is_granted = true
  );

-- 2. Проверка прав без superuser-байпаса (общий has_permission пропускает
--    суперпользователя первой строкой — для финансов это неприемлемо).
--    Логика та же: роли дают право, user_permissions переопределяют.
CREATE OR REPLACE FUNCTION fin_private_has_permission(p_user uuid, p_code text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE has_perm boolean;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
        JOIN permissions p ON p.id = rp.permission_id
        WHERE ur.user_id = p_user AND p.code = p_code AND ur.is_active = true
    ) INTO has_perm;
    IF has_perm THEN
        IF EXISTS(SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                  WHERE up.user_id = p_user AND p.code = p_code AND up.is_granted = false) THEN
            RETURN false;
        END IF;
    ELSE
        IF EXISTS(SELECT 1 FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
                  WHERE up.user_id = p_user AND p.code = p_code AND up.is_granted = true) THEN
            RETURN true;
        END IF;
    END IF;
    RETURN has_perm;
END;
$$;

REVOKE ALL ON FUNCTION fin_private_has_permission(uuid, text) FROM PUBLIC, anon;

-- 3. Гейты финмодуля — только явные права, без is_superuser()
CREATE OR REPLACE FUNCTION fin_is_admin(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND fin_private_has_permission(p_user, 'fin_admin');
$$;

CREATE OR REPLACE FUNCTION fin_is_observer(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND fin_private_has_permission(p_user, 'fin_observer');
$$;

CREATE OR REPLACE FUNCTION fin_is_account_user(p_user uuid DEFAULT auth.uid()) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT p_user IS NOT NULL AND fin_private_has_permission(p_user, 'fin_account_user');
$$;
