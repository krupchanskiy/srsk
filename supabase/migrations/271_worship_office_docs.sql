-- 271: в библиотеку «Поклонения» можно класть текстовые документы —
-- Word (doc, docx), а также rtf и odt. Раньше хранилище принимало только
-- снимки, pdf, аудио и видео, и документ было не приложить вовсе.
update storage.buckets
   set allowed_mime_types = array(
       select distinct unnest(allowed_mime_types || array[
           'application/msword',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/rtf', 'text/rtf',
           'application/vnd.oasis.opendocument.text'
       ]))
 where id = 'worship';
