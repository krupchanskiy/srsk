-- DB-S-08: закрываем листинг публичных storage-бакетов.
--
-- Проблема: под любым anon JWT через POST /storage/v1/object/list/<bucket>
-- можно было получить список всех файлов во всех 6 публичных бакетах.
-- Особо чувствительно: vaishnava-photos (149 личных фото).
-- По имени файла (UUID_timestamp.jpg) + запрос к /rest/v1/vaishnavas
-- приватность нарушалась.
--
-- Решение: убираем SELECT policies на storage.objects для public-бакетов.
-- Для public-бакетов (public=true) прямой URL /object/public/<bucket>/<file>
-- работает через CDN в обход RLS — сайт продолжает отображать картинки.
-- Листинг же требует RLS — теперь возвращает пусто.
--
-- Verified:
--   * GET /object/public/<bucket>/<real-file> → 200 (картинки грузятся)
--   * POST /object/list/<bucket> → [] (листинг закрыт)
--   * Под superuser JWT листинг тоже закрыт — используйте Supabase Dashboard

BEGIN;

DROP POLICY IF EXISTS "Anyone can view guest photos" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view retreat images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view vaishnava photos" ON storage.objects;
DROP POLICY IF EXISTS "Public read access" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for floor-plans" ON storage.objects;
DROP POLICY IF EXISTS "plants_storage_public_read" ON storage.objects;

COMMIT;
