-- Исправление RLS политик для retreat_photos
-- Добавляем проверку суперпользователя через функцию has_permission
-- Суперпользователи должны иметь доступ ко всем операциям

-- 0. Создаём вспомогательную функцию для Storage policies
-- Storage policies не могут вызывать has_permission напрямую из-за контекста безопасности
CREATE OR REPLACE FUNCTION public.current_user_has_upload_permission()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  is_super BOOLEAN;
  has_perm BOOLEAN;
  user_uuid UUID;
BEGIN
  -- Получаем auth.uid()
  user_uuid := auth.uid();

  IF user_uuid IS NULL THEN
    RETURN false;
  END IF;

  -- Проверка на суперпользователя
  SELECT COALESCE(is_superuser, false) INTO is_super
  FROM public.vaishnavas
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
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON ur.role_id = rp.role_id
    JOIN public.permissions p ON rp.permission_id = p.id
    WHERE ur.user_id = user_uuid
      AND p.code = 'upload_photos'
      AND ur.is_active = true
  ) INTO has_perm;

  -- Проверка индивидуальных прав
  IF has_perm THEN
    IF EXISTS(
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON up.permission_id = p.id
      WHERE up.user_id = user_uuid
        AND p.code = 'upload_photos'
        AND up.is_granted = false
    ) THEN
      RETURN false;
    END IF;
  ELSE
    IF EXISTS(
      SELECT 1 FROM public.user_permissions up
      JOIN public.permissions p ON up.permission_id = p.id
      WHERE up.user_id = user_uuid
        AND p.code = 'upload_photos'
        AND up.is_granted = true
    ) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN has_perm;
END;
$$;

COMMENT ON FUNCTION public.current_user_has_upload_permission IS
'Проверяет право upload_photos для текущего пользователя (auth.uid()). Суперпользователи имеют это право автоматически. Используется в Storage policies.';

-- 1. Пересоздаём политику INSERT
DROP POLICY IF EXISTS "retreat_photos_insert" ON public.retreat_photos;

CREATE POLICY "retreat_photos_insert" ON public.retreat_photos
FOR INSERT
WITH CHECK (
  -- Используем has_permission, которая автоматически даёт все права суперпользователям
  has_permission(auth.uid(), 'upload_photos')
);

-- 2. Пересоздаём политику DELETE
DROP POLICY IF EXISTS "retreat_photos_delete" ON public.retreat_photos;

CREATE POLICY "retreat_photos_delete" ON public.retreat_photos
FOR DELETE
USING (
  -- Используем has_permission, которая автоматически даёт все права суперпользователям
  has_permission(auth.uid(), 'upload_photos')
);

-- 3. Исправляем Storage политику INSERT для bucket retreat-photos
DROP POLICY IF EXISTS "retreat photos upload by photographers" ON storage.objects;

CREATE POLICY "retreat photos upload by photographers"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'retreat-photos'
  AND public.current_user_has_upload_permission()
);

-- 4. Исправляем Storage политику DELETE для bucket retreat-photos
DROP POLICY IF EXISTS "retreat photos delete by photographers" ON storage.objects;

CREATE POLICY "retreat photos delete by photographers"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND public.current_user_has_upload_permission()
);

-- Теперь суперпользователи автоматически могут загружать и удалять фото (и в БД, и в Storage),
-- даже если у них нет явного права 'upload_photos' через роли
