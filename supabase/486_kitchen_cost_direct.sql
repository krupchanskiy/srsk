-- =============================================================
-- Прямые затраты кухни (этап 3 учёта себестоимости прасада, ТЗ п. 3.6):
--   * категория и 5 позиций одноразовой посуды как обычные продукты
--     (цена вносится во вкладке «Цены»);
--   * набор посуды на порцию по приёму пищи (kitchen_portion_kits):
--     коэффициент на позицию, на старте 1,0, потом подбирается по замеру;
--   * строки «Готовое со стороны» в меню (menu_external_items): сумма
--     вводится вручную по факту оплаты, число людей берётся из подсчёта
--     вкушающих либо задаётся вручную.
-- =============================================================

-- ---------- посуда как продукты ----------
insert into product_categories (slug, name_ru, name_en, name_hi, sort_order)
select 'disposable', 'Одноразовая посуда', 'Disposable tableware', 'डिस्पोज़ेबल बर्तन', 90
where not exists (select 1 from product_categories where slug = 'disposable');

insert into products (category_id, name_ru, name_en, name_hi, unit)
select c.id, v.ru, v.en, v.hi, 'pcs'
from product_categories c
cross join (values
  ('Тарелка плоская (одноразовая)', 'Flat plate (disposable)', 'फ्लैट प्लेट (डिस्पोज़ेबल)'),
  ('Тарелка глубокая (одноразовая)', 'Deep plate (disposable)', 'गहरी प्लेट (डिस्पोज़ेबल)'),
  ('Стаканчик коричневый (одноразовый)', 'Brown cup (disposable)', 'भूरा कप (डिस्पोज़ेबल)'),
  ('Стаканчик чёрный (одноразовый)', 'Black cup (disposable)', 'काला कप (डिस्पोज़ेबल)'),
  ('Ложка (одноразовая)', 'Spoon (disposable)', 'चम्मच (डिस्पोज़ेबल)')
) as v(ru, en, hi)
where c.slug = 'disposable'
  and not exists (select 1 from products p where p.name_en = v.en);

-- ---------- набор посуды на порцию ----------
create table public.kitchen_portion_kits (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id),
  meal_type text not null check (meal_type in ('breakfast', 'lunch')),
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(8,3) not null check (quantity > 0),
  updated_at timestamptz not null default now(),
  unique (location_id, meal_type, product_id)
);

alter table public.kitchen_portion_kits enable row level security;
revoke all on public.kitchen_portion_kits from anon;

create policy "Kitchen kits read" on public.kitchen_portion_kits
  for select to authenticated
  using (kitchen_has_permission((select auth.uid()), 'view_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_prices')
      or kitchen_has_permission((select auth.uid()), 'edit_archived_prices'));

create or replace function public.kitchen_set_kit_item(
  p_location_id uuid,
  p_meal_type text,
  p_product_id uuid,
  p_quantity numeric
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not kitchen_has_permission(auth.uid(), 'edit_prices') then
    raise exception 'forbidden' using detail = 'Нет права на изменение набора посуды';
  end if;
  if p_meal_type not in ('breakfast', 'lunch') then
    raise exception 'invalid_payload' using detail = 'Приём пищи: завтрак или обед';
  end if;
  if not exists (select 1 from products where id = p_product_id) then
    raise exception 'invalid_payload' using detail = 'Продукт не найден';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    delete from kitchen_portion_kits
     where location_id = p_location_id and meal_type = p_meal_type and product_id = p_product_id;
  else
    insert into kitchen_portion_kits (location_id, meal_type, product_id, quantity)
    values (p_location_id, p_meal_type, p_product_id, p_quantity)
    on conflict (location_id, meal_type, product_id)
      do update set quantity = excluded.quantity, updated_at = now();
  end if;
end;
$$;
revoke all on function public.kitchen_set_kit_item(uuid, text, uuid, numeric) from public, anon;
grant execute on function public.kitchen_set_kit_item(uuid, text, uuid, numeric) to authenticated;

-- набор из ТЗ: завтрак — плоская, коричневый стаканчик, ложка;
-- обед — плоская, глубокая, коричневый и чёрный стаканчики, ложка
insert into kitchen_portion_kits (location_id, meal_type, product_id, quantity)
select l.id, k.meal_type, p.id, 1
from locations l
join (values
  ('breakfast', 'Flat plate (disposable)'), ('breakfast', 'Brown cup (disposable)'), ('breakfast', 'Spoon (disposable)'),
  ('lunch', 'Flat plate (disposable)'), ('lunch', 'Deep plate (disposable)'),
  ('lunch', 'Brown cup (disposable)'), ('lunch', 'Black cup (disposable)'), ('lunch', 'Spoon (disposable)')
) as k(meal_type, name_en) on true
join products p on p.name_en = k.name_en
where l.slug = 'main'
on conflict (location_id, meal_type, product_id) do nothing;

-- ---------- строки «Готовое со стороны» в меню ----------
create table public.menu_external_items (
  id uuid primary key default gen_random_uuid(),
  meal_id uuid not null references public.menu_meals(id) on delete cascade,
  name text not null,
  amount numeric(12,2) not null check (amount >= 0),
  persons integer check (persons is null or persons > 0),
  comment text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index menu_external_items_meal_idx on public.menu_external_items (meal_id);

alter table public.menu_external_items enable row level security;
revoke all on public.menu_external_items from anon;

create policy "Kitchen users read external items" on public.menu_external_items
  for select to authenticated
  using (abk_current_user_has_permission('view_menu') and exists (
    select 1 from menu_meals mm
     where mm.id = menu_external_items.meal_id and abk_current_user_can_access_location(mm.location_id)));

create policy "Kitchen users manage external items" on public.menu_external_items
  for all to authenticated
  using (abk_current_user_has_permission('edit_menu') and exists (
    select 1 from menu_meals mm
     where mm.id = menu_external_items.meal_id and abk_current_user_can_access_location(mm.location_id)))
  with check (abk_current_user_has_permission('edit_menu') and exists (
    select 1 from menu_meals mm
     where mm.id = menu_external_items.meal_id and abk_current_user_can_access_location(mm.location_id)));
