-- Периметр анонима, часть 3: справочники.
-- Структура зданий и комнат, продукты с ценами, рецепты — внутренние данные ашрама.
-- Публичными остаются переводы интерфейса (нужны на странице входа), открытые ретриты,
-- справочники услуг/валют (форма записи на ретрит) и раздел растений.
do $$
declare
  v_таблицы text[] := array[
    'building_types', 'buildings', 'floor_plans', 'holidays', 'locations',
    'price_history', 'product_categories', 'product_densities', 'products',
    'recipe_categories', 'recipes', 'resident_categories', 'room_types', 'rooms',
    'spiritual_teachers', 'units'
  ];
  r record;
begin
  for r in
    select tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = any(v_таблицы)
       and cmd = 'SELECT'
       and roles::text in ('{public}', '{anon}')
       and coalesce(qual, 'true') = 'true'
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
    execute format('create policy %I on public.%I for select to authenticated using (true)',
                   r.policyname, r.tablename);
  end loop;
end $$;
