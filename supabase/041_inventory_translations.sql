-- ============================================
-- ПЕРЕВОДЫ ДЛЯ ИНВЕНТАРИЗАЦИИ
-- ============================================

INSERT INTO translations (key, ru, en, hi, page, context) VALUES
-- Заголовки
('inventory_title', 'Инвентаризация', 'Inventory', 'इन्वेंटरी', 'inventory', 'Заголовок страницы'),
('new_inventory', 'Новая инвентаризация', 'New Inventory', 'नई इन्वेंटरी', 'inventory', 'Вкладка'),
('in_progress_inventories', 'В процессе', 'In Progress', 'प्रगति में', 'inventory', 'Вкладка'),
('completed_inventories', 'Завершённые', 'Completed', 'पूर्ण', 'inventory', 'Вкладка'),

-- Создание
('create_inventory', 'Создать инвентаризацию', 'Create Inventory', 'इन्वेंटरी बनाएं', 'inventory', 'Кнопка'),
('select_categories', 'Выберите категории', 'Select Categories', 'श्रेणियां चुनें', 'inventory', 'Метка'),
('all_categories', 'Все категории', 'All Categories', 'सभी श्रेणियां', 'inventory', 'Опция'),
('inventory_date', 'Дата инвентаризации', 'Inventory Date', 'इन्वेंटरी तिथि', 'inventory', 'Метка'),

-- Таблица
('expected', 'Ожидаемо', 'Expected', 'अपेक्षित', 'inventory', 'Колонка'),
('actual', 'Фактически', 'Actual', 'वास्तविक', 'inventory', 'Колонка'),
('difference', 'Разница', 'Difference', 'अंतर', 'inventory', 'Колонка'),
('surplus', 'Излишек', 'Surplus', 'अधिशेष', 'inventory', 'Статус'),
('shortage', 'Недостача', 'Shortage', 'कमी', 'inventory', 'Статус'),
('match', 'Совпадает', 'Match', 'मिलान', 'inventory', 'Статус'),

-- Действия
('apply_inventory', 'Применить изменения', 'Apply Changes', 'परिवर्तन लागू करें', 'inventory', 'Кнопка'),
('confirm_apply', 'Применить результаты инвентаризации? Остатки на складе будут скорректированы.', 'Apply inventory results? Stock quantities will be adjusted.', 'इन्वेंटरी परिणाम लागू करें? स्टॉक मात्रा समायोजित की जाएगी।', 'inventory', 'Подтверждение'),
('cancel_inventory', 'Отменить инвентаризацию', 'Cancel Inventory', 'इन्वेंटरी रद्द करें', 'inventory', 'Кнопка'),
('view_inventory', 'Просмотр', 'View', 'देखें', 'inventory', 'Кнопка'),

-- Статусы
('inventory_in_progress', 'В процессе подсчёта', 'Counting in progress', 'गिनती प्रगति पर है', 'inventory', 'Статус'),
('inventory_completed', 'Инвентаризация завершена', 'Inventory completed', 'इन्वेंटरी पूर्ण', 'inventory', 'Статус'),
('inventory_cancelled', 'Инвентаризация отменена', 'Inventory cancelled', 'इन्वेंटरी रद्द', 'inventory', 'Статус'),

-- Сообщения
('no_inventories', 'Нет инвентаризаций', 'No inventories', 'कोई इन्वेंटरी नहीं', 'inventory', 'Пустое состояние'),
('no_products_to_count', 'Нет продуктов для подсчёта', 'No products to count', 'गिनने के लिए कोई उत्पाद नहीं', 'inventory', 'Пустое состояние'),
('items_counted', 'позиций подсчитано', 'items counted', 'आइटम गिने गए', 'inventory', 'Статистика'),
('discrepancies_found', 'расхождений найдено', 'discrepancies found', 'विसंगतियां पाई गईं', 'inventory', 'Статистика')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    page = excluded.page,
    context = excluded.context;
