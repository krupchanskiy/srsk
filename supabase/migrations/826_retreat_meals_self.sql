-- 826: переключатель ретрита «Группа питается самостоятельно» (ВГ 22.11.2026, свадьбы).
-- Включён — у всех людей и мест ретрита питание «сам»: residents.has_meals = false,
-- регистрации meal_type = 'self'. Кухня их не считает, прасад не начисляется.
-- Новые места и регистрации этого ретрита получают то же автоматически.
-- Выключен — всем возвращается прасад.

alter table public.retreats
  add column if not exists meals_self boolean not null default false;

comment on column public.retreats.meals_self is
  'Группа питается самостоятельно: всем людям ретрита питание «сам» (826)';

-- Переключили у ретрита — разнести на людей
create or replace function public.retreat_meals_self_apply()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.meals_self is not distinct from old.meals_self then return new; end if;
  if new.meals_self then
    update retreat_registrations set meal_type = 'self'
     where retreat_id = new.id and coalesce(is_deleted, false) = false
       and (meal_type in ('prasad', 'child') or meal_type is null);
    update residents set has_meals = false
     where retreat_id = new.id and has_meals is distinct from false;
  else
    update retreat_registrations set meal_type = 'prasad'
     where retreat_id = new.id and coalesce(is_deleted, false) = false and meal_type = 'self';
    update residents set has_meals = true
     where retreat_id = new.id and has_meals = false;
  end if;
  return new;
end $$;

drop trigger if exists trg_retreat_meals_self on public.retreats;
create trigger trg_retreat_meals_self after update of meals_self on public.retreats
  for each row execute function public.retreat_meals_self_apply();

-- Новое/перенесённое место в таком ретрите — без питания
create or replace function public.residents_meals_self_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.retreat_id is not null
     and exists (select 1 from retreats where id = new.retreat_id and meals_self) then
    new.has_meals := false;
  end if;
  return new;
end $$;

drop trigger if exists trg_residents_meals_self on public.residents;
create trigger trg_residents_meals_self before insert or update of retreat_id, has_meals on public.residents
  for each row execute function public.residents_meals_self_guard();

-- Регистрация в таком ретрите — питание «сам»
create or replace function public.registrations_meals_self_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.meal_type in ('prasad', 'child') or new.meal_type is null)
     and exists (select 1 from retreats where id = new.retreat_id and meals_self) then
    new.meal_type := 'self';
  end if;
  return new;
end $$;

drop trigger if exists trg_registrations_meals_self on public.retreat_registrations;
create trigger trg_registrations_meals_self before insert or update of retreat_id, meal_type on public.retreat_registrations
  for each row execute function public.registrations_meals_self_guard();
