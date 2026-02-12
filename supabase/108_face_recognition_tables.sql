-- =========================
-- Face Recognition: PROD setup
-- Tables: retreat_photos, photo_faces, face_tags, face_search_log
-- Buckets expected: retreat-photos, vaishnava-photos
-- Migration: 108_face_recognition_tables.sql
-- Date: 2026-02-10
-- =========================

-- 0) Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =========================
-- 1) ТАБЛИЦА: retreat_photos
-- =========================
-- Фото ретрита
CREATE TABLE IF NOT EXISTS public.retreat_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  retreat_id UUID REFERENCES public.retreats(id) NOT NULL,
  storage_path TEXT NOT NULL,          -- путь в Supabase Storage
  -- thumbnails не хранятся: CDN Image Transforms генерирует на лету
  uploaded_by UUID REFERENCES auth.users(id),
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  width INT,
  height INT,
  file_size INT,                       -- байты
  day_number INT,                      -- день ретрита (для группировки)
  caption TEXT,                        -- подпись (опционально)
  index_status TEXT DEFAULT 'pending'  -- pending | processing | indexed | failed
    CHECK (index_status IN ('pending', 'processing', 'indexed', 'failed')),
  index_error TEXT                     -- текст ошибки если failed
);

-- Индексы для retreat_photos
CREATE INDEX IF NOT EXISTS retreat_photos_retreat_id_idx
  ON public.retreat_photos(retreat_id);

CREATE INDEX IF NOT EXISTS retreat_photos_status_idx
  ON public.retreat_photos(index_status);

CREATE UNIQUE INDEX IF NOT EXISTS retreat_photos_retreat_path_uq
  ON public.retreat_photos(retreat_id, storage_path);

-- =========================
-- 2) ТАБЛИЦА: photo_faces
-- =========================
-- Связь фото ↔ лица в Rekognition Collection
-- Одно фото может содержать несколько лиц, у каждого свой face_id
CREATE TABLE IF NOT EXISTS public.photo_faces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES public.retreat_photos(id) ON DELETE CASCADE NOT NULL,
  rekognition_face_id TEXT NOT NULL,   -- FaceId из Rekognition IndexFaces response
  bbox_left FLOAT,                     -- координаты лица (из BoundingBox)
  bbox_top FLOAT,
  bbox_width FLOAT,
  bbox_height FLOAT,
  confidence FLOAT,                    -- уверенность распознавания
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(photo_id, rekognition_face_id)
);

-- Индексы для photo_faces
CREATE UNIQUE INDEX IF NOT EXISTS photo_faces_photo_face_uq
  ON public.photo_faces(photo_id, rekognition_face_id);

CREATE INDEX IF NOT EXISTS photo_faces_face_id_idx
  ON public.photo_faces(rekognition_face_id);

CREATE INDEX IF NOT EXISTS photo_faces_photo_id_idx
  ON public.photo_faces(photo_id);

-- =========================
-- 3) ТАБЛИЦА: face_tags
-- =========================
-- Отметки лиц на фото (результаты поиска "найти себя")
CREATE TABLE IF NOT EXISTS public.face_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id UUID REFERENCES public.retreat_photos(id) NOT NULL,
  vaishnava_id UUID REFERENCES public.vaishnavas(id) NOT NULL,
  confidence FLOAT,                    -- уверенность AI (0-100)
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(photo_id, vaishnava_id)       -- один человек на фото = одна запись
);

-- Индексы для face_tags
DO $$
BEGIN
  ALTER TABLE public.face_tags
    ADD CONSTRAINT face_tags_photo_vaishnava_uq UNIQUE (photo_id, vaishnava_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END$$;

CREATE INDEX IF NOT EXISTS face_tags_vaishnava_idx
  ON public.face_tags(vaishnava_id);

CREATE INDEX IF NOT EXISTS face_tags_photo_idx
  ON public.face_tags(photo_id);

-- =========================
-- 4) ТАБЛИЦА: face_search_log
-- =========================
-- Лог поисков (для аналитики, опционально)
CREATE TABLE IF NOT EXISTS public.face_search_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id UUID REFERENCES public.vaishnavas(id) NOT NULL,
  retreat_id UUID REFERENCES public.retreats(id) NOT NULL,
  photos_matched INT DEFAULT 0,
  searched_at TIMESTAMPTZ DEFAULT now()
);

-- Комментарий: Rekognition Collections (одна коллекция на ретрит)
-- Коллекция создаётся при первой загрузке фото на ретрит
-- Имя: retreat_{retreat_id}
-- Удаляется через N месяцев после ретрита (экономия)

-- =========================
-- 5) ТРИГГЕР: updated_at для retreat_photos и face_tags
-- =========================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Триггер для retreat_photos
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='retreat_photos' AND column_name='updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS retreat_photos_set_updated_at ON public.retreat_photos;
    CREATE TRIGGER retreat_photos_set_updated_at
    BEFORE UPDATE ON public.retreat_photos
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

-- Триггер для face_tags
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='face_tags' AND column_name='updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS face_tags_set_updated_at ON public.face_tags;
    CREATE TRIGGER face_tags_set_updated_at
    BEFORE UPDATE ON public.face_tags
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

-- ==========================================================
-- 6) RLS POLICIES
-- ==========================================================

-- ----------------------
-- retreat_photos
-- ----------------------
ALTER TABLE public.retreat_photos ENABLE ROW LEVEL SECURITY;

-- Сбросить старые политики (если были)
DROP POLICY IF EXISTS retreat_photos_select ON public.retreat_photos;
DROP POLICY IF EXISTS retreat_photos_insert ON public.retreat_photos;
DROP POLICY IF EXISTS retreat_photos_update ON public.retreat_photos;
DROP POLICY IF EXISTS retreat_photos_delete ON public.retreat_photos;

-- Чтение: только участники ретрита (зарегистрированные + команда)
CREATE POLICY "retreat_photos_select" ON public.retreat_photos
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.retreat_registrations rr
    JOIN public.vaishnavas v ON v.id = rr.vaishnava_id
    WHERE rr.retreat_id = retreat_photos.retreat_id
      AND v.user_id = auth.uid()
      AND rr.status IN ('guest', 'team')
  )
);

-- Вставка: только пользователи с permission upload_photos
-- Проверяет права через роли И индивидуальные permissions
CREATE POLICY "retreat_photos_insert" ON public.retreat_photos
FOR INSERT
WITH CHECK (
  -- Проверка через роли
  EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE
      ur.user_id = auth.uid()
      AND ur.is_active = true
      AND perm.code = 'upload_photos'
  )
  -- ИЛИ через индивидуальные права
  OR EXISTS (
    SELECT 1 FROM public.user_permissions up
    JOIN public.permissions perm ON perm.id = up.permission_id
    WHERE up.user_id = auth.uid()
      AND up.is_granted = true
      AND perm.code = 'upload_photos'
  )
);

-- Удаление: только пользователи с permission upload_photos
-- Проверяет права через роли И индивидуальные permissions
CREATE POLICY "retreat_photos_delete" ON public.retreat_photos
FOR DELETE
USING (
  -- Проверка через роли
  EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role_id = ur.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE
      ur.user_id = auth.uid()
      AND ur.is_active = true
      AND perm.code = 'upload_photos'
  )
  -- ИЛИ через индивидуальные права
  OR EXISTS (
    SELECT 1 FROM public.user_permissions up
    JOIN public.permissions perm ON perm.id = up.permission_id
    WHERE up.user_id = auth.uid()
      AND up.is_granted = true
      AND perm.code = 'upload_photos'
  )
);

-- ----------------------
-- photo_faces
-- ----------------------
-- Внутренняя таблица: только система (Edge Function с service_role_key)
ALTER TABLE public.photo_faces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS photo_faces_select ON public.photo_faces;
DROP POLICY IF EXISTS photo_faces_insert ON public.photo_faces;
DROP POLICY IF EXISTS photo_faces_update ON public.photo_faces;
DROP POLICY IF EXISTS photo_faces_delete ON public.photo_faces;

CREATE POLICY "photo_faces_select" ON public.photo_faces
FOR SELECT
USING (true);
-- INSERT/UPDATE/DELETE — только service_role (Edge Functions)

-- ----------------------
-- face_tags
-- ----------------------
-- Чтение — участники ретрита, запись — Edge Functions
ALTER TABLE public.face_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS face_tags_select ON public.face_tags;
DROP POLICY IF EXISTS face_tags_insert ON public.face_tags;
DROP POLICY IF EXISTS face_tags_update ON public.face_tags;
DROP POLICY IF EXISTS face_tags_delete ON public.face_tags;

CREATE POLICY "face_tags_select" ON public.face_tags
FOR SELECT
USING (true);
-- INSERT — только service_role

-- ----------------------
-- face_search_log
-- ----------------------
-- Пользователь видит только свои поиски
ALTER TABLE public.face_search_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS face_search_log_select ON public.face_search_log;

CREATE POLICY "face_search_log_select" ON public.face_search_log
FOR SELECT
USING (
  vaishnava_id IN (
    SELECT id FROM public.vaishnavas WHERE user_id = auth.uid()
  )
);

-- ==========================================================
-- 7) КОММЕНТАРИИ К ТАБЛИЦАМ (для документации)
-- ==========================================================
COMMENT ON TABLE public.retreat_photos IS 'Фотографии с ретритов';
COMMENT ON TABLE public.photo_faces IS 'Лица, найденные на фото через AWS Rekognition';
COMMENT ON TABLE public.face_tags IS 'Результаты поиска: связь фото ↔ вайшнав';
COMMENT ON TABLE public.face_search_log IS 'Лог поисков лиц (аналитика)';

-- ==========================================================
-- ПРОВЕРКИ ПОСЛЕ МИГРАЦИИ (раскомментируйте для тестирования)
-- ==========================================================
-- SELECT * FROM public.retreat_photos LIMIT 1;
-- SELECT * FROM public.photo_faces LIMIT 1;
-- SELECT * FROM public.face_tags LIMIT 1;
-- SELECT * FROM public.face_search_log LIMIT 1;
