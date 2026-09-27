-- =============================================================
-- Прошлое меню не меняется от правки рецептов (решение ВГ 27.09.2026).
-- «Копия при изменении»: перед любой правкой рецепта (ингредиенты, выход, порция)
-- его текущий состав сохраняется за всеми блюдами меню ПРОШЕДШИХ дней, где он был.
-- Себестоимость прошедшего дня считается по снимку, будущие — по рецепту как есть.
-- Удалить рецепт, который уже был в меню прошедших дней, нельзя (иначе каскадом
-- пропали бы блюда из прошлого меню). «Прошедший день» — по времени Индии.
-- Сразу фиксируем нынешние рецепты за всеми прошедшими днями.
-- =============================================================

create table if not exists public.menu_dish_recipe_snapshots (
  menu_dish_id    uuid primary key references public.menu_dishes(id) on delete cascade,
  recipe_id       uuid not null,
  output_amount   numeric,
  output_unit     text,
  portion_amount  numeric,
  ingredients     jsonb not null,        -- [{product_id, amount, unit}]
  taken_at        timestamptz not null default now()
);
alter table public.menu_dish_recipe_snapshots enable row level security;
drop policy if exists menu_dish_recipe_snapshots_read on public.menu_dish_recipe_snapshots;
create policy menu_dish_recipe_snapshots_read on public.menu_dish_recipe_snapshots for select to authenticated using (true);
revoke insert, update, delete on public.menu_dish_recipe_snapshots from anon, authenticated;

create index if not exists menu_dishes_recipe_id_idx on public.menu_dishes(recipe_id);

create or replace function public.kitchen_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- Снимок рецепта за блюдами прошедших дней, у которых снимка ещё нет
create or replace function public.kitchen_private_snapshot_recipe(p_recipe uuid)
returns void language plpgsql security definer set search_path = public
as $function$
begin
  if p_recipe is null then return; end if;
  insert into menu_dish_recipe_snapshots (menu_dish_id, recipe_id, output_amount, output_unit, portion_amount, ingredients)
  select md.id, r.id, r.output_amount, r.output_unit, r.portion_amount,
         coalesce((select jsonb_agg(jsonb_build_object('product_id', ri.product_id, 'amount', ri.amount, 'unit', ri.unit) order by ri.sort_order, ri.id)
                     from recipe_ingredients ri where ri.recipe_id = r.id), '[]'::jsonb)
    from menu_dishes md
    join menu_meals mm on mm.id = md.meal_id
    join recipes r on r.id = md.recipe_id
   where md.recipe_id = p_recipe
     and mm.date < kitchen_today()
     and not exists (select 1 from menu_dish_recipe_snapshots s where s.menu_dish_id = md.id);
end;
$function$;
revoke all on function public.kitchen_private_snapshot_recipe(uuid) from public, anon, authenticated;

create or replace function public.kitchen_trg_ingredients_snapshot()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform kitchen_private_snapshot_recipe(old.recipe_id); end if;
  if tg_op in ('INSERT', 'UPDATE') then perform kitchen_private_snapshot_recipe(new.recipe_id); end if;
  return coalesce(new, old);
end;
$function$;

create or replace function public.kitchen_trg_recipe_snapshot()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from menu_dishes md join menu_meals mm on mm.id = md.meal_id
                where md.recipe_id = old.id and mm.date < kitchen_today()) then
      raise exception 'recipe_in_past_menu'
        using detail = 'Рецепт уже был в меню прошедших дней — удалить его нельзя, иначе изменится прошлое меню и себестоимость. Переименуйте его или уберите из будущих меню.';
    end if;
    return old;
  end if;
  if (new.output_amount, new.output_unit, new.portion_amount) is distinct from (old.output_amount, old.output_unit, old.portion_amount) then
    perform kitchen_private_snapshot_recipe(old.id);
  end if;
  return new;
end;
$function$;

drop trigger if exists kitchen_ingredients_snapshot on public.recipe_ingredients;
create trigger kitchen_ingredients_snapshot before insert or update or delete on public.recipe_ingredients
  for each row execute function public.kitchen_trg_ingredients_snapshot();

drop trigger if exists kitchen_recipe_snapshot on public.recipes;
create trigger kitchen_recipe_snapshot before update or delete on public.recipes
  for each row execute function public.kitchen_trg_recipe_snapshot();

-- Для расчёта: снимки с датой и локацией приёма пищи (выборка по периоду, без длинных списков id)
create or replace view public.kitchen_v_dish_snapshots with (security_invoker = true) as
select s.menu_dish_id, s.recipe_id, s.output_amount, s.output_unit, s.portion_amount, s.ingredients, mm.date, mm.location_id
  from menu_dish_recipe_snapshots s
  join menu_dishes md on md.id = s.menu_dish_id
  join menu_meals mm on mm.id = md.meal_id;
grant select on public.kitchen_v_dish_snapshots to authenticated;

-- Зафиксировать нынешние рецепты за всеми прошедшими днями
select public.kitchen_private_snapshot_recipe(r.id) from public.recipes r
 where exists (select 1 from public.menu_dishes md where md.recipe_id = r.id);
