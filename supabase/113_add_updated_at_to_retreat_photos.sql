-- =========================
-- Add updated_at column to retreat_photos
-- Migration: 113_add_updated_at_to_retreat_photos.sql
-- Date: 2026-02-11
-- =========================

-- Добавить колонку updated_at в таблицу retreat_photos
ALTER TABLE public.retreat_photos
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Установить триггер для автоматического обновления updated_at
DROP TRIGGER IF EXISTS retreat_photos_set_updated_at ON public.retreat_photos;

CREATE TRIGGER retreat_photos_set_updated_at
  BEFORE UPDATE ON public.retreat_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- Комментарий:
-- Теперь таблица retreat_photos имеет два поля:
-- - uploaded_at: когда фото было загружено (не меняется)
-- - updated_at: когда запись была последний раз изменена (обновляется триггером)
