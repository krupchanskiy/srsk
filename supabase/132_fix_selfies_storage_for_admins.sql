-- Migration: 132_fix_selfies_storage_for_admins.sql
-- Разрешить пользователям с правом upload_photos загружать и удалять временные селфи
-- для поиска человека на фото (страница photos/search.html)

-- INSERT: владелец ИЛИ пользователь с upload_photos
DROP POLICY IF EXISTS "retreat selfies upload by owner" ON storage.objects;

CREATE POLICY "retreat selfies upload by owner"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'retreat-photos'
  AND (storage.foldername(name))[1] = 'selfies'
  AND (
    EXISTS (
      SELECT 1 FROM public.vaishnavas v
      WHERE v.user_id = (SELECT auth.uid())
        AND v.id::text = (storage.foldername(name))[2]
    )
    OR has_permission((SELECT auth.uid()), 'upload_photos')
  )
);

-- DELETE: владелец ИЛИ пользователь с upload_photos
DROP POLICY IF EXISTS "retreat selfies delete by owner" ON storage.objects;

CREATE POLICY "retreat selfies delete by owner"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (storage.foldername(name))[1] = 'selfies'
  AND (
    EXISTS (
      SELECT 1 FROM public.vaishnavas v
      WHERE v.user_id = (SELECT auth.uid())
        AND v.id::text = (storage.foldername(name))[2]
    )
    OR has_permission((SELECT auth.uid()), 'upload_photos')
  )
);
