-- ============================================
-- ПЕРЕВОДЫ ДЛЯ СТРАНИЦЫ ПРАЗДНИКОВ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
-- Меню
('nav_festivals', 'Праздники', 'Festivals', 'त्योहार', 'Меню'),

-- Заголовки
('holidays_title', 'Праздники', 'Holidays', 'त्योहार', 'Заголовок страницы'),
('add_holiday', 'Добавить праздник', 'Add Holiday', 'त्योहार जोड़ें', 'Кнопка'),
('edit_holiday', 'Редактировать праздник', 'Edit Holiday', 'त्योहार संपादित करें', 'Заголовок модалки'),

-- Поля формы
('holiday_name', 'Название', 'Name', 'नाम', 'Поле формы'),
('holiday_type', 'Тип праздника', 'Holiday Type', 'त्योहार का प्रकार', 'Поле формы'),

-- Типы праздников
('type_major', 'Фестиваль', 'Festival', 'त्योहार', 'Тип праздника'),
('type_ekadashi', 'Экадаши', 'Ekadashi', 'एकादशी', 'Тип праздника'),
('type_appearance', 'Явление', 'Appearance', 'आविर्भाव', 'Тип праздника'),
('type_disappearance', 'Уход', 'Disappearance', 'तिरोभाव', 'Тип праздника')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
