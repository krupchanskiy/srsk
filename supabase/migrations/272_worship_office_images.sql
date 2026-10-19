-- 272: в библиотеку «Поклонения» — таблицы и презентации (Excel,
-- PowerPoint, их открытые аналоги, csv) и остальные ходовые картинки
-- (gif, bmp, tiff, svg — схемы часто приходят именно так).
update storage.buckets
   set allowed_mime_types = array(
       select distinct unnest(allowed_mime_types || array[
           'application/vnd.ms-excel',
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.oasis.opendocument.spreadsheet',
           'text/csv',
           'application/vnd.ms-powerpoint',
           'application/vnd.openxmlformats-officedocument.presentationml.presentation',
           'application/vnd.oasis.opendocument.presentation',
           'image/gif', 'image/bmp', 'image/tiff', 'image/svg+xml'
       ]))
 where id = 'worship';
