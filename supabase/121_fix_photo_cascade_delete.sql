-- Исправление каскадного удаления для фотографий
-- При удалении фото из retreat_photos должны автоматически удаляться связанные записи

-- 1. Удаляем старый constraint для face_tags
ALTER TABLE face_tags
DROP CONSTRAINT IF EXISTS face_tags_photo_id_fkey;

-- 2. Создаём новый constraint с CASCADE
ALTER TABLE face_tags
ADD CONSTRAINT face_tags_photo_id_fkey
FOREIGN KEY (photo_id)
REFERENCES retreat_photos(id)
ON DELETE CASCADE;

-- 3. То же самое для photo_faces (если есть)
ALTER TABLE photo_faces
DROP CONSTRAINT IF EXISTS photo_faces_photo_id_fkey;

ALTER TABLE photo_faces
ADD CONSTRAINT photo_faces_photo_id_fkey
FOREIGN KEY (photo_id)
REFERENCES retreat_photos(id)
ON DELETE CASCADE;

-- Теперь при удалении фото автоматически удалятся:
-- - Все записи в face_tags (отметки лиц)
-- - Все записи в photo_faces (связь с AWS Rekognition face_id)
