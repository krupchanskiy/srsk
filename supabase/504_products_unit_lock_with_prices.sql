-- Запрет менять закупочную единицу продукта, если по нему уже есть цены.
-- Цена в kitchen_prices хранится «за единицу продукта» (₹ за кг, ₹ за шт) —
-- смена единицы оставила бы число, но поменяла бы его смысл.
-- Чтобы сменить единицу, сначала нужно убрать цены продукта.

create or replace function public.trg_products_unit_lock()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.unit is distinct from old.unit
       and exists (select 1 from kitchen_prices where product_id = old.id) then
        raise exception 'Нельзя сменить единицу измерения: по продукту «%» уже введены цены. / Unit cannot be changed: product already has prices.', old.name_ru
            using errcode = 'P0001';
    end if;
    return new;
end;
$$;

drop trigger if exists products_unit_lock_trg on public.products;
create trigger products_unit_lock_trg
    before update of unit on public.products
    for each row execute function public.trg_products_unit_lock();
