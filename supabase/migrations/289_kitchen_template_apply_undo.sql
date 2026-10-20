-- 289: «Применить шаблон» меню — одной транзакцией и с отменой.
--
-- 20.10.2026 шаблон применили не с той даты: окно подставляло сегодняшнее
-- число, и завтраки с обедами на шесть дней молча заменились. Вернули из
-- резервной копии через временный проект. Чтобы так больше не было:
--   • применение — одна функция: всё или ничего, а заменённое меню
--     (приёмы, блюда, «готовое со стороны», снимки рецептов) сохраняется
--     в журнал menu_template_applies;
--   • сутки после применения его можно отменить: меню возвращается
--     ровно таким, каким было до шаблона.

create table if not exists menu_template_applies (
    id            uuid primary key default gen_random_uuid(),
    location_id   uuid not null,
    template_id   uuid,
    template_name text,
    date_from     date not null,
    date_to       date not null,
    slots         jsonb not null,          -- [{date, meal_type}] — что заменял шаблон
    backup        jsonb not null,          -- {meals, dishes, ext, snaps} до применения
    replaced      integer not null default 0,
    created_by    uuid default auth.uid(),
    created_at    timestamptz not null default now(),
    undone_at     timestamptz,
    undone_by     uuid
);
create index if not exists menu_template_applies_loc on menu_template_applies (location_id, created_at desc);

alter table menu_template_applies enable row level security;
drop policy if exists "menu template applies read" on menu_template_applies;
create policy "menu template applies read" on menu_template_applies for select to authenticated
    using (abk_current_user_has_permission('view_menu') and abk_current_user_can_access_location(location_id));
-- пишут только функции ниже

-- ---- применить шаблон ----
-- p_portions: {"2026-10-20|lunch": 235, …} — порции считает страница
-- (по вкушающим), как и раньше; нет ключа — порции из шаблона.
create or replace function kitchen_apply_template(p_location uuid, p_template uuid, p_start date,
                                                  p_portions jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
    v_шаблон  menu_templates%rowtype;
    v_слоты   jsonb;
    v_старые  uuid[];
    v_копия   jsonb;
    v_id      uuid;
    v_новых   integer := 0;
    v_блюд    integer := 0;
    v_заменено integer;
    r         record;
    v_приём   uuid;
begin
    if not abk_current_user_has_permission('edit_menu') or not abk_current_user_can_access_location(p_location) then
        raise exception 'Нет права менять меню этой кухни' using errcode = '42501';
    end if;
    if p_start is null then raise exception 'Не выбрана начальная дата'; end if;

    select * into v_шаблон from menu_templates where id = p_template;
    if not found then raise exception 'Шаблон не найден'; end if;

    -- какие приёмы пищи заменит шаблон: только те, что в нём есть
    select coalesce(jsonb_agg(distinct jsonb_build_object('date', p_start + tm.day_number - 1,
                                                            'meal_type', tm.meal_type)), '[]'::jsonb)
      into v_слоты
      from menu_template_meals tm
     where tm.template_id = p_template and tm.day_number between 1 and v_шаблон.day_count;

    select coalesce(array_agg(m.id), '{}') into v_старые
      from menu_meals m
     where m.location_id = p_location
       and exists (select 1 from jsonb_array_elements(v_слоты) s
                    where (s->>'date')::date = m.date and s->>'meal_type' = m.meal_type);

    -- копия того, что будет заменено: каскад удалит блюда, «готовое» и снимки
    v_копия := jsonb_build_object(
        'meals',  coalesce((select jsonb_agg(to_jsonb(m)) from menu_meals m where m.id = any(v_старые)), '[]'::jsonb),
        'dishes', coalesce((select jsonb_agg(to_jsonb(d)) from menu_dishes d where d.meal_id = any(v_старые)), '[]'::jsonb),
        'ext',    coalesce((select jsonb_agg(to_jsonb(x)) from menu_external_items x where x.meal_id = any(v_старые)), '[]'::jsonb),
        'snaps',  coalesce((select jsonb_agg(to_jsonb(s)) from menu_dish_recipe_snapshots s
                             join menu_dishes d on d.id = s.menu_dish_id where d.meal_id = any(v_старые)), '[]'::jsonb));
    v_заменено := cardinality(v_старые);

    delete from menu_meals where id = any(v_старые);

    for r in
        select tm.*, p_start + tm.day_number - 1 as день
          from menu_template_meals tm
         where tm.template_id = p_template and tm.day_number between 1 and v_шаблон.day_count
         order by tm.day_number, tm.meal_type
    loop
        insert into menu_meals (location_id, date, meal_type, portions, cook_id)
        values (p_location, r.день, r.meal_type,
                coalesce((p_portions->>(r.день::text || '|' || r.meal_type))::integer, r.portions, 50), null)
        returning id into v_приём;
        v_новых := v_новых + 1;

        insert into menu_dishes (meal_id, recipe_id, portion_size, portion_unit, sort_order)
        select v_приём, td.recipe_id, td.portion_size, td.portion_unit,
               (row_number() over (order by td.sort_order, td.created_at)) - 1
          from menu_template_dishes td where td.template_meal_id = r.id;
        v_блюд := v_блюд + (select count(*) from menu_template_dishes where template_meal_id = r.id);
    end loop;

    insert into menu_template_applies (location_id, template_id, template_name, date_from, date_to,
                                       slots, backup, replaced)
    values (p_location, p_template, v_шаблон.name_ru, p_start, p_start + v_шаблон.day_count - 1,
            v_слоты, v_копия, v_заменено)
    returning id into v_id;

    -- журнал не копится вечно: отменить можно сутки, неделя — с запасом
    delete from menu_template_applies where created_at < now() - interval '7 days';

    return jsonb_build_object('ok', true, 'apply_id', v_id, 'заменено', v_заменено,
                              'приёмов', v_новых, 'блюд', v_блюд);
end $$;
revoke all on function kitchen_apply_template(uuid, uuid, date, jsonb) from public, anon;
grant execute on function kitchen_apply_template(uuid, uuid, date, jsonb) to authenticated;

-- ---- отменить применение: меню как до шаблона ----
create or replace function kitchen_undo_template(p_apply uuid)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
    v_запись menu_template_applies%rowtype;
    v_убрано integer;
begin
    select * into v_запись from menu_template_applies where id = p_apply for update;
    if not found then raise exception 'Применение шаблона не найдено'; end if;
    if not abk_current_user_has_permission('edit_menu') or not abk_current_user_can_access_location(v_запись.location_id) then
        raise exception 'Нет права менять меню этой кухни' using errcode = '42501';
    end if;
    if v_запись.undone_at is not null then raise exception 'Это применение уже отменено'; end if;
    if v_запись.created_at < now() - interval '24 hours' then
        raise exception 'Прошло больше суток — отменить применение уже нельзя';
    end if;

    -- всё, что сейчас стоит в этих приёмах пищи (шаблон и правки после него)
    delete from menu_meals m
     where m.location_id = v_запись.location_id
       and exists (select 1 from jsonb_array_elements(v_запись.slots) s
                    where (s->>'date')::date = m.date and s->>'meal_type' = m.meal_type);
    get diagnostics v_убрано = row_count;

    insert into menu_meals select * from jsonb_populate_recordset(null::menu_meals, v_запись.backup->'meals');
    insert into menu_dishes select * from jsonb_populate_recordset(null::menu_dishes, v_запись.backup->'dishes');
    insert into menu_external_items select * from jsonb_populate_recordset(null::menu_external_items, v_запись.backup->'ext');
    insert into menu_dish_recipe_snapshots select * from jsonb_populate_recordset(null::menu_dish_recipe_snapshots, v_запись.backup->'snaps');

    update menu_template_applies set undone_at = now(), undone_by = auth.uid() where id = p_apply;

    return jsonb_build_object('ok', true, 'убрано', v_убрано,
                              'возвращено', jsonb_array_length(v_запись.backup->'meals'));
end $$;
revoke all on function kitchen_undo_template(uuid) from public, anon;
grant execute on function kitchen_undo_template(uuid) to authenticated;
