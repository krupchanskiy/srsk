-- ============================================
-- 110: Фотогалерея - Переводы
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    -- Навигация
    ('module_photos', 'Фото', 'Photos', 'फ़ोटो', 'layout'),
    ('photos', 'Фото ретритов', 'Retreat Photos', 'रिट्रीट फ़ोटो', 'layout'),
    ('nav_photos', 'Фото', 'Photos', 'फ़ोटो', 'layout'),
    ('nav_upload_photos', 'Загрузка фото', 'Upload Photos', 'फ़ोटो अपलोड', 'layout'),
    ('nav_manage_photos', 'Управление фото', 'Manage Photos', 'फ़ोटो प्रबंधन', 'layout'),
    ('upload_photos', 'Загрузка фото', 'Upload Photos', 'फ़ोटो अपलोड', 'layout'),
    ('manage_photos', 'Управление фото', 'Manage Photos', 'फ़ोटो प्रबंधन', 'layout'),

    -- Страница загрузки
    ('upload_photos_title', 'Загрузка фотографий', 'Upload Photos', 'फ़ोटो अपलोड', 'photos'),
    ('upload_photos_subtitle', 'Загрузите фото с ретрита для индексации и поиска по лицам', 'Upload photos from retreat for indexing and face search', 'अनुक्रमण और चेहरे की खोज के लिए रिट्रीट से फ़ोटो अपलोड करें', 'photos'),
    ('select_retreat', 'Выберите ретрит', 'Select Retreat', 'रिट्रीट चुनें', 'photos'),
    ('day_number', 'День ретрита', 'Retreat Day', 'रिट्रीट दिवस', 'photos'),
    ('day_number_placeholder', 'Например, 3', 'e.g., 3', 'उदा., 3', 'photos'),
    ('drag_drop_zone', 'Перетащите фото сюда', 'Drag photos here', 'यहाँ फ़ोटो खींचें', 'photos'),
    ('or', 'или', 'or', 'या', 'photos'),
    ('select_files', 'Выбрать файлы', 'Select Files', 'फ़ाइलें चुनें', 'photos'),
    ('supported_formats', 'Поддерживаются JPG, PNG. Максимум 50 МБ на файл', 'Supported: JPG, PNG. Max 50 MB per file', 'समर्थित: JPG, PNG. प्रति फ़ाइल अधिकतम 50 MB', 'photos'),
    ('selected_photos', 'Выбрано фото', 'Selected Photos', 'चयनित फ़ोटो', 'photos'),
    ('clear_all', 'Очистить всё', 'Clear All', 'सब साफ़ करें', 'photos'),
    ('upload_button', 'Загрузить фото', 'Upload Photos', 'फ़ोटो अपलोड करें', 'photos'),

    -- Прогресс загрузки
    ('uploading_photos', 'Загрузка фотографий', 'Uploading Photos', 'फ़ोटो अपलोड हो रही हैं', 'photos'),
    ('uploaded', 'Загружено', 'Uploaded', 'अपलोड किया गया', 'photos'),
    ('of', 'из', 'of', 'में से', 'photos'),
    ('current_file', 'Текущий файл', 'Current File', 'वर्तमान फ़ाइल', 'photos'),
    ('upload_speed', 'Скорость', 'Speed', 'गति', 'photos'),
    ('errors', 'Ошибок', 'Errors', 'त्रुटियाँ', 'photos'),
    ('pause', 'Пауза', 'Pause', 'रोकें', 'photos'),
    ('continue', 'Продолжить', 'Continue', 'जारी रखें', 'photos'),
    ('cancel', 'Отменить', 'Cancel', 'रद्द करें', 'photos'),
    ('cancel_confirm', 'Отменить загрузку? Уже загруженные файлы сохранятся.', 'Cancel upload? Already uploaded files will be saved.', 'अपलोड रद्द करें? पहले से अपलोड की गई फ़ाइलें सहेजी जाएंगी।', 'photos'),

    -- Результат
    ('upload_complete', 'Загрузка завершена!', 'Upload Complete!', 'अपलोड पूर्ण!', 'photos'),
    ('successfully_uploaded', 'Успешно загружено', 'Successfully Uploaded', 'सफलतापूर्वक अपलोड किया गया', 'photos'),
    ('failed_to_upload', 'Не удалось загрузить', 'Failed to Upload', 'अपलोड विफल', 'photos'),
    ('indexing_started', 'Индексация лиц запущена. Это займёт несколько минут. После завершения гости смогут найти себя на фото через кнопку "Найти себя".', 'Face indexing started. This will take a few minutes. After completion, guests will be able to find themselves in photos via "Find Me" button.', 'चेहरे की अनुक्रमण शुरू हो गई है। इसमें कुछ मिनट लगेंगे। पूर्ण होने के बाद, अतिथि "मुझे ढूंढें" बटन के माध्यम से फ़ोटो में खुद को ढूंढ सकेंगे।', 'photos'),
    ('upload_more', 'Загрузить ещё', 'Upload More', 'और अपलोड करें', 'photos'),
    ('manage_photos_link', 'Управление фото', 'Manage Photos', 'फ़ोटो प्रबंधन', 'photos'),

    -- Страница управления
    ('manage_photos_title', 'Управление фотографиями', 'Manage Photos', 'फ़ोटो प्रबंधन', 'photos'),
    ('delete_selected', 'Удалить выбранные', 'Delete Selected', 'चयनित हटाएं', 'photos'),
    ('delete_confirm', 'Удалить фото?', 'Delete photos?', 'फ़ोटो हटाएं?', 'photos'),
    ('delete_confirm_text', 'Это действие нельзя отменить. Будет удалено', 'This action cannot be undone. Will delete', 'इस क्रिया को पूर्ववत नहीं किया जा सकता। हटा दिया जाएगा', 'photos'),
    ('reindex_all', 'Переиндексировать все', 'Reindex All', 'सभी का पुनः अनुक्रमण करें', 'photos'),
    ('reindex_all_confirm', 'Переиндексировать все фотографии?', 'Reindex all photos?', 'सभी फ़ोटो का पुनः अनुक्रमण करें?', 'photos'),
    ('reindex_all_confirm_text', 'Все фото будут сброшены в статус "Ожидает" и переиндексированы заново. Это может занять несколько минут.', 'All photos will be reset to "pending" status and reindexed. This may take several minutes.', 'सभी फ़ोटो को "प्रतीक्षारत" स्थिति में रीसेट किया जाएगा और पुनः अनुक्रमित किया जाएगा। इसमें कई मिनट लग सकते हैं।', 'photos'),
    ('reindex_confirm', 'Переиндексировать все фотографии?', 'Reindex all photos?', 'सभी फ़ोटो का पुनः अनुक्रमण करें?', 'photos'),
    ('reindex_confirm_text', 'Это может занять несколько минут. Все фото будут переиндексированы заново.', 'This may take several minutes. All photos will be reindexed.', 'इसमें कई मिनट लग सकते हैं। सभी फ़ोटो का पुनः अनुक्रमण किया जाएगा।', 'photos'),
    ('reindex_pending_confirm', 'Переиндексировать ожидающие фотографии?', 'Reindex pending photos?', 'प्रतीक्षारत फ़ोटो का पुनः अनुक्रमण करें?', 'photos'),
    ('reindex_pending_confirm_text', 'Будут переиндексированы только фото со статусом "Ожидает".', 'Only photos with "Pending" status will be reindexed.', 'केवल "प्रतीक्षारत" स्थिति वाली फ़ोटो का पुनः अनुक्रमण किया जाएगा।', 'photos'),
    ('reindex', 'Переиндексировать', 'Reindex', 'पुनः अनुक्रमण करें', 'photos'),
    ('reindex_started', 'Переиндексация запущена', 'Reindexing started', 'पुनः अनुक्रमण शुरू हो गया', 'photos'),
    ('indexing_status', 'Статус индексации', 'Indexing Status', 'अनुक्रमण स्थिति', 'photos'),
    ('indexed', 'Проиндексировано', 'Indexed', 'अनुक्रमित', 'photos'),
    ('pending', 'Ожидает', 'Pending', 'प्रतीक्षारत', 'photos'),
    ('processing', 'Обрабатывается', 'Processing', 'प्रसंस्करण', 'photos'),
    ('failed', 'Ошибка', 'Failed', 'विफल', 'photos'),
    ('total_photos', 'Всего фото', 'Total Photos', 'कुल फ़ोटो', 'photos'),
    ('select_all', 'Выбрать все', 'Select All', 'सभी चुनें', 'photos'),
    ('selected', 'Выбрано', 'Selected', 'चयनित', 'photos'),
    ('filter_status', 'Фильтр', 'Filter', 'फ़िल्टर', 'photos'),
    ('all', 'Все', 'All', 'सभी', 'photos'),
    ('no_photos', 'Нет фотографий', 'No photos', 'कोई फ़ोटो नहीं', 'photos'),
    ('select_retreat_to_view', 'Выберите ретрит для просмотра фотографий', 'Select a retreat to view photos', 'फ़ोटो देखने के लिए एक रिट्रीट चुनें', 'photos'),
    ('download', 'Скачать', 'Download', 'डाउनलोड', 'photos'),
    ('delete', 'Удалить', 'Delete', 'हटाएं', 'photos'),
    ('successfully_deleted', 'Успешно удалено', 'Successfully deleted', 'सफलतापूर्वक हटा दिया गया', 'photos'),
    ('loading', 'Загрузка...', 'Loading...', 'लोड हो रहा है...', 'photos'),

    -- Ошибки
    ('no_permission', 'У вас нет прав для загрузки фотографий', 'You don''t have permission to upload photos', 'आपके पास फ़ोटो अपलोड करने की अनुमति नहीं है', 'photos'),
    ('select_retreat_error', 'Выберите ретрит', 'Select a retreat', 'एक रिट्रीट चुनें', 'photos'),
    ('select_photos_error', 'Выберите фотографии', 'Select photos', 'फ़ोटो चुनें', 'photos'),
    ('file_too_large', 'Файл слишком большой (максимум 50 МБ)', 'File too large (max 50 MB)', 'फ़ाइल बहुत बड़ी है (अधिकतम 50 MB)', 'photos'),
    ('upload_error', 'Ошибка загрузки', 'Upload Error', 'अपलोड त्रुटि', 'photos'),
    ('failed_to_load_retreats', 'Не удалось загрузить список ретритов', 'Failed to load retreats list', 'रिट्रीट सूची लोड करने में विफल', 'photos')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
