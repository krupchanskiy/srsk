-- ============================================================
-- Миграция 127: Исправление удаления фото ретритов
-- ============================================================
-- Дата: 12.02.2026
-- Автор: Claude Code
--
-- ПРОБЛЕМА:
-- Фотограф мог удалять фото ретрита напрямую из Storage, минуя Edge Function.
-- Это приводило к тому, что лица оставались в AWS Rekognition (не удалялись).
--
-- РЕШЕНИЕ:
-- 1. Запретить прямое удаление фото ретрита из Storage
-- 2. Разрешить удаление ТОЛЬКО через Edge Function delete-photos (Service Role)
-- 3. Селфи по-прежнему могут удаляться владельцем напрямую
--
-- ПРИМЕНЕНИЕ:
-- Через Supabase Dashboard → SQL Editor → Run (требуются права супер-юзера)
-- ============================================================

-- ===== УДАЛЕНИЕ СТАРОЙ ПОЛИТИКИ =====
DROP POLICY IF EXISTS "retreat photos delete by photographers" ON storage.objects;
DROP POLICY IF EXISTS "retreat selfies delete by owner" ON storage.objects;

-- ===== НОВАЯ ПОЛИТИКА DELETE =====
-- Разрешает удаление только для селфи (владельцем)
-- Фото ретрита удаляются ТОЛЬКО через Edge Function delete-photos
CREATE POLICY "retreat photos delete by photographers" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (
    -- Селфи (selfies/{vaishnava_id}/...) может удалять владелец
    (storage.foldername(name))[1] = 'selfies'
    AND EXISTS (
      SELECT 1
      FROM public.vaishnavas v
      WHERE v.user_id = auth.uid()
        AND v.id::text = (storage.foldername(name))[2]
    )
  )
  -- Фото ретрита ({retreat_id}/{photo_id}.jpg) НЕ может удалять никто напрямую
  -- Удаление ТОЛЬКО через Edge Function delete-photos с Service Role Key
);

COMMENT ON POLICY "retreat photos delete by photographers" ON storage.objects IS
'DELETE: селфи удаляет владелец; фото ретрита удаляется ТОЛЬКО через Edge Function delete-photos (для каскадного удаления из AWS Rekognition)';

-- ===== ПРОВЕРКА ПРИМЕНЕНИЯ =====
-- Должна вернуться 1 строка с новой политикой
SELECT
  schemaname,
  tablename,
  policyname,
  cmd,
  permissive
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname = 'retreat photos delete by photographers';

-- ============================================================
-- ОЖИДАЕМЫЙ РЕЗУЛЬТАТ:
-- schemaname | tablename | policyname                             | cmd    | permissive
-- -----------|-----------|----------------------------------------|--------|------------
-- storage    | objects   | retreat photos delete by photographers | DELETE | PERMISSIVE
--
-- ПОСЛЕ ПРИМЕНЕНИЯ:
-- 1. Фотограф НЕ может удалить фото ретрита напрямую
-- 2. Клиент ОБЯЗАН вызывать Edge Function delete-photos
-- 3. Edge Function с Service Role Key удаляет:
--    - Лица из AWS Rekognition
--    - Файлы из Storage
--    - Записи из БД (каскадом photo_faces и face_tags)
-- ============================================================
