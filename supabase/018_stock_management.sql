-- ============================================
-- СКЛАДСКОЙ УЧЁТ
-- ============================================

-- Закупщики
create table if not exists buyers (
    id uuid primary key default uuid_generate_v4(),
    name text not null,
    phone text,
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

drop trigger if exists update_buyers_updated_at on buyers;
create trigger update_buyers_updated_at before update on buyers
    for each row execute function update_updated_at();

alter table buyers enable row level security;
drop policy if exists "Public read buyers" on buyers;
drop policy if exists "Auth insert buyers" on buyers;
drop policy if exists "Auth update buyers" on buyers;
create policy "Public read buyers" on buyers for select using (true);
create policy "Auth insert buyers" on buyers for insert with check (true);
create policy "Auth update buyers" on buyers for update using (true);

-- Остатки на складе
create table if not exists stock (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    current_quantity decimal(10,2) default 0,
    min_quantity decimal(10,2) default 0,
    supplier text,
    last_price decimal(10,2),
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    unique(location_id, product_id)
);

drop trigger if exists update_stock_updated_at on stock;
create trigger update_stock_updated_at before update on stock
    for each row execute function update_updated_at();

alter table stock enable row level security;
drop policy if exists "Public read stock" on stock;
drop policy if exists "Auth insert stock" on stock;
drop policy if exists "Auth update stock" on stock;
drop policy if exists "Auth delete stock" on stock;
create policy "Public read stock" on stock for select using (true);
create policy "Auth insert stock" on stock for insert with check (true);
create policy "Auth update stock" on stock for update using (true);
create policy "Auth delete stock" on stock for delete using (true);

-- Заявки на закупку
create table if not exists purchase_requests (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id) on delete cascade,
    number serial,
    period_from date,
    period_to date,
    status text default 'pending', -- pending, closed, archived
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

drop trigger if exists update_purchase_requests_updated_at on purchase_requests;
create trigger update_purchase_requests_updated_at before update on purchase_requests
    for each row execute function update_updated_at();

alter table purchase_requests enable row level security;
drop policy if exists "Public read purchase_requests" on purchase_requests;
drop policy if exists "Auth insert purchase_requests" on purchase_requests;
drop policy if exists "Auth update purchase_requests" on purchase_requests;
drop policy if exists "Auth delete purchase_requests" on purchase_requests;
create policy "Public read purchase_requests" on purchase_requests for select using (true);
create policy "Auth insert purchase_requests" on purchase_requests for insert with check (true);
create policy "Auth update purchase_requests" on purchase_requests for update using (true);
create policy "Auth delete purchase_requests" on purchase_requests for delete using (true);

-- Позиции заявки
create table if not exists purchase_request_items (
    id uuid primary key default uuid_generate_v4(),
    request_id uuid references purchase_requests(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    price decimal(10,2),
    created_at timestamptz default now()
);

alter table purchase_request_items enable row level security;
drop policy if exists "Public read purchase_request_items" on purchase_request_items;
drop policy if exists "Auth insert purchase_request_items" on purchase_request_items;
drop policy if exists "Auth update purchase_request_items" on purchase_request_items;
drop policy if exists "Auth delete purchase_request_items" on purchase_request_items;
create policy "Public read purchase_request_items" on purchase_request_items for select using (true);
create policy "Auth insert purchase_request_items" on purchase_request_items for insert with check (true);
create policy "Auth update purchase_request_items" on purchase_request_items for update using (true);
create policy "Auth delete purchase_request_items" on purchase_request_items for delete using (true);

-- Получения товаров (приход на склад)
create table if not exists stock_receipts (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id) on delete cascade,
    number serial,
    buyer_id uuid references buyers(id) on delete set null,
    receipt_date date,
    notes text,
    archived boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

drop trigger if exists update_stock_receipts_updated_at on stock_receipts;
create trigger update_stock_receipts_updated_at before update on stock_receipts
    for each row execute function update_updated_at();

alter table stock_receipts enable row level security;
drop policy if exists "Public read stock_receipts" on stock_receipts;
drop policy if exists "Auth insert stock_receipts" on stock_receipts;
drop policy if exists "Auth update stock_receipts" on stock_receipts;
drop policy if exists "Auth delete stock_receipts" on stock_receipts;
create policy "Public read stock_receipts" on stock_receipts for select using (true);
create policy "Auth insert stock_receipts" on stock_receipts for insert with check (true);
create policy "Auth update stock_receipts" on stock_receipts for update using (true);
create policy "Auth delete stock_receipts" on stock_receipts for delete using (true);

-- Позиции получения
create table if not exists stock_receipt_items (
    id uuid primary key default uuid_generate_v4(),
    receipt_id uuid references stock_receipts(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    price decimal(10,2),
    created_at timestamptz default now()
);

alter table stock_receipt_items enable row level security;
drop policy if exists "Public read stock_receipt_items" on stock_receipt_items;
drop policy if exists "Auth insert stock_receipt_items" on stock_receipt_items;
drop policy if exists "Auth update stock_receipt_items" on stock_receipt_items;
drop policy if exists "Auth delete stock_receipt_items" on stock_receipt_items;
create policy "Public read stock_receipt_items" on stock_receipt_items for select using (true);
create policy "Auth insert stock_receipt_items" on stock_receipt_items for insert with check (true);
create policy "Auth update stock_receipt_items" on stock_receipt_items for update using (true);
create policy "Auth delete stock_receipt_items" on stock_receipt_items for delete using (true);

-- Выдачи со склада
create table if not exists stock_issues (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id) on delete cascade,
    number serial,
    recipient_id uuid references team_members(id) on delete set null,
    issue_date timestamptz,
    notes text,
    archived boolean default false,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

drop trigger if exists update_stock_issues_updated_at on stock_issues;
create trigger update_stock_issues_updated_at before update on stock_issues
    for each row execute function update_updated_at();

alter table stock_issues enable row level security;
drop policy if exists "Public read stock_issues" on stock_issues;
drop policy if exists "Auth insert stock_issues" on stock_issues;
drop policy if exists "Auth update stock_issues" on stock_issues;
drop policy if exists "Auth delete stock_issues" on stock_issues;
create policy "Public read stock_issues" on stock_issues for select using (true);
create policy "Auth insert stock_issues" on stock_issues for insert with check (true);
create policy "Auth update stock_issues" on stock_issues for update using (true);
create policy "Auth delete stock_issues" on stock_issues for delete using (true);

-- Позиции выдачи
create table if not exists stock_issue_items (
    id uuid primary key default uuid_generate_v4(),
    issue_id uuid references stock_issues(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    created_at timestamptz default now()
);

alter table stock_issue_items enable row level security;
drop policy if exists "Public read stock_issue_items" on stock_issue_items;
drop policy if exists "Auth insert stock_issue_items" on stock_issue_items;
drop policy if exists "Auth update stock_issue_items" on stock_issue_items;
drop policy if exists "Auth delete stock_issue_items" on stock_issue_items;
create policy "Public read stock_issue_items" on stock_issue_items for select using (true);
create policy "Auth insert stock_issue_items" on stock_issue_items for insert with check (true);
create policy "Auth update stock_issue_items" on stock_issue_items for update using (true);
create policy "Auth delete stock_issue_items" on stock_issue_items for delete using (true);

-- История цен (опционально)
create table if not exists price_history (
    id uuid primary key default uuid_generate_v4(),
    product_id uuid references products(id) on delete cascade,
    location_id uuid references locations(id) on delete cascade,
    price decimal(10,2) not null,
    recorded_at timestamptz default now()
);

alter table price_history enable row level security;
drop policy if exists "Public read price_history" on price_history;
drop policy if exists "Auth insert price_history" on price_history;
create policy "Public read price_history" on price_history for select using (true);
create policy "Auth insert price_history" on price_history for insert with check (true);

-- Индексы для производительности
create index if not exists idx_stock_location_product on stock(location_id, product_id);
create index if not exists idx_stock_receipts_location on stock_receipts(location_id);
create index if not exists idx_stock_issues_location on stock_issues(location_id);
create index if not exists idx_purchase_requests_location on purchase_requests(location_id);
create index if not exists idx_price_history_product on price_history(product_id, recorded_at desc);

-- ============================================
-- ПЕРЕВОДЫ ДЛЯ СКЛАДА
-- ============================================
insert into translations (key, ru, en, hi, context) values
-- Страница Остатки
('stock_inventory_title', 'Остатки на складе', 'Stock Inventory', 'स्टॉक इन्वेंटरी', 'Заголовок страницы'),
('stock_total_items', 'Всего позиций', 'Total items', 'कुल आइटम', 'Статистика'),
('stock_critical', 'Критично', 'Critical', 'गंभीर', 'Статистика'),
('stock_low', 'Заканчивается', 'Low', 'कम', 'Статистика'),
('stock_ok', 'В норме', 'OK', 'सामान्य', 'Статистика'),
('stock_current', 'Текущий остаток', 'Current stock', 'वर्तमान स्टॉक', 'Поле формы'),
('stock_min', 'Мин. остаток', 'Min stock', 'न्यूनतम स्टॉक', 'Поле формы'),
('stock_min_short', 'Мин', 'Min', 'न्यून', 'Краткое'),
('stock_should_be', 'Должно быть', 'Should be', 'होना चाहिए', 'Минимальный остаток'),
('stock_edit_quantity', 'Изменить остаток', 'Edit quantity', 'मात्रा संपादित करें', 'Заголовок модалки'),
('stock_new_value', 'Или введите новое значение', 'Or enter new value', 'या नया मान दर्ज करें', 'Подсказка'),
('supplier', 'Поставщик', 'Supplier', 'आपूर्तिकर्ता', 'Поле формы'),
('current_price', 'Текущая цена (₹)', 'Current price (₹)', 'वर्तमान मूल्य (₹)', 'Поле формы'),
('no_items', 'Нет продуктов', 'No items', 'कोई आइटम नहीं', 'Пустой результат'),

-- Страница Заявки
('requests_title', 'Заявки на закупку', 'Purchase Requests', 'खरीद अनुरोध', 'Заголовок страницы'),
('new_request', 'Новая заявка', 'New request', 'नया अनुरोध', 'Кнопка'),
('new_request_tab', 'Новая заявка', 'New Request', 'नया अनुरोध', 'Таб'),
('saved_requests_tab', 'Сохранённые', 'Saved', 'सहेजी गई', 'Таб'),
('active', 'Активные', 'Active', 'सक्रिय', 'Кнопка'),
('archive', 'Архив', 'Archive', 'संग्रह', 'Кнопка'),
('no_saved_requests', 'Нет сохранённых заявок', 'No saved requests', 'कोई सहेजा गया अनुरोध नहीं', 'Пустой результат'),
('no_archived_requests', 'Нет заявок в архиве', 'No archived requests', 'संग्रह में कोई अनुरोध नहीं', 'Пустой результат'),
('request', 'Заявка', 'Request', 'अनुरोध', 'Общее'),
('items_short', 'поз.', 'items', 'आइटम', 'Краткое'),
('period', 'Период', 'Period', 'अवधि', 'Общее'),
('created', 'Создано', 'Created', 'बनाया गया', 'Общее'),
('view', 'Просмотр', 'View', 'देखें', 'Кнопка'),
('to_archive', 'В архив', 'To archive', 'संग्रह में', 'Кнопка'),
('restore', 'Восстановить', 'Restore', 'पुनर्स्थापित करें', 'Кнопка'),
('save_first', 'Сначала сохраните заявку', 'Save request first', 'पहले अनुरोध सहेजें', 'Подсказка'),
('est_price', '≈ Сумма', '≈ Price', '≈ कीमत', 'Колонка таблицы'),
('est_total', 'Примерная сумма:', 'Estimated total:', 'अनुमानित कुल:', 'Итог'),
('add_product', 'Добавить продукт', 'Add product', 'उत्पाद जोड़ें', 'Кнопка'),
('product_already_added', 'Этот продукт уже добавлен в заявку', 'This product is already in the request', 'यह उत्पाद पहले से अनुरोध में है', 'Ошибка'),
('quantity', 'Количество', 'Quantity', 'मात्रा', 'Поле формы'),
('remove', 'Удалить', 'Remove', 'हटाएं', 'Кнопка'),
('search', 'Поиск', 'Search', 'खोज', 'Таб'),
('by_category', 'По категории', 'By category', 'श्रेणी के अनुसार', 'Таб'),
('nothing_found', 'Ничего не найдено', 'Nothing found', 'कुछ नहीं मिला', 'Пустой результат'),

-- Страница Получить
('receive_title', 'Получение товаров', 'Receive Goods', 'माल प्राप्त करें', 'Заголовок страницы'),
('new_receipt', 'Оформить получение', 'New receipt', 'नई रसीद', 'Кнопка'),

-- Страница Выдать
('issue_title', 'Выдача продуктов', 'Issue Products', 'उत्पाद जारी करें', 'Заголовок страницы'),
('new_issue', 'Оформить выдачу', 'New issue', 'नया जारी', 'Кнопка'),

-- Страница Настройки склада
('nav_stock_settings', 'Настройки', 'Settings', 'सेटिंग्स', 'Меню склада'),
('stock_settings_title', 'Настройки склада', 'Stock Settings', 'स्टॉक सेटिंग्स', 'Заголовок страницы')

on conflict (key) do update set
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
