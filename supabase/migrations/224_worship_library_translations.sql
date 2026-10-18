-- Ключи библиотеки.
insert into translations (key, ru, en, hi) values
    ('nav_worship_library',   'Библиотека', 'Library', 'पुस्तकालय'),
    ('worship_library_title', 'Библиотека', 'Library', 'पुस्तकालय'),
    ('worship_library_hint',  'Книги, сканы, записи и заметки. В отличие от стандарта, материал ничего не обязывает — он помогает разобраться.',
                              'Books, scans, recordings and notes. Unlike a standard, a material obliges nothing — it helps you understand.',
                              'पुस्तकें, स्कैन, रिकॉर्डिंग और नोट्स। मानक के विपरीत, सामग्री बाध्य नहीं करती — वह समझने में मदद करती है।'),
    ('worship_library_search','Искать по названию и описанию…', 'Search by title and description…', 'शीर्षक और विवरण में खोजें…'),
    ('worship_new_material',  'Добавить материал', 'Add material', 'सामग्री जोड़ें'),
    ('worship_field_summary', 'О чём это', 'What it is about', 'यह किस बारे में है'),
    ('worship_summary_hint',  'Без описания библиотека за полгода превращается в свалку файлов с именами вроде scan_0012.pdf.',
                              'Without descriptions the library turns into a heap of files named scan_0012.pdf within half a year.',
                              'विवरण के बिना पुस्तकालय छह महीने में scan_0012.pdf जैसे नामों का ढेर बन जाता है।'),
    ('worship_field_author',  'Автор', 'Author', 'लेखक'),
    ('worship_field_source',  'Откуда взято', 'Source', 'स्रोत'),
    ('worship_files_title',   'Файлы и ссылки', 'Files and links', 'फ़ाइलें और लिंक'),
    ('worship_files_hint',    'Видео, которое есть на ютубе, добавляйте ссылкой. Файлом — то, чего больше нигде нет.',
                              'Video that exists on YouTube goes in as a link. Upload only what exists nowhere else.',
                              'जो वीडियो यूट्यूब पर है उसे लिंक से जोड़ें। फ़ाइल — केवल वह जो और कहीं नहीं है।'),
    ('worship_own_text',      'Свой текст', 'Your own text', 'अपना पाठ'),
    ('worship_own_text_hint', 'Заметка, пересказ, выписка — всё, что пригодится рядом с файлом. Можно оставить пустым.',
                              'A note, a retelling, an extract — whatever helps next to the file. May be left empty.',
                              'नोट, सारांश, उद्धरण — जो फ़ाइल के साथ काम आए। खाली भी छोड़ा जा सकता है।')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
