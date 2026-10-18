-- Блок 1.5: хранилище модуля.
--
-- Бакет приватный, в отличие от девяти из десяти бакетов проекта: там файл
-- отдаётся по прямой ссылке в обход любых правил доступа, и снимок из черновика
-- утёк бы раньше, чем черновик. Ссылки выдаются на ограниченный срок.
--
-- Предел размера — на вырост под материалы библиотеки (этап 3); снимки в тексте
-- уменьшаются в браузере до загрузки.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('worship', 'worship', false, 209715200,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
   set public = false,
       file_size_limit = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- Читать — кто вообще видит модуль: снимок в тексте стандарта не секретнее
-- самого стандарта, а отдельная проверка по строке разошлась бы с правилом статьи.
drop policy if exists "worship files read" on storage.objects;
create policy "worship files read" on storage.objects
    for select to authenticated
    using (bucket_id = 'worship' and worship_can_view());

-- Писать — пуджари, и только в свою папку: имя файла не угадывается,
-- а владелец виден по пути.
drop policy if exists "worship files upload" on storage.objects;
create policy "worship files upload" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'worship' and worship_can_write()
                and (storage.foldername(name))[1] = (auth.uid())::text);

drop policy if exists "worship files update" on storage.objects;
create policy "worship files update" on storage.objects
    for update to authenticated
    using (bucket_id = 'worship' and worship_can_write()
           and (storage.foldername(name))[1] = (auth.uid())::text);

-- Удалять свой файл может автор, чужой — старший: снимок, выброшенный
-- из текста, иначе остаётся в хранилище навсегда.
drop policy if exists "worship files delete" on storage.objects;
create policy "worship files delete" on storage.objects
    for delete to authenticated
    using (bucket_id = 'worship'
           and (worship_can_approve()
                or (worship_can_write() and (storage.foldername(name))[1] = (auth.uid())::text)));
