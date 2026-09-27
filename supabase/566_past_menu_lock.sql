-- =============================================================
-- Меню прошедших дней закрыто от правки (решение ВГ 27.09.2026).
-- Прошедший день (по времени Индии) можно заполнить и поправить в тот же день,
-- когда его заполняли: внесли вчерашнее меню сегодня — сегодня его ещё можно исправить.
-- Со следующего дня менять, удалять и добавлять в такой день можно только с правом
-- «Правка прошлого меню» (edit_past_menu, строгое, без обхода для суперпользователей).
-- Пустой прошедший приём пищи заполнить может любой, кто правит меню.
-- Защита в базе: действует для Меню, Планировщика и любых других путей.
-- =============================================================

insert into permissions (code, name_ru, name_en, name_hi, category, sort_order)
values ('edit_past_menu', 'Правка прошлого меню', 'Edit past menu', 'पिछला मेनू संपादित करें', 'kitchen', 0)
on conflict (code) do nothing;

-- Выдано поимённо: Сундара Рупа дас (глава кухни) и Ванамали Гопал дас
insert into user_permissions (user_id, permission_id, is_granted, reason)
select v.user_id, p.id, true, 'Правка прошлого меню — решение ВГ 27.09.2026'
  from vaishnavas v cross join permissions p
 where p.code = 'edit_past_menu'
   and (v.id = '70e8f35c-f1a9-40fe-b510-93e6ad05a52e'            -- Сундара Рупа дас
        or v.user_id = '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746')   -- Ванамали Гопал дас
   and v.user_id is not null
   and not exists (select 1 from user_permissions up where up.user_id = v.user_id and up.permission_id = p.id);

-- Можно ли сейчас менять приём пищи p_meal (строка, созданная в p_row_created, или новая — null)
create or replace function public.kitchen_past_menu_allowed(p_meal uuid, p_row_created timestamptz)
returns boolean language plpgsql stable security definer set search_path = public
as $function$
declare v_date date; v_today date := kitchen_today();
begin
  select date into v_date from menu_meals where id = p_meal;
  if v_date is null or v_date >= v_today then return true; end if;         -- сегодня и будущее — свободно
  if auth.uid() is null then return true; end if;                          -- служебные операции базы
  if kitchen_has_permission(auth.uid(), 'edit_past_menu') then return true; end if;
  if p_row_created is not null then                                        -- правка/удаление строки
    return (p_row_created at time zone 'Asia/Kolkata')::date = v_today;    -- только внесённой сегодня
  end if;
  -- добавление: только пока всё содержимое приёма внесено сегодня (или его нет — пустой приём)
  return not exists (select 1 from menu_dishes d where d.meal_id = p_meal and (d.created_at at time zone 'Asia/Kolkata')::date < v_today)
     and not exists (select 1 from menu_external_items x where x.meal_id = p_meal and (x.created_at at time zone 'Asia/Kolkata')::date < v_today);
end;
$function$;

create or replace function public.kitchen_trg_past_menu_rows()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if tg_op in ('UPDATE', 'DELETE') and not kitchen_past_menu_allowed(old.meal_id, old.created_at) then
    raise exception 'past_menu_locked' using detail = 'Меню прошедшего дня закрыто: менять его можно только с правом «Правка прошлого меню». Пустой прошедший приём пищи заполнить можно.';
  end if;
  if tg_op = 'INSERT' and not kitchen_past_menu_allowed(new.meal_id, null) then
    raise exception 'past_menu_locked' using detail = 'Меню прошедшего дня закрыто: добавлять в него можно только с правом «Правка прошлого меню». Пустой прошедший приём пищи заполнить можно.';
  end if;
  if tg_op = 'UPDATE' and new.meal_id is distinct from old.meal_id and not kitchen_past_menu_allowed(new.meal_id, null) then
    raise exception 'past_menu_locked' using detail = 'Меню прошедшего дня закрыто.';
  end if;
  return coalesce(new, old);
end;
$function$;

-- Сам приём пищи (порции, повар, удаление): как строка, внесённая тогда же, когда его содержимое
create or replace function public.kitchen_trg_past_menu_meal()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if tg_op = 'UPDATE' and (new.portions, new.cook_id, new.notes, new.date, new.meal_type)
                          is not distinct from (old.portions, old.cook_id, old.notes, old.date, old.meal_type) then
    return new;                                                            -- служебное (updated_at)
  end if;
  if old.date < kitchen_today() and auth.uid() is not null
     and not kitchen_has_permission(auth.uid(), 'edit_past_menu')
     and (old.created_at at time zone 'Asia/Kolkata')::date < kitchen_today()
     and not kitchen_past_menu_allowed(old.id, null) then
    raise exception 'past_menu_locked' using detail = 'Меню прошедшего дня закрыто: менять его можно только с правом «Правка прошлого меню».';
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists kitchen_past_menu_dishes on public.menu_dishes;
create trigger kitchen_past_menu_dishes before insert or update or delete on public.menu_dishes
  for each row execute function public.kitchen_trg_past_menu_rows();
drop trigger if exists kitchen_past_menu_external on public.menu_external_items;
create trigger kitchen_past_menu_external before insert or update or delete on public.menu_external_items
  for each row execute function public.kitchen_trg_past_menu_rows();
drop trigger if exists kitchen_past_menu_meal on public.menu_meals;
create trigger kitchen_past_menu_meal before update or delete on public.menu_meals
  for each row execute function public.kitchen_trg_past_menu_meal();
