-- ============================================
-- ПЕРЕВОД ДЛЯ НАСТРОЕК СКЛАДА
-- ============================================

insert into translations (key, ru, en, hi, context) values
('nav_stock_settings', 'Настройки', 'Settings', 'सेटिंग्स', 'Меню склада'),
('stock_settings_title', 'Настройки склада', 'Stock Settings', 'स्टॉक सेटिंग्स', 'Заголовок страницы')
on conflict (key) do update set
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
