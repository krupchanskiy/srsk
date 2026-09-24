-- Защита цен от смены единицы измерения: цена хранится в единице продукта (₹ за г / кг / л / шт),
-- и если единицу сменить после ввода цен, число останется прежним, а смысл станет другим.
-- Пока у продукта есть хоть одна цена (kitchen_prices), менять products.unit нельзя.
create or replace function public.products_lock_unit_when_priced()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.unit is distinct from old.unit
     and exists (select 1 from kitchen_prices where product_id = old.id) then
    raise exception 'Нельзя менять единицу измерения: у продукта уже введены цены, они станут неверными. Обратитесь к главе кухни или администратору.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger trg_products_lock_unit_when_priced
  before update of unit on public.products
  for each row execute function public.products_lock_unit_when_priced();
