-- =========================
-- Storage policies for retreat-photos bucket
-- Migration: 109_retreat_photos_storage_policies.sql
-- Date: 2026-02-10
-- =========================
-- Read: retreat participants
-- Write/Delete: photographers (upload_photos permission)
-- Update: forbidden

-- Сбросить старые политики (если были)
DROP POLICY IF EXISTS "retreat photos readable by retreat participants" ON storage.objects;
DROP POLICY IF EXISTS "retreat photos upload by photographers" ON storage.objects;
DROP POLICY IF EXISTS "retreat photos delete by photographers" ON storage.objects;
DROP POLICY IF EXISTS "retreat photos update forbidden" ON storage.objects;

-- =========================
-- SELECT POLICY
-- =========================
-- Чтение: только участники ретрита (зарегистрированные + команда)
CREATE POLICY "retreat photos readable by retreat participants"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND EXISTS (
    SELECT 1
    FROM public.retreat_photos rp
    JOIN public.retreat_registrations rr
      ON rr.retreat_id = rp.retreat_id
    JOIN public.vaishnavas v
      ON v.id = rr.vaishnava_id
    WHERE
      rp.storage_path = storage.objects.name
      AND v.user_id = (SELECT auth.uid())
      AND rr.status IN ('guest', 'team')
  )
);

-- =========================
-- INSERT POLICY
-- =========================
-- Загрузка: только пользователи с permission upload_photos
-- Проверяет права через роли И индивидуальные permissions
CREATE POLICY "retreat photos upload by photographers"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'retreat-photos'
  AND (
    -- Проверка через роли
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions perm ON perm.id = rp.permission_id
      WHERE
        ur.user_id = (SELECT auth.uid())
        AND ur.is_active = true
        AND perm.code = 'upload_photos'
    )
    -- ИЛИ через индивидуальные права
    OR EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions perm ON perm.id = up.permission_id
      WHERE
        up.user_id = (SELECT auth.uid())
        AND up.is_granted = true
        AND perm.code = 'upload_photos'
    )
  )
);

-- =========================
-- INSERT/SELECT/DELETE для селфи пользователей (selfies/{vaishnava_id}/...)
-- =========================
CREATE POLICY "retreat selfies upload by owner"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'retreat-photos'
  AND (storage.foldername(name))[1] = 'selfies'
  AND EXISTS (
    SELECT 1
    FROM public.vaishnavas v
    WHERE v.user_id = (SELECT auth.uid())
      AND v.id::text = (storage.foldername(name))[2]
  )
);

CREATE POLICY "retreat selfies readable by owner"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (storage.foldername(name))[1] = 'selfies'
  AND EXISTS (
    SELECT 1
    FROM public.vaishnavas v
    WHERE v.user_id = (SELECT auth.uid())
      AND v.id::text = (storage.foldername(name))[2]
  )
);

CREATE POLICY "retreat selfies delete by owner"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (storage.foldername(name))[1] = 'selfies'
  AND EXISTS (
    SELECT 1
    FROM public.vaishnavas v
    WHERE v.user_id = (SELECT auth.uid())
      AND v.id::text = (storage.foldername(name))[2]
  )
);

-- =========================
-- DELETE POLICY
-- =========================
-- Удаление: только пользователи с permission upload_photos
-- Проверяет права через роли И индивидуальные permissions
CREATE POLICY "retreat photos delete by photographers"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (
    -- Проверка через роли
    EXISTS (
      SELECT 1
      FROM public.user_roles ur
      JOIN public.role_permissions rp ON rp.role_id = ur.role_id
      JOIN public.permissions perm ON perm.id = rp.permission_id
      WHERE
        ur.user_id = (SELECT auth.uid())
        AND ur.is_active = true
        AND perm.code = 'upload_photos'
    )
    -- ИЛИ через индивидуальные права
    OR EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions perm ON perm.id = up.permission_id
      WHERE
        up.user_id = (SELECT auth.uid())
        AND up.is_granted = true
        AND perm.code = 'upload_photos'
    )
  )
);

-- =========================
-- UPDATE POLICY
-- =========================
-- Обновление: запрещено для всех (фото нельзя изменять после загрузки)
CREATE POLICY "retreat photos update forbidden"
ON storage.objects
FOR UPDATE
TO authenticated
USING (false);

-- =========================
-- КОММЕНТАРИИ
-- =========================
-- Политики обеспечивают:
-- 1. Участники ретрита видят только фото своего ретрита
-- 2. Загружать/удалять могут только фотографы (permission: upload_photos)
-- 3. Изменение файлов запрещено (immutable storage)
