-- Добавление недостающих переводов для управления фото
-- (дополнение к миграции 110)

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('reindex_pending', 'Индексировать необработанные', 'Index Unprocessed', 'असंसाधित का अनुक्रमण करें', 'photos'),
    ('reindex_pending_hint', 'Только "Ожидает" и "Ошибка" фото', 'Only pending and failed photos', 'केवल प्रतीक्षारत और विफल फ़ोटो', 'photos'),
    ('reindex_pending_confirm', 'Переиндексировать ожидающие фотографии?', 'Reindex pending photos?', 'प्रतीक्षारत फ़ोटो का पुनः अनुक्रमण करें?', 'photos'),
    ('reindex_pending_confirm_text', 'Будут переиндексированы только фото со статусом "Ожидает" и "Ошибка". Проиндексированные фото не будут затронуты.', 'Only photos with "Pending" and "Failed" status will be reindexed. Already indexed photos will not be affected.', 'केवल "प्रतीक्षारत" और "विफल" स्थिति वाली फ़ोटो का पुनः अनुक्रमण किया जाएगा। पहले से अनुक्रमित फ़ोटो प्रभावित नहीं होंगी।', 'photos'),
    ('reindex_all_confirm', 'Переиндексировать все фотографии?', 'Reindex all photos?', 'सभी फ़ोटो का पुनः अनुक्रमण करें?', 'photos'),
    ('reindex_all_confirm_text', 'Все фото будут сброшены в статус "Ожидает" и переиндексированы заново. Это может занять несколько минут.', 'All photos will be reset to "pending" status and reindexed. This may take several minutes.', 'सभी फ़ोटो को "प्रतीक्षारत" स्थिति में रीसेट किया जाएगा और पुनः अनुक्रमित किया जाएगा। इसमें कई मिनट लग सकते हैं।', 'photos')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
