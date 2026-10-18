-- Снимки галереи живут в том же бакете, и правило чтения должно знать о них:
-- иначе набор виден, а картинки в нём — нет.
--
-- Правило то же, что и для текста: файл открывается тому, кто видит запись
-- о нём. Для набора это значит «набор не закрыт и не в архиве», причём
-- проверка идёт по набору, а не по строке снимка — две проверки однажды
-- разошлись бы, и закрытый набор отдал бы свои картинки.
drop policy if exists "worship files read" on storage.objects;
create policy "worship files read" on storage.objects
    for select to authenticated
    using (
        bucket_id = 'worship'
        and worship_can_view()
        and (
            worship_can_write()                      -- отдел видит и незавершённое
            or exists (                              -- снимок в тексте действующей версии
                select 1
                  from worship_versions v,
                       lateral jsonb_array_elements(coalesce(v.doc->'blocks', '[]'::jsonb)) b
                 where v.status in ('published', 'superseded')
                   and b->>'path' = storage.objects.name)
            or exists (                              -- снимок открытого набора
                select 1
                  from worship_images i
                  join worship_albums al on al.id = i.album_id
                 where i.storage_path = storage.objects.name
                   and not al.is_private and not al.is_archived)
            or exists (                              -- файл материала библиотеки
                select 1
                  from worship_attachments t
                  join worship_articles a on a.id = t.article_id
                 where t.storage_path = storage.objects.name
                   and a.status = 'published')
        )
    );
