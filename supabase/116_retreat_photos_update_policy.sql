-- =========================
-- Миграция 116: UPDATE policy для retreat_photos
-- Date: 2026-02-11
-- =========================

-- Политика для UPDATE: те же права, что и для INSERT
-- (кто может загружать фото, тот может обновлять их статус)
CREATE POLICY "Allow UPDATE for upload_photos permission"
  ON public.retreat_photos
  FOR UPDATE
  USING (
    -- Проверка через user_permissions
    EXISTS (
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
      WHERE up.user_id = auth.uid()
        AND p.code = 'upload_photos'
    )
    OR
    -- Проверка через роли
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = auth.uid()
        AND p.code = 'upload_photos'
    )
  );

-- Комментарий
COMMENT ON POLICY "Allow UPDATE for upload_photos permission" ON public.retreat_photos
  IS 'Пользователи с правом upload_photos могут обновлять статус индексации фото';
