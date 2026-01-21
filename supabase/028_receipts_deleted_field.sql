-- ============================================
-- ДОБАВЛЯЕМ ПОЛЕ deleted В ТАБЛИЦУ stock_receipts
-- ============================================

ALTER TABLE stock_receipts ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE;

-- ============================================
-- ПЕРЕВОДЫ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
-- Страница приёмки - заголовки и вкладки
('receive_title', 'Приёмка товаров', 'Goods Receipt', 'माल रसीद', 'Заголовок'),
('new_receipt_tab', 'Новая приёмка', 'New receipt', 'नई रसीद', 'Вкладка'),
('new_receipt', 'Новая приёмка', 'New receipt', 'नई रसीद', 'Заголовок'),

-- Страница приёмки - выбор режима
('receive_from_request_title', 'Принять из заявки', 'Receive from request', 'अनुरोध से प्राप्त करें', 'Карточка'),
('receive_from_request_desc', 'Загрузить продукты из сохранённой заявки', 'Load products from saved request', 'सहेजे गए अनुरोध से उत्पाद लोड करें', 'Карточка'),
('receive_manual_title', 'Принять вручную', 'Receive manually', 'मैन्युअल रूप से प्राप्त करें', 'Карточка'),
('receive_manual_desc', 'Ввести продукты для приёмки вручную', 'Enter products for receipt manually', 'रसीद के लिए मैन्युअल रूप से उत्पाद दर्ज करें', 'Карточка'),
('create_receipt', 'Создать приёмку', 'Create receipt', 'रसीद बनाएं', 'Кнопка'),
('saved_receipts_tab', 'Сохранённые', 'Saved', 'सहेजे गए', 'Вкладка'),
('archived_receipts_tab', 'Архивные', 'Archived', 'संग्रहीत', 'Вкладка'),
('deleted_receipts_tab', 'Удалённые', 'Deleted', 'हटाए गए', 'Вкладка'),

-- Страница приёмки - форма
('receipt_date', 'Дата', 'Date', 'तारीख', 'Форма'),
('receipt_buyer', 'Кто закупал', 'Buyer', 'खरीदार', 'Форма'),
('products', 'Продукты', 'Products', 'उत्पाद', 'Форма'),
('from_request', 'Из заявки', 'From request', 'अनुरोध से', 'Кнопка'),
('price', 'Цена', 'Price', 'कीमत', 'Таблица'),
('notes', 'Примечания', 'Notes', 'टिप्पणियाँ', 'Форма'),
('load_from_request', 'Загрузить из заявки', 'Load from request', 'अनुरोध से लोड करें', 'Заголовок'),

-- Вкладки и пустые состояния
('deleted_empty', 'Нет удалённых приёмок', 'No deleted receipts', 'कोई हटाई गई रसीदें नहीं', 'Пустое состояние'),
('no_receipts', 'Нет сохранённых приёмок', 'No saved receipts', 'कोई सहेजी गई रसीदें नहीं', 'Пустое состояние'),
('archive_empty', 'Архив пуст', 'Archive is empty', 'संग्रह खाली है', 'Пустое состояние'),

-- Информационные сообщения
('receipt_completed_info', 'Приёмка проведена, склад обновлён', 'Receipt completed, stock updated', 'रसीद पूर्ण, स्टॉक अपडेट किया गया', 'Информация'),
('receipt_cancelled_info', 'Приёмка отменена, склад не пополнялся', 'Receipt cancelled, stock was not updated', 'रसीद रद्द, स्टॉक अपडेट नहीं किया गया', 'Информация'),

-- Плейсхолдеры
('add_product_placeholder', 'Добавить продукт...', 'Add product...', 'उत्पाद जोड़ें...', 'Плейсхолдер'),
('receipt_notes_placeholder', 'Примечания по поставщикам, качеству...', 'Notes about suppliers, quality...', 'आपूर्तिकर्ताओं, गुणवत्ता के बारे में नोट्स...', 'Плейсхолдер'),

-- Кнопки
('restore', 'Восстановить', 'Restore', 'पुनर्स्थापित करें', 'Кнопка'),
('delete_permanently', 'Удалить навсегда', 'Delete permanently', 'स्थायी रूप से हटाएं', 'Кнопка'),
('to_archive', 'В архив', 'To archive', 'संग्रह में', 'Кнопка'),
('delete', 'Удалить', 'Delete', 'हटाएं', 'Кнопка'),
('save_receipt', 'Сохранить приёмку', 'Save receipt', 'रसीद सहेजें', 'Кнопка'),
('saving', 'Сохранение...', 'Saving...', 'सहेजा जा रहा है...', 'Кнопка'),
('yes', 'Да', 'Yes', 'हाँ', 'Кнопка'),
('no', 'Нет', 'No', 'नहीं', 'Кнопка'),
('view', 'Просмотр', 'View', 'देखें', 'Кнопка'),
('print', 'Печать', 'Print', 'प्रिंट', 'Кнопка'),
('close', 'Закрыть', 'Close', 'बंद करें', 'Кнопка'),
('save_changes', 'Сохранить изменения', 'Save changes', 'परिवर्तन सहेजें', 'Кнопка'),

-- Подтверждения
('delete_confirm', 'Переместить в удалённые?', 'Move to deleted?', 'हटाए गए में ले जाएं?', 'Подтверждение'),
('permanent_delete_confirm', 'Удалить навсегда? Количества на складе будут откачены. Это действие нельзя отменить!', 'Delete permanently? Stock quantities will be rolled back. This action cannot be undone!', 'स्थायी रूप से हटाएं? स्टॉक मात्रा वापस कर दी जाएगी। यह क्रिया पूर्ववत नहीं की जा सकती!', 'Подтверждение'),
('archive_confirm', 'Переместить в архив?', 'Move to archive?', 'संग्रह में ले जाएं?', 'Подтверждение'),

-- Валидация
('select_buyer', 'Выберите закупщика', 'Select buyer', 'खरीदार चुनें', 'Форма'),
('select_buyer_required', 'Выберите закупщика', 'Please select a buyer', 'कृपया खरीदार चुनें', 'Валидация'),
('add_at_least_one', 'Добавьте хотя бы один продукт', 'Add at least one product', 'कम से कम एक उत्पाद जोड़ें', 'Валидация'),
('add_products', 'Добавьте продукты', 'Add products', 'उत्पाद जोड़ें', 'Форма'),
('product_already_added', 'Продукт уже добавлен', 'Product already added', 'उत्पाद पहले से जोड़ा गया है', 'Валидация'),
('save_error', 'Ошибка сохранения', 'Save error', 'सहेजने में त्रुटि', 'Ошибка'),
('nothing_found', 'Ничего не найдено', 'Nothing found', 'कुछ नहीं मिला', 'Поиск'),

-- Карточки и общие элементы
('receipt', 'Приёмка', 'Receipt', 'रसीद', 'Карточка'),
('buyer', 'Закупщик', 'Buyer', 'खरीदार', 'Карточка'),
('not_specified', 'Не указан', 'Not specified', 'निर्दिष्ट नहीं', 'Карточка'),
('items', 'поз.', 'items', 'आइटम', 'Карточка'),
('sum', 'сумма', 'total', 'कुल', 'Карточка'),
('request', 'Заявка', 'Request', 'अनुरोध', 'Карточка'),
('period', 'Период', 'Period', 'अवधि', 'Карточка'),
('created', 'Создано', 'Created', 'बनाया गया', 'Карточка'),
('total', 'Итого', 'Total', 'कुल', 'Общее'),
('total_items_short', 'Позиций', 'Items', 'आइटम', 'Общее'),
('search_placeholder', 'Начните вводить название...', 'Start typing a name...', 'नाम टाइप करना शुरू करें...', 'Поиск'),
('org_name', 'Шри Рупа Сева Кунджа', 'Shri Rupa Seva Kunja', 'श्री रूपा सेवा कुंज', 'Организация'),
('no_active_requests', 'Нет сохранённых заявок', 'No saved requests', 'कोई सहेजे गए अनुरोध नहीं', 'Пустое состояние'),

-- Страница заявок - заголовки
('purchase_request_title', 'Заявка на закупку', 'Purchase Request', 'खरीद अनुरोध', 'Заголовок'),
('purchase_request_subtitle', 'Формирование списка продуктов для закупки', 'Creating a list of products for purchase', 'खरीद के लिए उत्पादों की सूची बनाना', 'Подзаголовок'),
('back_to_stock', 'На склад', 'Back to stock', 'स्टॉक पर वापस', 'Навигация'),

-- Страница заявок - период
('menu_period', 'Период меню', 'Menu period', 'मेनू अवधि', 'Заявки'),
('period_today', 'Сегодня', 'Today', 'आज', 'Период'),
('period_3days', '3 дня', '3 days', '3 दिन', 'Период'),
('period_week', 'Неделя', 'Week', 'सप्ताह', 'Период'),
('period_2weeks', '2 недели', '2 weeks', '2 सप्ताह', 'Период'),
('from', 'с', 'from', 'से', 'Период'),
('to', 'по', 'to', 'तक', 'Период'),
('generate', 'Сформировать', 'Generate', 'बनाएं', 'Кнопка'),
('select_period_hint', 'Выберите период и нажмите "Сформировать"', 'Select a period and click "Generate"', 'अवधि चुनें और "बनाएं" पर क्लिक करें', 'Подсказка'),

-- Страница заявок - опции создания
('request_from_menu_title', 'Сформировать заявку из меню', 'Generate request from menu', 'मेनू से अनुरोध बनाएं', 'Заявки'),
('request_from_menu_desc', 'Автоматически рассчитать нужные продукты на основе меню', 'Automatically calculate needed products based on menu', 'मेनू के आधार पर स्वचालित रूप से आवश्यक उत्पादों की गणना करें', 'Заявки'),
('request_manual_title', 'Создать заявку вручную', 'Create request manually', 'मैन्युअल रूप से अनुरोध बनाएं', 'Заявки'),
('request_manual_desc', 'Ввести продукты для заявки вручную', 'Enter products for request manually', 'मैन्युअल रूप से अनुरोध के लिए उत्पाद दर्ज करें', 'Заявки'),
('create_request', 'Создать заявку', 'Create request', 'अनुरोध बनाएं', 'Кнопка'),
('add_products_hint', 'Добавьте продукты с помощью кнопки ниже', 'Add products using the button below', 'नीचे दिए गए बटन का उपयोग करके उत्पाद जोड़ें', 'Подсказка'),

-- Страница заявок - вкладки
('new_request_tab', 'Новая заявка', 'New request', 'नया अनुरोध', 'Вкладка'),
('saved_requests_tab', 'Сохранённые', 'Saved', 'सहेजे गए', 'Вкладка'),
('archived_requests_tab', 'Архивные', 'Archived', 'संग्रहीत', 'Вкладка'),

-- Страница заявок - таблица
('product', 'Продукт', 'Product', 'उत्पाद', 'Таблица'),
('category', 'Категория', 'Category', 'श्रेणी', 'Таблица'),
('needed', 'Нужно', 'Needed', 'आवश्यक', 'Таблица'),
('in_stock', 'На складе', 'In stock', 'स्टॉक में', 'Таблица'),
('to_purchase', 'Закупить', 'To purchase', 'खरीदना है', 'Таблица'),
('est_price', '≈ Сумма', '≈ Sum', '≈ राशि', 'Таблица'),
('total_items', 'Всего позиций:', 'Total items:', 'कुल आइटम:', 'Таблица'),
('est_total', 'Примерная сумма:', 'Estimated total:', 'अनुमानित कुल:', 'Таблица'),
('save_request', 'Сохранить', 'Save', 'सहेजें', 'Кнопка'),

-- Общие элементы
('add_product', 'Добавить продукт', 'Add product', 'उत्पाद जोड़ें', 'Кнопка'),
('search', 'Поиск', 'Search', 'खोज', 'Вкладка'),
('by_category', 'По категории', 'By category', 'श्रेणी के अनुसार', 'Вкладка'),
('quantity', 'Количество', 'Quantity', 'मात्रा', 'Форма'),
('cancel', 'Отмена', 'Cancel', 'रद्द करें', 'Кнопка'),
('add', 'Добавить', 'Add', 'जोड़ें', 'Кнопка'),
('all', 'Все', 'All', 'सभी', 'Фильтр'),
('remove', 'Удалить', 'Remove', 'हटाएं', 'Кнопка')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
