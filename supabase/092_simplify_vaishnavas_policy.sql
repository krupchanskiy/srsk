-- ============================================
-- 092: Упростить политику vaishnavas без функций
-- ============================================

-- Пересоздать политику SELECT на vaishnavas БЕЗ вызова функций
-- чтобы избежать рекурсии при проверке из user_permissions политики
DROP POLICY IF EXISTS "Users can view vaishnavas based on permissions" ON vaishnavas;

CREATE POLICY "Users can view vaishnavas based on permissions"
ON vaishnavas FOR SELECT
USING (
    -- Пользователь всегда видит себя (для проверки is_superuser)
    user_id = auth.uid()
    OR
    -- Для остальных случаев можно добавить другие условия
    -- но БЕЗ вызова is_superuser() или has_permission() чтобы избежать рекурсии
    is_deleted = false  -- ВРЕМЕННО: все видят незаблокированных
);
