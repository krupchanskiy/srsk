-- Migration: 118_add_thumb_path_to_retreat_photos.sql
-- Add thumbnail path for retreat photos

ALTER TABLE public.retreat_photos
ADD COLUMN IF NOT EXISTS thumb_path TEXT;

COMMENT ON COLUMN public.retreat_photos.thumb_path IS 'Путь к миниатюре в Storage (retreat-photos)';
