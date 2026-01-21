-- ============================================
-- ИСПРАВЛЕНИЕ ТАБЛИЦЫ STOCK
-- ============================================

-- Проверяем структуру существующей таблицы
-- select column_name, data_type from information_schema.columns where table_name = 'stock';

-- Удаляем старую таблицу stock и создаём заново с правильной структурой
drop table if exists stock_issue_items cascade;
drop table if exists stock_receipt_items cascade;
drop table if exists stock_issues cascade;
drop table if exists stock_receipts cascade;
drop table if exists purchase_request_items cascade;
drop table if exists purchase_requests cascade;
drop table if exists price_history cascade;
drop table if exists stock cascade;

-- Остатки на складе
create table stock (
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

create trigger update_stock_updated_at before update on stock
    for each row execute function update_updated_at();

alter table stock enable row level security;
create policy "Public read stock" on stock for select using (true);
create policy "Auth insert stock" on stock for insert with check (true);
create policy "Auth update stock" on stock for update using (true);
create policy "Auth delete stock" on stock for delete using (true);

-- Заявки на закупку
create table purchase_requests (
    id uuid primary key default uuid_generate_v4(),
    location_id uuid references locations(id) on delete cascade,
    number serial,
    period_from date,
    period_to date,
    status text default 'pending',
    notes text,
    created_at timestamptz default now(),
    updated_at timestamptz default now()
);

create trigger update_purchase_requests_updated_at before update on purchase_requests
    for each row execute function update_updated_at();

alter table purchase_requests enable row level security;
create policy "Public read purchase_requests" on purchase_requests for select using (true);
create policy "Auth insert purchase_requests" on purchase_requests for insert with check (true);
create policy "Auth update purchase_requests" on purchase_requests for update using (true);
create policy "Auth delete purchase_requests" on purchase_requests for delete using (true);

-- Позиции заявки
create table purchase_request_items (
    id uuid primary key default uuid_generate_v4(),
    request_id uuid references purchase_requests(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    price decimal(10,2),
    created_at timestamptz default now()
);

alter table purchase_request_items enable row level security;
create policy "Public read purchase_request_items" on purchase_request_items for select using (true);
create policy "Auth insert purchase_request_items" on purchase_request_items for insert with check (true);
create policy "Auth update purchase_request_items" on purchase_request_items for update using (true);
create policy "Auth delete purchase_request_items" on purchase_request_items for delete using (true);

-- Получения товаров
create table stock_receipts (
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

create trigger update_stock_receipts_updated_at before update on stock_receipts
    for each row execute function update_updated_at();

alter table stock_receipts enable row level security;
create policy "Public read stock_receipts" on stock_receipts for select using (true);
create policy "Auth insert stock_receipts" on stock_receipts for insert with check (true);
create policy "Auth update stock_receipts" on stock_receipts for update using (true);
create policy "Auth delete stock_receipts" on stock_receipts for delete using (true);

-- Позиции получения
create table stock_receipt_items (
    id uuid primary key default uuid_generate_v4(),
    receipt_id uuid references stock_receipts(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    price decimal(10,2),
    created_at timestamptz default now()
);

alter table stock_receipt_items enable row level security;
create policy "Public read stock_receipt_items" on stock_receipt_items for select using (true);
create policy "Auth insert stock_receipt_items" on stock_receipt_items for insert with check (true);
create policy "Auth update stock_receipt_items" on stock_receipt_items for update using (true);
create policy "Auth delete stock_receipt_items" on stock_receipt_items for delete using (true);

-- Выдачи со склада
create table stock_issues (
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

create trigger update_stock_issues_updated_at before update on stock_issues
    for each row execute function update_updated_at();

alter table stock_issues enable row level security;
create policy "Public read stock_issues" on stock_issues for select using (true);
create policy "Auth insert stock_issues" on stock_issues for insert with check (true);
create policy "Auth update stock_issues" on stock_issues for update using (true);
create policy "Auth delete stock_issues" on stock_issues for delete using (true);

-- Позиции выдачи
create table stock_issue_items (
    id uuid primary key default uuid_generate_v4(),
    issue_id uuid references stock_issues(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity decimal(10,2) not null,
    created_at timestamptz default now()
);

alter table stock_issue_items enable row level security;
create policy "Public read stock_issue_items" on stock_issue_items for select using (true);
create policy "Auth insert stock_issue_items" on stock_issue_items for insert with check (true);
create policy "Auth update stock_issue_items" on stock_issue_items for update using (true);
create policy "Auth delete stock_issue_items" on stock_issue_items for delete using (true);

-- История цен
create table price_history (
    id uuid primary key default uuid_generate_v4(),
    product_id uuid references products(id) on delete cascade,
    location_id uuid references locations(id) on delete cascade,
    price decimal(10,2) not null,
    recorded_at timestamptz default now()
);

alter table price_history enable row level security;
create policy "Public read price_history" on price_history for select using (true);
create policy "Auth insert price_history" on price_history for insert with check (true);

-- Индексы
create index idx_stock_location_product on stock(location_id, product_id);
create index idx_stock_receipts_location on stock_receipts(location_id);
create index idx_stock_issues_location on stock_issues(location_id);
create index idx_purchase_requests_location on purchase_requests(location_id);
create index idx_price_history_product on price_history(product_id, recorded_at desc);
