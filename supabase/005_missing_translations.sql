-- ============================================
-- Добавляем недостающие переводы
-- ============================================

-- Навигация: страница Переводы
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('nav_translations', 'Переводы', 'Translations', 'अनुवाद', 'Подменю Настройки', 'navigation')
ON CONFLICT (key) DO NOTHING;

-- Короткое название приложения
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('app_name_short', 'ШРСК', 'SRSK', 'एसआरएसके', 'Короткое название в хедере', 'common')
ON CONFLICT (key) DO NOTHING;

-- Единицы измерения
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('unit_pcs', 'шт', 'pcs', 'पीस', 'Единица измерения: штуки', 'common'),
('unit_kg', 'кг', 'kg', 'किग्रा', 'Единица измерения: килограммы', 'common'),
('unit_g', 'г', 'g', 'ग्राम', 'Единица измерения: граммы', 'common'),
('unit_l', 'л', 'l', 'लीटर', 'Единица измерения: литры', 'common'),
('unit_ml', 'мл', 'ml', 'मिली', 'Единица измерения: миллилитры', 'common')
ON CONFLICT (key) DO NOTHING;

-- UI страницы Переводы
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('translations_title', 'Переводы интерфейса', 'Interface translations', 'इंटरफ़ेस अनुवाद', 'Заголовок страницы', 'translations'),
('translations_info', 'Изменения сохраняются автоматически при потере фокуса поля. Нажмите Tab или кликните вне поля.', 'Changes are saved automatically when the field loses focus. Press Tab or click outside the field.', 'फ़ील्ड से फ़ोकस हटने पर परिवर्तन स्वचालित रूप से सहेजे जाते हैं।', 'Подсказка', 'translations'),
('filter_by_page', 'Фильтр по странице', 'Filter by page', 'पेज द्वारा फ़िल्टर', 'Фильтр', 'translations'),
('all_pages', 'Все страницы', 'All pages', 'सभी पेज', 'Фильтр', 'translations'),
('search_by_key', 'Поиск по ключу или тексту...', 'Search by key or text...', 'की या टेक्स्ट से खोजें...', 'Поле поиска', 'translations'),
('col_key', 'Ключ', 'Key', 'की', 'Колонка таблицы', 'translations'),
('col_russian', 'Русский', 'Russian', 'रूसी', 'Колонка таблицы', 'translations'),
('col_english', 'English', 'English', 'अंग्रेज़ी', 'Колонка таблицы', 'translations'),
('col_hindi', 'हिंदी', 'Hindi', 'हिंदी', 'Колонка таблицы', 'translations'),
('col_page', 'Страница', 'Page', 'पेज', 'Колонка таблицы', 'translations'),
('col_actions', 'Действия', 'Actions', 'क्रियाएं', 'Колонка таблицы', 'translations'),
('add_translation', 'Добавить перевод', 'Add translation', 'अनुवाद जोड़ें', 'Кнопка', 'translations'),
('edit_translation', 'Редактирование перевода', 'Edit translation', 'अनुवाद संपादित करें', 'Заголовок модала', 'translations'),
('no_translations', 'Переводы не найдены', 'No translations found', 'कोई अनुवाद नहीं मिला', 'Пустой результат', 'translations'),
('translation_saved', 'Перевод сохранён', 'Translation saved', 'अनुवाद सहेजा गया', 'Уведомление', 'translations'),
('total_translations', 'переводов', 'translations', 'अनुवाद', 'Счётчик', 'translations'),
('key_hint', 'Уникальный идентификатор, латиница и подчёркивания', 'Unique identifier, latin letters and underscores', 'अद्वितीय पहचानकर्ता', 'Подсказка для поля ключа', 'translations'),
('context', 'Контекст', 'Context', 'संदर्भ', 'Поле контекста', 'translations')
ON CONFLICT (key) DO NOTHING;

-- Названия страниц для фильтра
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('page_common', 'Общие', 'Common', 'सामान्य', 'Название страницы в фильтре', 'translations'),
('page_navigation', 'Навигация', 'Navigation', 'नेविगेशन', 'Название страницы в фильтре', 'translations'),
('page_recipes', 'Рецепты', 'Recipes', 'व्यंजन', 'Название страницы в фильтре', 'translations'),
('page_products', 'Продукты', 'Products', 'सामग्री', 'Название страницы в фильтре', 'translations'),
('page_menu', 'Меню', 'Menu', 'मेन्यू', 'Название страницы в фильтре', 'translations'),
('page_team', 'Команда', 'Team', 'टीम', 'Название страницы в фильтре', 'translations'),
('page_retreats', 'Ретриты', 'Retreats', 'रिट्रीट', 'Название страницы в фильтре', 'translations'),
('page_filters', 'Фильтры', 'Filters', 'फ़िल्टर', 'Название страницы в фильтре', 'translations'),
('page_translations', 'Переводы', 'Translations', 'अनुवाद', 'Название страницы в фильтре', 'translations'),
('page_dictionaries', 'Справочники', 'Dictionaries', 'शब्दकोश', 'Название страницы в фильтре', 'translations')
ON CONFLICT (key) DO NOTHING;

-- Навигация: Справочники
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('nav_dictionaries', 'Справочники', 'Dictionaries', 'शब्दकोश', 'Подменю Настройки', 'navigation')
ON CONFLICT (key) DO NOTHING;

-- Страница Справочники
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('dictionaries_title', 'Справочники', 'Dictionaries', 'शब्दकोश', 'Заголовок страницы', 'dictionaries'),
('dictionaries_subtitle', 'Категории, единицы измерения и другие списки', 'Categories, units and other lists', 'श्रेणियां, इकाइयां और अन्य सूचियां', 'Подзаголовок', 'dictionaries'),
('dict_recipe_categories', 'Категории блюд', 'Recipe Categories', 'व्यंजन श्रेणियां', 'Название таба', 'dictionaries'),
('dict_product_categories', 'Категории продуктов', 'Product Categories', 'उत्पाद श्रेणियां', 'Название таба', 'dictionaries'),
('dict_units', 'Единицы измерения', 'Units', 'इकाइयां', 'Название таба', 'dictionaries'),
('col_code', 'Код', 'Code', 'कोड', 'Колонка', 'dictionaries'),
('short', 'Сокр.', 'Short', 'संक्षिप्त', 'Колонка', 'dictionaries'),
('type', 'Тип', 'Type', 'प्रकार', 'Колонка', 'dictionaries'),
('type_weight', 'Вес', 'Weight', 'वज़न', 'Тип единицы', 'dictionaries'),
('type_volume', 'Объём', 'Volume', 'मात्रा', 'Тип единицы', 'dictionaries'),
('type_count', 'Количество', 'Count', 'गिनती', 'Тип единицы', 'dictionaries'),
('emoji', 'Эмодзи', 'Emoji', 'इमोजी', 'Поле', 'dictionaries'),
('color', 'Цвет', 'Color', 'रंग', 'Поле', 'dictionaries'),
('name_full_ru', 'Полное название (RU)', 'Full name (RU)', 'पूरा नाम (RU)', 'Поле', 'dictionaries'),
('name_full_en', 'Полное название (EN)', 'Full name (EN)', 'पूरा नाम (EN)', 'Поле', 'dictionaries'),
('name_full_hi', 'Полное название (HI)', 'Full name (HI)', 'पूरा नाम (HI)', 'Поле', 'dictionaries'),
('short_ru', 'Сокращение (RU)', 'Abbreviation (RU)', 'संक्षिप्त (RU)', 'Поле', 'dictionaries'),
('short_en', 'Сокращение (EN)', 'Abbreviation (EN)', 'संक्षिप्त (EN)', 'Поле', 'dictionaries'),
('short_hi', 'Сокращение (HI)', 'Abbreviation (HI)', 'संक्षिप्त (HI)', 'Поле', 'dictionaries'),
('items', 'записей', 'items', 'आइटम', 'Счётчик', 'dictionaries'),
('add', 'Добавить', 'Add', 'जोड़ें', 'Кнопка', 'common'),
('no_data', 'Нет данных', 'No data', 'कोई डेटा नहीं', 'Пустой список', 'common')
ON CONFLICT (key) DO NOTHING;

-- Страница Продукты
INSERT INTO translations (key, ru, en, hi, context, page) VALUES
('no_products', 'Продукты не найдены', 'No products found', 'कोई उत्पाद नहीं मिला', 'Пустой результат', 'products'),
('price_from', 'Цена от', 'Price from', 'कीमत से', 'Поле цены', 'products'),
('price_to', 'Цена до', 'Price to', 'कीमत तक', 'Поле цены', 'products'),
('translit_hint', 'Транслитерация для хинди', 'Transliteration for Hindi', 'हिंदी के लिए लिप्यंतरण', 'Подсказка', 'products')
ON CONFLICT (key) DO NOTHING;
