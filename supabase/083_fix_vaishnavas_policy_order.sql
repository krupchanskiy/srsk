-- ============================================
-- 083: Исправление порядка проверки условий в RLS политике vaishnavas
-- ============================================

-- Пересоздать политику SELECT на vaishnavas с правильным порядком условий
-- Сначала проверяем user_id = auth.uid() (без рекурсии), потом функции

DROP POLICY IF EXISTS "Users can view vaishnavas based on permissions" ON vaishnavas;

CREATE POLICY "Users can view vaishnavas based on permissions"
ON vaishnavas FOR SELECT
USING (
    -- ВАЖНО: сначала проверяем самое простое условие без функций
    -- чтобы избежать рекурсии при вызове из is_superuser()
    user_id = auth.uid()
    OR
    is_superuser(auth.uid())
    OR
    has_permission(auth.uid(), 'view_vaishnavas')
);
