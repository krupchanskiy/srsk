-- ============================================
-- ПЕРЕВОДЫ ДЛЯ СТРАНИЦЫ ПРИЁМКИ ТОВАРОВ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
-- Меню
('nav_receive', 'Принять', 'Receive', 'प्राप्त करें', 'Меню'),

-- Заголовки
('receive_title', 'Приёмка товаров', 'Receive Goods', 'सामान प्राप्ति', 'Заголовок страницы'),

-- Вкладки
('new_receipt_tab', 'Новая приёмка', 'New Receipt', 'नई रसीद', 'Вкладка'),
('saved_receipts_tab', 'Сохранённые', 'Saved', 'सहेजा हुआ', 'Вкладка'),
('archived_receipts_tab', 'Архивные', 'Archived', 'संग्रहीत', 'Вкладка'),

-- Форма
('receipt_date', 'Дата', 'Date', 'तारीख', 'Поле формы'),
('receipt_buyer', 'Кто закупал', 'Buyer', 'खरीदार', 'Поле формы'),
('select_buyer', 'Выберите закупщика', 'Select buyer', 'खरीदार चुनें', 'Placeholder'),
('from_request', 'Из заявки', 'From request', 'अनुरोध से', 'Кнопка'),
('load_from_request', 'Загрузить из заявки', 'Load from request', 'अनुरोध से लोड करें', 'Заголовок модалки'),
('add_product_placeholder', 'Добавить продукт...', 'Add product...', 'उत्पाद जोड़ें...', 'Placeholder'),
('receipt_notes_placeholder', 'Примечания по поставщикам, качеству...', 'Notes about suppliers, quality...', 'आपूर्तिकर्ताओं, गुणवत्ता के बारे में नोट...', 'Placeholder'),
('save_receipt', 'Сохранить приёмку', 'Save receipt', 'रसीद सहेजें', 'Кнопка'),

-- Карточки
('receipt', 'Приёмка', 'Receipt', 'रसीद', 'Карточка'),
('buyer', 'Закупщик', 'Buyer', 'खरीदार', 'Карточка'),
('not_specified', 'Не указан', 'Not specified', 'निर्दिष्ट नहीं', 'Значение по умолчанию'),
('no_receipts', 'Нет сохранённых приёмок', 'No saved receipts', 'कोई सहेजी गई रसीदें नहीं', 'Пустое состояние'),

-- Общие
('add_products', 'Добавьте продукты', 'Add products', 'उत्पाद जोड़ें', 'Пустое состояние'),
('product_already_added', 'Продукт уже добавлен', 'Product already added', 'उत्पाद पहले से जोड़ा गया', 'Уведомление'),
('no_active_requests', 'Нет сохранённых заявок', 'No saved requests', 'कोई सहेजे गए अनुरोध नहीं', 'Пустое состояние'),
('add_at_least_one', 'Добавьте хотя бы один продукт', 'Add at least one product', 'कम से कम एक उत्पाद जोड़ें', 'Валидация')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
