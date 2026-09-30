-- Починка загрузки файлов (фото рецептов, фото вайшнавов, планы этажей, афиши ретритов).
--
-- Проблема: с 17.04.2026 (миграция 153_storage_bucket_listing_hardening) любая загрузка
-- с upsert: true падала с 403 "new row violates row-level security policy".
-- Supabase Storage при upsert выполняет INSERT ... ON CONFLICT ... RETURNING, а RETURNING
-- требует прав на SELECT по RLS — их и убрала 153-я, закрывая листинг бакетов.
-- В интерфейсе ошибка глушилась в консоль, поэтому повара просто видели рецепт без фото.
--
-- Проверено дифференциально: один и тот же файл, ключ и бакет — без заголовка x-upsert
-- отдаёт 200, с x-upsert: true → 403; после добавления SELECT-политики → 200.
--
-- Решение: вернуть SELECT ровно в том объёме, который нужен для RETURNING,
-- не открывая листинг заново:
--   * recipe-photos, vaishnava-photos — только свои объекты (owner_id = auth.uid()).
--     Имена уникальны (uuid_timestamp), перезаписи чужого объекта не бывает.
--   * floor-plans, retreat-images — бакет целиком: имена фиксированные
--     (floor_N.ext, retreats/<id>.ext), перезапись чужого файла — обычный сценарий,
--     личных данных там нет.

BEGIN;

DROP POLICY IF EXISTS "Authenticated can read own recipe photos" ON storage.objects;
CREATE POLICY "Authenticated can read own recipe photos" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'recipe-photos' AND owner_id = auth.uid()::text);

DROP POLICY IF EXISTS "Authenticated can read own vaishnava photos" ON storage.objects;
CREATE POLICY "Authenticated can read own vaishnava photos" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'vaishnava-photos' AND owner_id = auth.uid()::text);

DROP POLICY IF EXISTS "Authenticated can read floor plans" ON storage.objects;
CREATE POLICY "Authenticated can read floor plans" ON storage.objects
    FOR SELECT TO authenticated USING (bucket_id = 'floor-plans');

DROP POLICY IF EXISTS "Authenticated can read retreat images" ON storage.objects;
CREATE POLICY "Authenticated can read retreat images" ON storage.objects
    FOR SELECT TO authenticated USING (bucket_id = 'retreat-images');

COMMIT;
