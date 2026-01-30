-- ============================================
-- 085: Временно разрешить INSERT для всех (ОТЛАДКА)
-- ============================================

-- ВРЕМЕННАЯ политика для отладки - разрешить INSERT всем
DROP POLICY IF EXISTS "Superusers can insert permissions" ON user_permissions;

CREATE POLICY "Superusers can insert permissions"
ON user_permissions FOR INSERT
WITH CHECK (true); -- ВРЕМЕННО: разрешить всем для отладки

-- Остальные политики оставить как есть
