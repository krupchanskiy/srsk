-- ============================================
-- ПЕРЕВОДЫ ИНТЕРФЕЙСА
-- ============================================

create table translations (
    id uuid primary key default uuid_generate_v4(),
    key text unique not null,        -- 'page_title', 'add_recipe', etc.
    ru text not null,
    en text not null,
    hi text not null,
    context text,                     -- пояснение где используется
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- Триггер для updated_at
create trigger update_translations_updated_at before update on translations
    for each row execute function update_updated_at();

-- RLS
alter table translations enable row level security;
create policy "Public read translations" on translations for select using (true);

-- ============================================
-- ДАННЫЕ: Общие переводы
-- ============================================
insert into translations (key, ru, en, hi, context) values
-- Навигация
('app_name', 'Шри Рупа Сева Кунджа', 'Sri Rupa Seva Kunj', 'श्री रूप सेवा कुञ्ज', 'Название приложения'),
('nav_kitchen', 'Кухня', 'Kitchen', 'रसोई', 'Главное меню'),
('nav_stock', 'Склад', 'Stock', 'भंडार', 'Главное меню'),
('nav_ashram', 'Ашрам', 'Ashram', 'आश्रम', 'Главное меню'),
('nav_settings', 'Настройки', 'Settings', 'सेटिंग्स', 'Главное меню'),

-- Подменю Кухня
('nav_menu', 'Меню', 'Menu', 'मेन्यू', 'Подменю Кухня'),
('nav_recipes', 'Рецепты', 'Recipes', 'व्यंजन', 'Подменю Кухня'),
('nav_products', 'Продукты', 'Products', 'सामग्री', 'Подменю Кухня'),

-- Подменю Склад
('nav_inventory', 'Остатки', 'Inventory', 'इन्वेंटरी', 'Подменю Склад'),
('nav_requests', 'Заявки', 'Requests', 'अनुरोध', 'Подменю Склад'),
('nav_receive', 'Получить', 'Receive', 'प्राप्त करें', 'Подменю Склад'),
('nav_issue', 'Выдать', 'Issue', 'जारी करें', 'Подменю Склад'),

-- Подменю Ашрам
('nav_retreats', 'Ретриты', 'Retreats', 'रिट्रीट', 'Подменю Ашрам'),
('nav_team', 'Команда', 'Team', 'टीम', 'Подменю Ашрам'),
('nav_accommodation', 'Проживание', 'Accommodation', 'आवास', 'Подменю Ашрам'),

-- Подменю Настройки
('nav_general', 'Общие', 'General', 'सामान्य', 'Подменю Настройки'),
('nav_users', 'Пользователи', 'Users', 'उपयोगकर्ता', 'Подменю Настройки'),
('nav_holidays', 'Праздники', 'Holidays', 'त्योहार', 'Подменю Настройки'),

-- Страница Рецепты
('recipes_title', 'Рецепты', 'Recipes', 'व्यंजन', 'Заголовок страницы'),
('add_recipe', 'Добавить рецепт', 'Add recipe', 'व्यंजन जोड़ें', 'Кнопка'),
('search_placeholder', 'Поиск по названию...', 'Search by name...', 'नाम से खोजें...', 'Поле поиска'),
('show_photos', 'Показывать фото', 'Show photos', 'फ़ोटो दिखाएं', 'Toggle'),
('all', 'Все', 'All', 'सभी', 'Фильтр категорий'),
('minutes', 'мин', 'min', 'मिनट', 'Единица времени'),
('output', 'Выход', 'Output', 'उत्पादन', 'Выход блюда'),
('portion', 'Порция', 'Portion', 'भाग', 'Размер порции'),
('no_recipes', 'Рецепты не найдены', 'No recipes found', 'कोई व्यंजन नहीं मिला', 'Пустой результат'),

-- Страница Продукты
('products_title', 'Продукты', 'Products', 'सामग्री', 'Заголовок страницы'),
('add_product', 'Добавить продукт', 'Add product', 'सामग्री जोड़ें', 'Кнопка'),
('col_name', 'Название', 'Name', 'नाम', 'Колонка таблицы'),
('col_category', 'Категория', 'Category', 'श्रेणी', 'Колонка таблицы'),
('col_unit', 'Ед. изм.', 'Unit', 'इकाई', 'Колонка таблицы'),
('col_price_range', 'Диапазон цен', 'Price range', 'मूल्य सीमा', 'Колонка таблицы'),

-- Страница Меню
('menu_title', 'Меню на сегодня', 'Today''s menu', 'आज का मेन्यू', 'Заголовок'),
('breakfast', 'Завтрак', 'Breakfast', 'नाश्ता', 'Приём пищи'),
('lunch', 'Обед', 'Lunch', 'दोपहर का भोजन', 'Приём пищи'),
('dinner', 'Ужин', 'Dinner', 'रात का भोजन', 'Приём пищи'),
('servings', 'порций', 'servings', 'सर्विंग्स', 'Количество порций'),

-- Страница Команда
('team_title', 'Команда', 'Team', 'टीम', 'Заголовок'),
('add_member', 'Добавить', 'Add', 'जोड़ें', 'Кнопка'),
('total_members', 'Всего в команде', 'Total members', 'कुल सदस्य', 'Статистика'),
('present_now', 'Сейчас присутствуют', 'Present now', 'अभी मौजूद', 'Статистика'),
('expected', 'Ожидаются', 'Expected', 'अपेक्षित', 'Статистика'),

-- Страница Ретриты
('retreats_title', 'Ретриты', 'Retreats', 'रिट्रीट', 'Заголовок'),
('add_retreat', 'Добавить ретрит', 'Add retreat', 'रिट्रीट जोड़ें', 'Кнопка'),
('list_view', 'Список', 'List', 'सूची', 'Вкладка'),
('calendar_view', 'Календарь', 'Calendar', 'कैलेंडर', 'Вкладка'),
('participants', 'участников', 'participants', 'प्रतिभागी', 'Количество'),

-- Общие
('back_to_top', 'Наверх', 'Back to top', 'ऊपर जाएं', 'Футер'),
('save', 'Сохранить', 'Save', 'सहेजें', 'Кнопка'),
('cancel', 'Отмена', 'Cancel', 'रद्द करें', 'Кнопка'),
('delete', 'Удалить', 'Delete', 'हटाएं', 'Кнопка'),
('edit', 'Редактировать', 'Edit', 'संपादित करें', 'Кнопка'),
('close', 'Закрыть', 'Close', 'बंद करें', 'Кнопка'),
('loading', 'Загрузка...', 'Loading...', 'लोड हो रहा है...', 'Статус'),
('error', 'Ошибка', 'Error', 'त्रुटि', 'Статус'),
('success', 'Успешно', 'Success', 'सफल', 'Статус'),
('confirm_delete', 'Вы уверены, что хотите удалить?', 'Are you sure you want to delete?', 'क्या आप वाकई हटाना चाहते हैं?', 'Подтверждение'),
('yes', 'Да', 'Yes', 'हाँ', 'Подтверждение'),
('no', 'Нет', 'No', 'नहीं', 'Подтверждение'),
('print', 'Печать', 'Print', 'प्रिंट', 'Кнопка'),
('filter_all', 'Все', 'All', 'सभी', 'Фильтр'),
('filter_present', 'Присутствуют', 'Present', 'मौजूद', 'Фильтр'),
('filter_absent', 'Отсутствуют', 'Absent', 'अनुपस्थित', 'Фильтр');

-- Индекс для быстрого поиска по ключу
create index idx_translations_key on translations(key);
