-- ================================================
-- Функция: get_user_permissions
-- Возвращает все права пользователя одним запросом
-- Оптимизация N+1: вместо 3 запросов — один
-- ================================================

CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id uuid)
RETURNS TABLE(permission_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    -- Права от ролей пользователя
    SELECT DISTINCT p.code
    FROM user_roles ur
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE ur.user_id = p_user_id AND ur.is_active = true

    UNION

    -- Индивидуальные granted права
    SELECT p.code
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = p_user_id AND up.is_granted = true

    EXCEPT

    -- Индивидуальные revoked права
    SELECT p.code
    FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = p_user_id AND up.is_granted = false
$$;

-- Права на выполнение
GRANT EXECUTE ON FUNCTION public.get_user_permissions(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_permissions(uuid) TO anon;
