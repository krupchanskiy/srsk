-- Migration: 129_add_mime_type_to_retreat_photos.sql
-- Add mime_type column for retreat photos

ALTER TABLE public.retreat_photos
ADD COLUMN IF NOT EXISTS mime_type TEXT;

COMMENT ON COLUMN public.retreat_photos.mime_type IS 'MIME-тип файла (image/jpeg, image/png)';
