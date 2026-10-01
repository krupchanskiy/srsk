-- =============================================================
-- Роли поваров кухни выдаются сами по справочнику поваров (решение ВГ 01.10.2026).
--
-- Уровень в справочнике (Кухня → Справочники → «Повара»):
--   cook      — «Повар»: видит меню, планировщик, шаблоны, рецепты, продукты, склад,
--               заявки и инвентаризацию, но ничего не правит (роль kitchen_cook);
--   sous_chef — «Су-шеф»: правит всё кухонное, как шеф (роль sous_chef);
--   chef      — «Шеф»: роль ставится вручную (у Сундары Рупы к ней личные права на финансы),
--               автоматика её не трогает.
-- Роль выдаётся, если у человека свой вход на сайт, он в департаменте «Кухня» и стоит
-- в справочнике поваров. Ушёл из кухни или убран из справочника — роль снимается.
-- Цены, себестоимость и счёт кухни ни одна из этих ролей не открывает.
--
-- Прежние роли cook/chef не трогаем: на них Кафе и люди вне кухни.
-- =============================================================

-- ---------- роли ----------
insert into roles (code, name_ru, name_en, name_hi, description_ru, description_en, color, sort_order) values
  ('kitchen_cook', 'Повар кухни', 'Kitchen cook', 'रसोइया',
   'Видит меню, рецепты, шаблоны, продукты, склад, заявки и инвентаризацию — без правки. Выдаётся сама по справочнику поваров',
   'Views menu, recipes, templates, products, stock, requests and inventory — read only. Granted automatically from the cooks list',
   '#f49800', 2),
  ('sous_chef', 'Су-шеф', 'Sous-chef', 'सू-शेफ',
   'Правит меню, рецепты, продукты, склад — как шеф, без финансов. Выдаётся сама по справочнику поваров',
   'Edits menu, recipes, products, stock — like the chef, no finances. Granted automatically from the cooks list',
   '#ea580c', 3)
on conflict (code) do nothing;

insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
 where r.code = 'kitchen_cook'
   and p.code in ('view_menu', 'view_menu_templates', 'view_recipes', 'view_products',
                  'view_stock', 'view_requests', 'view_timeline', 'view_vaishnavas',
                  'view_own_profile', 'edit_own_profile')
on conflict do nothing;

-- су-шеф = нынешний набор шефа
insert into role_permissions (role_id, permission_id)
select s.id, rp.permission_id from roles s, role_permissions rp join roles c on c.id = rp.role_id
 where s.code = 'sous_chef' and c.code = 'chef'
on conflict do nothing;

-- ---------- инвентаризацию видит каждый, кто видит склад ----------
drop policy if exists "Kitchen users read inventories in location" on stock_inventories;
create policy "Kitchen users read inventories in location" on stock_inventories for select to authenticated
  using (abk_current_user_has_permission('view_stock') and abk_current_user_can_access_location(location_id));
drop policy if exists "Kitchen users read inventory items in location" on stock_inventory_items;
create policy "Kitchen users read inventory items in location" on stock_inventory_items for select to authenticated
  using (abk_current_user_has_permission('view_stock') and exists (
    select 1 from stock_inventories si
     where si.id = stock_inventory_items.inventory_id and abk_current_user_can_access_location(si.location_id)));

-- ---------- уровень в справочнике поваров ----------
alter table kitchen_cooks add column if not exists level text not null default 'cook'
  check (level in ('cook', 'sous_chef', 'chef'));

-- ---------- синхронизация ролей одного человека ----------
create or replace function kitchen_cook_sync_roles(p_vaishnava uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_user  uuid;
    v_level text;
    v_want  text;
    v_role  record;
begin
    select user_id into v_user from vaishnavas where id = p_vaishnava;
    if v_user is null then return; end if;
    -- общий вход (почта-заглушка у многих карточек) — прав не даём и не трогаем
    if (select count(*) from vaishnavas where user_id = v_user and not coalesce(is_deleted, false)) > 1 then
        return;
    end if;

    select c.level into v_level
      from kitchen_cooks c
      join vaishnavas v on v.id = c.vaishnava_id
      join departments d on d.id = v.department_id
     where c.vaishnava_id = p_vaishnava and c.is_active
       and d.name_ru = 'Кухня'
       and v.is_active and not coalesce(v.is_deleted, false)
     order by case c.level when 'chef' then 0 when 'sous_chef' then 1 else 2 end
     limit 1;

    v_want := case v_level when 'cook' then 'kitchen_cook' when 'sous_chef' then 'sous_chef' end;

    for v_role in select id, code from roles where code in ('kitchen_cook', 'sous_chef') loop
        if v_role.code = v_want then
            insert into user_roles (user_id, role_id, is_active) values (v_user, v_role.id, true)
            on conflict (user_id, role_id) do update set is_active = true, assigned_at = now()
             where not user_roles.is_active;
        else
            update user_roles set is_active = false
             where user_id = v_user and role_id = v_role.id and is_active;
        end if;
    end loop;
end $$;
revoke all on function kitchen_cook_sync_roles(uuid) from public, anon, authenticated;

create or replace function trg_kitchen_cooks_sync_roles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if tg_op in ('UPDATE', 'DELETE') then
        perform kitchen_cook_sync_roles(old.vaishnava_id);
    end if;
    if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or new.vaishnava_id is distinct from old.vaishnava_id
                                          or new.level is distinct from old.level
                                          or new.is_active is distinct from old.is_active) then
        perform kitchen_cook_sync_roles(new.vaishnava_id);
    end if;
    return null;
end $$;
drop trigger if exists trg_kitchen_cooks_sync_roles on kitchen_cooks;
create trigger trg_kitchen_cooks_sync_roles after insert or update or delete on kitchen_cooks
    for each row execute function trg_kitchen_cooks_sync_roles();

create or replace function trg_vaishnava_kitchen_roles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if not exists (select 1 from kitchen_cooks where vaishnava_id = new.id) then return null; end if;
    -- вход переехал на другую карточку — со старого снимаем кухонные роли
    if old.user_id is not null and old.user_id is distinct from new.user_id then
        update user_roles set is_active = false
         where user_id = old.user_id and is_active
           and role_id in (select id from roles where code in ('kitchen_cook', 'sous_chef'));
    end if;
    perform kitchen_cook_sync_roles(new.id);
    return null;
end $$;
drop trigger if exists trg_vaishnava_kitchen_roles on vaishnavas;
create trigger trg_vaishnava_kitchen_roles after update of department_id, user_id, is_active, is_deleted on vaishnavas
    for each row execute function trg_vaishnava_kitchen_roles();

-- ---------- нынешние повара ----------
update kitchen_cooks set level = 'chef'      where vaishnava_id = '70e8f35c-f1a9-40fe-b510-93e6ad05a52e'; -- Сундара Рупа
update kitchen_cooks set level = 'sous_chef' where vaishnava_id = 'c57960b0-ad75-44d7-9ace-1f34b90bc256'; -- Садху-санга
-- их прежние ручные роли заменяются автоматическими
update user_roles set is_active = false
 where user_id = '8cf1c7d4-9cdc-41c6-bccd-f91999bbb272' and role_id = (select id from roles where code = 'chef');  -- Садху-санга
update user_roles set is_active = false
 where user_id = 'd4557c84-0c1b-4020-8199-6e1fb0b1d178' and role_id = (select id from roles where code = 'cook');  -- Ниламани-прия

-- Джаганнатх Прасад: три карточки → одна, та, с которой он входит (подтвердил ВГ 01.10)
select merge_vaishnavas('64d33e47-919e-4103-aeed-5f8571e8ca34', 'a425aef7-a31e-4614-8650-54249c2ec7e6');
select merge_vaishnavas('64d33e47-919e-4103-aeed-5f8571e8ca34', 'd31d09de-3084-43d8-a389-973098c19741');
delete from kitchen_cooks where id = '74ef41da-ddfe-46f9-80dd-ef6b6b51b1da';  -- лишняя строка «ДП», блюд за ней нет
update kitchen_cooks set name = 'Джаганнатх Прасад дас' where id = 'debb1594-d6e4-4be8-bbb7-4c8b56ab3200';
update vaishnavas set spiritual_name = 'Джаганнатх Прасад дас', user_type = 'volunteer',
       department_id = '36547c0b-7e4c-4bf8-a76c-cf907513f163'  -- Кухня
 where id = '64d33e47-919e-4103-aeed-5f8571e8ca34';

-- Ананда Гопал дас (Алексей Музалевский): две карточки → та, с которой он входит (ВГ 01.10)
select merge_vaishnavas('928f705d-e5fb-4e39-9185-dfd572f4de03', '0efd7cd7-c99b-471b-8f2a-457242ae5b7c');
update kitchen_cooks set name = 'Ананда Гопал дас' where vaishnava_id = '928f705d-e5fb-4e39-9185-dfd572f4de03';
update vaishnavas set user_type = 'volunteer',
       department_id = '36547c0b-7e4c-4bf8-a76c-cf907513f163'  -- Кухня
 where id = '928f705d-e5fb-4e39-9185-dfd572f4de03';

-- прогнать правило по всем поварам
select kitchen_cook_sync_roles(vaishnava_id) from (select distinct vaishnava_id from kitchen_cooks) x;

-- ---------- переводы ----------
insert into translations (key, ru, en, hi, context) values
('cook_level', 'Уровень', 'Level', 'स्तर', 'Справочник поваров'),
('cook_level_cook', 'Повар — только смотрит', 'Cook — view only', 'रसोइया — केवल देखना', 'Справочник поваров: уровень'),
('cook_level_sous_chef', 'Су-шеф — правит', 'Sous-chef — can edit', 'सू-शेफ — संपादन', 'Справочник поваров: уровень'),
('cook_level_chef', 'Шеф', 'Chef', 'शेफ', 'Справочник поваров: уровень'),
('cook_level_hint', 'Доступ к сайту выдаётся сам, если у человека есть вход и он в департаменте «Кухня»', 'Site access is granted automatically if the person has a login and is in the Kitchen department', 'साइट की पहुँच अपने आप मिलती है, यदि व्यक्ति का लॉगिन है और वह रसोई विभाग में है', 'Справочник поваров')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
