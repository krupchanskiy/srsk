INSERT INTO translations (key, ru, en, hi, context)
VALUES
    ('nav_search_person', 'Поиск человека', 'Search Person', 'व्यक्ति खोजें', 'layout'),
    ('search_person_title', 'Поиск человека на фото', 'Search Person in Photos', 'फ़ोटो में व्यक्ति खोजें', 'layout')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;
