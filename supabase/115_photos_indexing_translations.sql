-- Миграция 115: Переводы для прогресса индексации фото

INSERT INTO translations (key, ru, en, hi, page) VALUES
    -- Индексация лиц
    ('indexing_faces', 'Индексация лиц', 'Indexing faces', 'चेहरे की अनुक्रमण', 'photos'),

    -- Сообщение о возможности закрыть страницу
    ('indexing_message', 'Вы можете закрыть эту страницу — индексация продолжится автоматически', 'You can close this page — indexing will continue automatically', 'आप यह पृष्ठ बंद कर सकते हैं — अनुक्रमण स्वचालित रूप से जारी रहेगा', 'photos'),

    -- Найдено лиц
    ('faces_found', 'Найдено лиц', 'Faces found', 'चेहरे मिले', 'photos'),

    -- Индексация завершена (заголовок)
    ('indexing_complete_title', 'Индексация завершена!', 'Indexing complete!', 'अनुक्रमण पूरा हुआ!', 'photos'),

    -- Индексация завершена (сообщение)
    ('indexing_complete_message', 'Гости теперь могут найти себя на фото через кнопку "Найти себя"', 'Guests can now find themselves in photos using the "Find me" button', 'अतिथि अब "मुझे खोजें" बटन का उपयोग करके तस्वीरों में खुद को ढूंढ सकते हैं', 'photos'),

    -- Кнопка "Индексация" (dropdown)
    ('reindex', 'Индексация', 'Indexing', 'अनुक्रमण', 'photos'),

    -- Индексировать необработанные
    ('reindex_pending', 'Индексировать необработанные', 'Index unprocessed', 'असंसाधित अनुक्रमित करें', 'photos'),
    ('reindex_pending_hint', 'Только фото со статусом "Ожидает" и "Ошибка"', 'Only pending and failed photos', 'केवल लंबित और विफल फोटो', 'photos'),
    ('reindex_pending_confirm', 'Индексировать необработанные фото?', 'Index unprocessed photos?', 'असंसाधित फ़ोटो अनुक्रमित करें?', 'photos'),
    ('reindex_pending_confirm_text', 'Будут проиндексированы только фото со статусом "ожидает" и "ошибка". Проиндексированные фото не будут затронуты.', 'Only photos with "pending" and "failed" status will be indexed. Already indexed photos won''t be affected.', 'केवल "लंबित" और "विफल" स्थिति वाली फ़ोटो अनुक्रमित की जाएंगी। पहले से अनुक्रमित फ़ोटो प्रभावित नहीं होंगी।', 'photos'),

    -- Переиндексировать всё
    ('reindex_all', 'Переиндексировать всё', 'Reindex all', 'सभी को पुनः अनुक्रमित करें', 'photos'),
    ('reindex_all_hint', 'Сброс всех фото и полная переиндексация', 'Reset all photos and full reindexing', 'सभी फ़ोटो रीसेट और पूर्ण पुनः अनुक्रमण', 'photos'),
    ('reindex_all_confirm', 'Переиндексировать все фотографии?', 'Reindex all photos?', 'सभी फ़ोटो पुनः अनुक्रमित करें?', 'photos'),
    ('reindex_all_confirm_text', 'Все фото будут сброшены в статус "ожидает" и переиндексированы заново. Это может занять несколько минут.', 'All photos will be reset to "pending" status and reindexed. This may take a few minutes.', 'सभी फ़ोटो "लंबित" स्थिति में रीसेट हो जाएंगी और पुनः अनुक्रमित की जाएंगी। इसमें कुछ मिनट लग सकते हैं।', 'photos'),

    -- Индексация запущена
    ('indexing_started', 'Индексация запущена', 'Indexing started', 'अनुक्रमण शुरू हुआ', 'photos'),

    -- Кнопка "Начать"
    ('start', 'Начать', 'Start', 'शुरू करें', 'photos')

ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
