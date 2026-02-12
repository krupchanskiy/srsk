-- =========================
-- Миграция 117: Включить Realtime для retreat_photos
-- Date: 2026-02-11
-- =========================

-- Включить Realtime публикацию для retreat_photos
ALTER PUBLICATION supabase_realtime ADD TABLE public.retreat_photos;

-- Комментарий
COMMENT ON TABLE public.retreat_photos IS 'Фотографии ретритов с поддержкой realtime обновлений';
