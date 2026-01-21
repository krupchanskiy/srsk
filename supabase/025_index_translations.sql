-- ============================================
-- ПЕРЕВОДЫ ДЛЯ ГЛАВНОЙ СТРАНИЦЫ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
('welcome_title', 'Добро пожаловать в систему управления кухней!', 'Welcome to the kitchen management system!', 'रसोई प्रबंधन प्रणाली में आपका स्वागत है!', 'Главная страница'),
('welcome_kitchen_desc', 'Планирование меню с учётом праздников, база рецептов и справочник продуктов.', 'Menu planning with holidays, recipe database and product catalog.', 'त्योहारों के साथ मेनू योजना, व्यंजन विधि डेटाबेस और उत्पाद सूची।', 'Главная страница'),
('welcome_stock_desc', 'Учёт остатков, формирование заявок на закупку, приёмка товаров.', 'Inventory tracking, purchase requests, receiving goods.', 'इन्वेंट्री ट्रैकिंग, खरीद अनुरोध, सामान प्राप्ति।', 'Главная страница'),
('welcome_ashram_desc', 'Календарь ретритов и информация о команде.', 'Retreat calendar and team information.', 'रिट्रीट कैलेंडर और टीम जानकारी।', 'Главная страница')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
