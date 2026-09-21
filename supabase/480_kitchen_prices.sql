-- =============================================================
-- Цены продуктов и посуды кухни с историей по периодам
-- (этап 1 учёта себестоимости прасада, см. ТЗ «Учёт затрат кухни»).
--
-- Новая цена закрывает действующую (valid_to = дата новой − 1 день) и
-- открывает новый период. Старые периоды остаются и используются при
-- расчёте за прошлое. Пересекающихся периодов и двух действующих цен у
-- продукта быть не может (exclusion constraint).
--
-- Цены только для кухни: в записи есть location_id (сейчас основная кухня).
--
-- Права строгие, без обхода для суперпользователей (по образцу 258):
-- их много, в т.ч. главы других департаментов. Выдаются поимённо или
-- ролью через role_permissions.
--
-- Пустые price_history и products.price_min/price_max здесь НЕ удаляются:
-- сначала нужно убедиться, что их не читает приложение AB Kitchen.
-- =============================================================

create extension if not exists btree_gist with schema extensions;
set local search_path = public, extensions;

-- ---------- права ----------
insert into permissions (code, name_ru, name_en, name_hi, category, sort_order) values
  ('view_prices', 'Просмотр цен продуктов', 'View product prices', 'उत्पाद मूल्य देखें', 'kitchen', 0),
  ('edit_prices', 'Внесение цен продуктов', 'Edit product prices', 'उत्पाद मूल्य दर्ज करें', 'kitchen', 0),
  ('edit_archived_prices', 'Исправление архивных цен', 'Correct archived prices', 'पुराने मूल्य सुधारें', 'kitchen', 0)
on conflict (code) do nothing;

create or replace function public.kitchen_has_permission(p_user uuid, p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when p_user is null then false
    when exists (select 1 from user_permissions up join permissions p on p.id = up.permission_id
                  where up.user_id = p_user and p.code = p_code)
      then (select up.is_granted from user_permissions up join permissions p on p.id = up.permission_id
             where up.user_id = p_user and p.code = p_code
             order by up.created_at desc limit 1)
    else exists (select 1 from user_roles ur
                   join role_permissions rp on rp.role_id = ur.role_id
                   join permissions p on p.id = rp.permission_id
                  where ur.user_id = p_user and ur.is_active and p.code = p_code)
  end;
$$;
revoke all on function public.kitchen_has_permission(uuid, text) from public, anon;
grant execute on function public.kitchen_has_permission(uuid, text) to authenticated;

-- ---------- таблицы ----------
create table public.kitchen_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  location_id uuid not null references public.locations(id),
  price numeric(12,2) not null check (price >= 0),
  valid_from date not null,
  valid_to date,
  reason_category text not null default 'other'
    check (reason_category in ('supplier_change', 'new_purchase', 'fix_error', 'other')),
  comment text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint kitchen_prices_period_ok check (valid_to is null or valid_to >= valid_from),
  constraint kitchen_prices_no_overlap exclude using gist (
    product_id with =, location_id with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);
create index kitchen_prices_product_idx on public.kitchen_prices (product_id, location_id, valid_from);

create table public.kitchen_price_corrections (
  id uuid primary key default gen_random_uuid(),
  price_id uuid not null references public.kitchen_prices(id) on delete cascade,
  old_price numeric(12,2) not null,
  new_price numeric(12,2) not null,
  reason text not null,
  corrected_by uuid default auth.uid(),
  corrected_at timestamptz not null default now()
);
create index kitchen_price_corrections_price_idx on public.kitchen_price_corrections (price_id);

alter table public.kitchen_prices enable row level security;
alter table public.kitchen_price_corrections enable row level security;
revoke all on public.kitchen_prices, public.kitchen_price_corrections from anon;

-- читать: по праву; писать напрямую нельзя никому (только через функции ниже)
create policy "Kitchen prices read" on public.kitchen_prices
  for select to authenticated
  using (kitchen_has_permission((select auth.uid()), 'view_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_archived_prices'));

create policy "Kitchen price corrections read" on public.kitchen_price_corrections
  for select to authenticated
  using (kitchen_has_permission((select auth.uid()), 'view_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_archived_prices'));

-- ---------- внесение новой цены ----------
create or replace function public.kitchen_set_price(
  p_product_id uuid,
  p_location_id uuid,
  p_price numeric,
  p_valid_from date,
  p_reason_category text default 'other',
  p_comment text default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_open kitchen_prices%rowtype;
  v_id uuid;
begin
  if not kitchen_has_permission(auth.uid(), 'edit_prices') then
    raise exception 'forbidden' using detail = 'Нет права на внесение цен';
  end if;
  if p_price is null or p_price < 0 then
    raise exception 'invalid_payload' using detail = 'Цена должна быть числом не меньше нуля';
  end if;
  if p_valid_from is null then
    raise exception 'invalid_payload' using detail = 'Не указана дата начала действия';
  end if;
  if p_reason_category not in ('supplier_change', 'new_purchase', 'fix_error', 'other') then
    raise exception 'invalid_payload' using detail = 'Неизвестная причина изменения цены';
  end if;
  if not exists (select 1 from products where id = p_product_id) then
    raise exception 'invalid_payload' using detail = 'Продукт не найден';
  end if;
  if not exists (select 1 from locations where id = p_location_id) then
    raise exception 'invalid_payload' using detail = 'Кухня не найдена';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_product_id::text || p_location_id::text, 0));

  select * into v_open from kitchen_prices
   where product_id = p_product_id and location_id = p_location_id and valid_to is null;

  if found then
    if p_valid_from <= v_open.valid_from then
      raise exception 'invalid_payload' using detail =
        format('Дата должна быть позже начала действующей цены (%s). Чтобы исправить ошибку ввода, используйте исправление записи', v_open.valid_from);
    end if;
    if v_open.price = p_price then
      raise exception 'invalid_payload' using detail = 'Цена не изменилась';
    end if;
    update kitchen_prices set valid_to = p_valid_from - 1 where id = v_open.id;
  end if;

  insert into kitchen_prices (product_id, location_id, price, valid_from, reason_category, comment)
  values (p_product_id, p_location_id, p_price, p_valid_from, p_reason_category, nullif(btrim(p_comment), ''))
  returning id into v_id;

  return v_id;
exception
  when exclusion_violation then
    raise exception 'invalid_payload' using detail = 'Период пересекается с уже введённой ценой этого продукта';
end;
$$;

-- ---------- исправление записи (узкое право) ----------
create or replace function public.kitchen_correct_price(
  p_price_id uuid,
  p_new_price numeric,
  p_reason text
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v kitchen_prices%rowtype;
begin
  if not kitchen_has_permission(auth.uid(), 'edit_archived_prices') then
    raise exception 'forbidden' using detail = 'Нет права на исправление архивных цен';
  end if;
  if p_new_price is null or p_new_price < 0 then
    raise exception 'invalid_payload' using detail = 'Цена должна быть числом не меньше нуля';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'invalid_payload' using detail = 'Укажите причину исправления';
  end if;

  select * into v from kitchen_prices where id = p_price_id for update;
  if not found then
    raise exception 'invalid_payload' using detail = 'Запись цены не найдена';
  end if;
  if v.price = p_new_price then
    raise exception 'invalid_payload' using detail = 'Цена не изменилась';
  end if;

  insert into kitchen_price_corrections (price_id, old_price, new_price, reason)
  values (v.id, v.price, p_new_price, btrim(p_reason));

  update kitchen_prices set price = p_new_price where id = v.id;
end;
$$;

-- ---------- цена на дату ----------
-- Правило «задним числом»: если на дату цены ещё не было, но у продукта есть
-- более поздняя, действует самая ранняя введённая. Если цен нет совсем — null.
create or replace function public.kitchen_price_on(
  p_product_id uuid,
  p_location_id uuid,
  p_date date
) returns numeric
language plpgsql stable security definer set search_path = public
as $$
declare
  v_price numeric;
begin
  if not (kitchen_has_permission(auth.uid(), 'view_prices')
       or kitchen_has_permission(auth.uid(), 'edit_prices')
       or kitchen_has_permission(auth.uid(), 'edit_archived_prices')) then
    raise exception 'forbidden' using detail = 'Нет права на просмотр цен';
  end if;

  select price into v_price from kitchen_prices
   where product_id = p_product_id and location_id = p_location_id
     and valid_from <= p_date and (valid_to is null or valid_to >= p_date)
   limit 1;
  if found then
    return v_price;
  end if;

  if not exists (select 1 from kitchen_prices
                  where product_id = p_product_id and location_id = p_location_id
                    and valid_from <= p_date) then
    select price into v_price from kitchen_prices
     where product_id = p_product_id and location_id = p_location_id
     order by valid_from limit 1;
    return v_price;
  end if;

  return null;
end;
$$;

revoke all on function public.kitchen_set_price(uuid, uuid, numeric, date, text, text) from public, anon;
revoke all on function public.kitchen_correct_price(uuid, numeric, text) from public, anon;
revoke all on function public.kitchen_price_on(uuid, uuid, date) from public, anon;
grant execute on function public.kitchen_set_price(uuid, uuid, numeric, date, text, text) to authenticated;
grant execute on function public.kitchen_correct_price(uuid, numeric, text) to authenticated;
grant execute on function public.kitchen_price_on(uuid, uuid, date) to authenticated;
