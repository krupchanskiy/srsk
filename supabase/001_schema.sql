-- ============================================
-- ШРСК Кухня - Схема базы данных
-- ============================================

-- Включаем расширение для UUID
create extension if not exists "uuid-ossp";

-- ============================================
-- 1. ЛОКАЦИИ (кухни)
-- ============================================
create table locations (
    id uuid primary key default uuid_generate_v4(),
    slug text unique not null, -- 'main', 'cafe', 'guest'
    name_ru text not null,
    name_en text not null,
    name_hi text not null,
    color text not null, -- hex цвет для UI
    created_at timestamptz default now()
);

-- Начальные данные
insert into locations (slug, name_ru, name_en, name_hi, color) values
    ('main', 'Основная кухня', 'Main Kitchen', 'मुख्य रसोई', '#f49800'),
    ('cafe', 'Кухня кафе', 'Café Kitchen', 'कैफे रसोई', '#10b981'),
    ('guest', 'Гостевая кухня', 'Guest Kitchen', 'अतिथि रसोई', '#3b82f6');

-- ============================================
-- 2. ПРОФИЛИ ПОЛЬЗОВАТЕЛЕЙ
-- ============================================
create table profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    name text not null,
    avatar_url text,
    role text default 'member', -- 'admin', 'manager', 'member'
    created_at timestamptz default now()
);

-- ============================================
-- 3. КАТЕГОРИИ ПРОДУКТОВ
-- ============================================
create table product_categories (
    id uuid primary key default uuid_generate_v4(),
    slug text unique not null,
    name_ru text not null,
    name_en text not null,
    name_hi text not null,
    sort_order int default 0
);

insert into product_categories (slug, name_ru, name_en, name_hi, sort_order) values
    ('vegetables', 'Овощи', 'Vegetables', 'सब्जियां', 1),
    ('fruits', 'Фрукты', 'Fruits', 'फल', 2),
    ('grains', 'Крупы и злаки', 'Grains & Cereals', 'अनाज', 3),
    ('legumes', 'Бобовые', 'Legumes', 'दालें', 4),
    ('dairy', 'Молочные продукты', 'Dairy', 'डेयरी', 5),
    ('spices', 'Специи', 'Spices', 'मसाले', 6),
    ('oils', 'Масла', 'Oils', 'तेल', 7),
    ('sweeteners', 'Сахар и подсластители', 'Sweeteners', 'मिठास', 8),
    ('nuts', 'Орехи и семена', 'Nuts & Seeds', 'मेवे', 9),
    ('other', 'Прочее', 'Other', 'अन्य', 10);

-- ============================================
-- 4. ПРОДУКТЫ
-- ============================================
create table products (
    id uuid primary key default uuid_generate_v4(),
    category_id uuid references product_categories(id),
    name_ru text not null,
    name_en text not null,
    name_hi text not null,
    translit text, -- IAST транслитерация
    unit text not null, -- 'kg', 'l', 'pcs', 'g', 'ml'
    price_min decimal(10,2), -- диапазон цен
    price_max decimal(10,2),
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ============================================
-- 5. КАТЕГОРИИ РЕЦЕПТОВ
-- ============================================
create table recipe_categories (
    id uuid primary key default uuid_generate_v4(),
    slug text unique not null,
    name_ru text not null,
    name_en text not null,
    name_hi text not null,
    color text not null, -- цвет бейджа
    emoji text,
    sort_order int default 0
);

insert into recipe_categories (slug, name_ru, name_en, name_hi, color, emoji, sort_order) values
    ('main', 'Основное', 'Main', 'मुख्य', '#A67B5B', '🍛', 1),
    ('garnish', 'Гарнир', 'Garnish', 'गार्निश', '#D4A84B', '🍚', 2),
    ('soup', 'Суп', 'Soup', 'सूप', '#E08A4A', '🍲', 3),
    ('salad', 'Салат', 'Salad', 'सलाद', '#6B9E5A', '🥗', 4),
    ('drink', 'Напиток', 'Drink', 'पेय', '#4A9E9A', '🥤', 5),
    ('sweet', 'Сладость', 'Sweet', 'मिठाई', '#C75D7E', '🍮', 6),
    ('snack', 'Закуска', 'Snack', 'नाश्ता', '#8B6B9E', '🥟', 7);

-- ============================================
-- 6. РЕЦЕПТЫ
-- ============================================
create table recipes (
    id uuid primary key default uuid_generate_v4(),
    category_id uuid references recipe_categories(id),
    name_ru text not null,
    name_en text not null,
    name_hi text not null,
    translit text, -- IAST транслитерация
    description_ru text,
    description_en text,
    description_hi text,
    output_amount decimal(10,2), -- выход
    output_unit text, -- 'kg', 'l', 'pcs'
    portion_amount decimal(10,2), -- размер порции
    portion_unit text,
    cooking_time int, -- минуты
    photo_url text,
    instructions_ru text, -- пошаговые инструкции
    instructions_en text,
    instructions_hi text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ============================================
-- 7. ИНГРЕДИЕНТЫ РЕЦЕПТОВ
-- ============================================
create table recipe_ingredients (
    id uuid primary key default uuid_generate_v4(),
    recipe_id uuid references recipes(id) on delete cascade,
    product_id uuid references products(id),
    amount decimal(10,3) not null,
    unit text not null, -- может отличаться от unit продукта
    notes text, -- "мелко нарезать", "по вкусу"
    sort_order int default 0
);

-- ============================================
-- 8. МЕНЮ НА ДЕНЬ
-- ============================================
create table menu_days (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id),
    date date not null,
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(location_id, date)
);

-- ============================================
-- 9. БЛЮДА В МЕНЮ
-- ============================================
create table menu_items (
    id uuid primary key default uuid_generate_v4(),
    menu_day_id uuid references menu_days(id) on delete cascade,
    recipe_id uuid references recipes(id),
    meal_type text not null, -- 'breakfast', 'lunch', 'dinner'
    servings int not null, -- количество порций
    notes text,
    sort_order int default 0
);

-- ============================================
-- 10. ОСТАТКИ НА СКЛАДЕ
-- ============================================
create table stock (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id),
    product_id uuid references products(id),
    quantity decimal(10,3) not null default 0,
    min_quantity decimal(10,3), -- минимальный остаток для предупреждения
    updated_at timestamptz default now(),
    unique(location_id, product_id)
);

-- ============================================
-- 11. ЗАЯВКИ НА ПРОДУКТЫ
-- ============================================
create table stock_requests (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id),
    requested_by uuid references profiles(id),
    status text default 'pending', -- 'pending', 'approved', 'completed', 'cancelled'
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ============================================
-- 12. ПОЗИЦИИ ЗАЯВКИ
-- ============================================
create table stock_request_items (
    id uuid primary key default uuid_generate_v4(),
    request_id uuid references stock_requests(id) on delete cascade,
    product_id uuid references products(id),
    quantity decimal(10,3) not null,
    unit text not null,
    notes text
);

-- ============================================
-- 13. ДВИЖЕНИЯ ПО СКЛАДУ
-- ============================================
create table stock_transactions (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id),
    product_id uuid references products(id),
    type text not null, -- 'in' (приход), 'out' (расход)
    quantity decimal(10,3) not null,
    unit text not null,
    reason text, -- 'purchase', 'transfer', 'cooking', 'spoilage', 'adjustment'
    reference_id uuid, -- ссылка на заявку или меню
    performed_by uuid references profiles(id),
    notes text,
    created_at timestamptz default now()
);

-- ============================================
-- 14. ЧЛЕНЫ КОМАНДЫ
-- ============================================
create table team_members (
    id uuid primary key default uuid_generate_v4(),
    name_ru text not null,
    name_en text,
    phone text,
    email text,
    role text, -- 'cook', 'helper', 'manager'
    notes text,
    photo_url text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ============================================
-- 15. ПЕРИОДЫ ПРИСУТСТВИЯ
-- ============================================
create table team_presence (
    id uuid primary key default uuid_generate_v4(),
    member_id uuid references team_members(id) on delete cascade,
    start_date date not null,
    end_date date, -- null = бессрочно
    notes text,
    created_at timestamptz default now()
);

-- ============================================
-- 16. РЕТРИТЫ
-- ============================================
create table retreats (
    id uuid primary key default uuid_generate_v4(),
    name_ru text not null,
    name_en text,
    start_date date not null,
    end_date date not null,
    participants_count int default 0,
    location_id uuid references locations(id),
    notes text,
    color text, -- цвет для календаря
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

-- ============================================
-- 17. ПРАЗДНИКИ / ОСОБЫЕ ДНИ
-- ============================================
create table holidays (
    id uuid primary key default uuid_generate_v4(),
    date date not null,
    name_ru text not null,
    name_en text,
    name_hi text,
    type text, -- 'ekadashi', 'appearance', 'festival', 'other'
    fasting_level text, -- 'full', 'grain', 'none'
    notes text
);

-- ============================================
-- ИНДЕКСЫ для производительности
-- ============================================
create index idx_products_category on products(category_id);
create index idx_recipes_category on recipes(category_id);
create index idx_recipe_ingredients_recipe on recipe_ingredients(recipe_id);
create index idx_menu_days_date on menu_days(date);
create index idx_menu_days_location on menu_days(location_id);
create index idx_stock_location on stock(location_id);
create index idx_stock_product on stock(product_id);
create index idx_stock_transactions_date on stock_transactions(created_at);
create index idx_team_presence_dates on team_presence(start_date, end_date);
create index idx_retreats_dates on retreats(start_date, end_date);

-- ============================================
-- ФУНКЦИЯ: обновление updated_at
-- ============================================
create or replace function update_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

-- Триггеры для автообновления updated_at
create trigger update_products_updated_at before update on products
    for each row execute function update_updated_at();

create trigger update_recipes_updated_at before update on recipes
    for each row execute function update_updated_at();

create trigger update_menu_days_updated_at before update on menu_days
    for each row execute function update_updated_at();

create trigger update_stock_updated_at before update on stock
    for each row execute function update_updated_at();

create trigger update_team_members_updated_at before update on team_members
    for each row execute function update_updated_at();

create trigger update_retreats_updated_at before update on retreats
    for each row execute function update_updated_at();
