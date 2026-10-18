insert into translations (key, ru, en, hi) values
    ('worship_tags_title', 'Теги', 'Tags', 'टैग'),
    ('worship_search_title', 'Поиск', 'Search', 'खोज')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
