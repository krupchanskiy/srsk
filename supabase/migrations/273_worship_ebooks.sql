-- 273: электронные книги в библиотеке «Поклонения»: epub, fb2, mobi,
-- azw3, djvu (сканы изданий чаще всего в нём).
update storage.buckets
   set allowed_mime_types = array(
       select distinct unnest(allowed_mime_types || array[
           'application/epub+zip',
           'application/x-fictionbook+xml',
           'application/x-mobipocket-ebook',
           'application/vnd.amazon.ebook',
           'image/vnd.djvu', 'image/x-djvu'
       ]))
 where id = 'worship';
