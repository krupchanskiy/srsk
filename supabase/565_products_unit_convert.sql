-- =============================================================
-- Смена единицы продукта (решение ВГ 27.09.2026: «шафран покупают граммами — почему нельзя?»).
-- Было: при ценах смена единицы запрещалась. Стало: в пределах одного вида
-- (кг ↔ г, л ↔ мл) цены кухни пересчитываются сами (цена ÷ k, k = старая/новая единица,
-- кг → г: 1000) и записываются в журнал исправлений цен.
-- Склад НЕ пересчитывается: количества в нём хранятся не всегда в единице продукта
-- (в заявках на закупку «кг»-продукты записаны в граммах), поэтому при ненулевом
-- остатке на складе смена единицы запрещена — остаток сначала нужно обнулить/пересчитать.
-- Разный вид (г ↔ шт, мл ↔ г) при ценах по-прежнему запрещён: без плотности не пересчитать.
-- Точность цены — 4 знака: цена за грамм у дешёвых продуктов (25 ₹/кг = 0,025 ₹/г).
-- =============================================================

alter table public.kitchen_prices alter column price type numeric(14,4);
alter table public.kitchen_price_corrections alter column old_price type numeric(14,4), alter column new_price type numeric(14,4);

create or replace function public.trg_products_unit_lock()
returns trigger language plpgsql security definer set search_path = public
as $function$
declare
  v_old units%rowtype; v_new units%rowtype; k numeric;
begin
  if new.unit is not distinct from old.unit then return new; end if;
  if not exists (select 1 from kitchen_prices where product_id = old.id) then return new; end if;
  select * into v_old from units where code = old.unit;
  select * into v_new from units where code = new.unit;

  if v_old.code is null or v_new.code is null or v_old.type <> v_new.type
     or coalesce(v_old.to_base_ratio, 0) = 0 or coalesce(v_new.to_base_ratio, 0) = 0 then
    raise exception 'Нельзя сменить единицу «%» → «%» у продукта «%»: разный вид единиц, цену не пересчитать. / Unit cannot be changed between different unit types.', old.unit, new.unit, old.name_ru
      using errcode = 'P0001';
  end if;
  if exists (select 1 from stock where product_id = old.id and coalesce(current_quantity, 0) <> 0) then
    raise exception 'Нельзя сменить единицу у продукта «%»: на складе есть остаток — сначала обнулите его инвентаризацией, затем смените единицу и внесите остаток заново. / Product has stock on hand.', old.name_ru
      using errcode = 'P0001';
  end if;

  k := v_old.to_base_ratio / v_new.to_base_ratio;   -- кг → г: 1000
  insert into kitchen_price_corrections (price_id, old_price, new_price, reason, corrected_by)
  select id, price, round(price / k, 4),
         format('Смена единицы продукта %s → %s: цена пересчитана (та же цена за %s)', old.unit, new.unit, new.unit), auth.uid()
    from kitchen_prices where product_id = old.id;
  update kitchen_prices set price = round(price / k, 4) where product_id = old.id;
  return new;
end;
$function$;
