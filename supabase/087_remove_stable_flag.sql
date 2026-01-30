-- ============================================
-- 087: Убрать флаг STABLE из check_is_superuser
-- ============================================

-- Пересоздать функцию без STABLE (по умолчанию VOLATILE)
CREATE OR REPLACE FUNCTION check_is_superuser()
RETURNS BOOLEAN AS $$
DECLARE
    result BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM vaishnavas
        WHERE user_id = auth.uid()
          AND is_superuser = true
          AND is_deleted = false
    ) INTO result;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- Без STABLE - будет VOLATILE по умолчанию
