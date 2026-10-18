-- Ключи галереи.
insert into translations (key, ru, en, hi) values
    ('nav_worship_gallery',   'Галерея', 'Gallery', 'चित्रशाला'),
    ('worship_gallery_title', 'Галерея', 'Gallery', 'चित्रशाला'),
    ('worship_gallery_hint',  'Как наряжали, как украшали, как выглядел алтарь. По дате события, а не по дате загрузки.',
                              'How the Deities were dressed and decorated, how the altar looked. By the date of the event, not of the upload.',
                              'कैसे श्रृंगार किया, कैसे सजाया, वेदी कैसी दिखी। अपलोड की नहीं, घटना की तिथि से।'),
    ('worship_gallery_search','Искать по названию и описанию…', 'Search by title and description…', 'शीर्षक और विवरण में खोजें…'),
    ('worship_new_album',     'Новый набор', 'New set', 'नया संग्रह')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
