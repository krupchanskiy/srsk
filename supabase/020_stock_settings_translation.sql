-- ============================================
-- ПЕРЕВОД ДЛЯ НАСТРОЕК СКЛАДА
-- ============================================

insert into translations (key, ru, en, hi, context) values
('nav_stock_settings', 'Настройки', 'Settings', 'सेटिंग्स', 'Меню склада'),
('stock_settings_title', 'Настройки склада', 'Stock Settings', 'स्टॉक सेटिंग्स', 'Заголовок страницы'),

-- Вкладки
('buyers_tab', 'Закупщики', 'Buyers', 'खरीदार', 'Вкладка'),
('min_stock_tab', 'Несгораемый остаток', 'Min Stock', 'न्यूनतम स्टॉक', 'Вкладка'),

-- Секция закупщиков
('buyers_list', 'Список закупщиков', 'Buyers List', 'खरीदारों की सूची', 'Заголовок'),
('buyers_desc', 'Люди, которые могут закупать продукты', 'People who can purchase products', 'वे लोग जो उत्पाद खरीद सकते हैं', 'Описание'),
('name', 'Имя', 'Name', 'नाम', 'Таблица'),
('phone', 'Телефон', 'Phone', 'फ़ोन', 'Таблица'),

-- Секция несгораемого остатка
('min_stock_title', 'Несгораемый остаток', 'Minimum Stock', 'न्यूनतम स्टॉक', 'Заголовок'),
('min_stock_desc', 'Минимальное количество, ниже которого остаток считается критичным', 'Minimum quantity below which stock is considered critical', 'न्यूनतम मात्रा जिसके नीचे स्टॉक महत्वपूर्ण माना जाता है', 'Описание'),
('stock_current', 'Текущий остаток', 'Current Stock', 'वर्तमान स्टॉक', 'Таблица'),
('stock_min', 'Несгораемый остаток', 'Min Stock', 'न्यूनतम स्टॉक', 'Таблица'),
('placement', 'Размещение', 'Placement', 'स्थान', 'Таблица'),
('placement_hint', 'Холодильник, полка...', 'Fridge, shelf...', 'फ्रिज, शेल्फ...', 'Плейсхолдер')

on conflict (key) do update set
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
