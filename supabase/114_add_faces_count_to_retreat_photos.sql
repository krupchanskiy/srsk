-- =========================
-- Добавление поля faces_count в retreat_photos
-- Migration: 114_add_faces_count_to_retreat_photos.sql
-- Date: 2026-02-11
-- =========================

-- Добавить поле faces_count (количество лиц на фото)
ALTER TABLE public.retreat_photos
  ADD COLUMN IF NOT EXISTS faces_count INT DEFAULT 0;

-- Индекс для быстрой фильтрации фото с лицами
CREATE INDEX IF NOT EXISTS retreat_photos_faces_count_idx
  ON public.retreat_photos(faces_count);

-- Комментарий
COMMENT ON COLUMN public.retreat_photos.faces_count IS 'Количество обнаруженных лиц на фото (от IndexFaces)';
