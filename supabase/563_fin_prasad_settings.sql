-- =============================================================
-- Как считаем прасад ретрита (решение ВГ 27.09.2026).
-- Обычный ретрит — полная себестоимость. Внутренний (например, Ретрит Художников) —
-- в стоимость ретрита входят только отмеченные составляющие; ничего не отмечено —
-- питание в стоимость ретрита не входит. Составляющие:
--   food (продукты по меню, «Готовил Бридж Кишор»), dish (одноразовая посуда),
--   ext (готовое со стороны), payroll (зарплаты кухни), equipment (оборудование и инвентарь),
--   utilities (электричество, вода, газ), household (хозтовары и прочее),
--   retreat (гонорары, билеты, такси, «Программа» этого ретрита).
-- Меняет администратор финансов; видят те, кто видит себестоимость, и финансисты.
-- =============================================================

create table if not exists public.fin_prasad_settings (
  retreat_id   uuid primary key references public.retreats(id) on delete cascade,
  is_internal  boolean not null default false,
  components   text[] not null default array['food','dish','ext','payroll','equipment','utilities','household','retreat'],
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid(),
  constraint fin_prasad_settings_components_check check (
    components <@ array['food','dish','ext','payroll','equipment','utilities','household','retreat'])
);
alter table public.fin_prasad_settings enable row level security;
revoke all on public.fin_prasad_settings from anon, authenticated;

create or replace function public.fin_get_prasad_settings(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare v jsonb;
begin
  if not (fin_kitchen_can_view() or fin_can_read_all()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  select jsonb_build_object('is_internal', s.is_internal, 'components', to_jsonb(s.components), 'updated_at', s.updated_at)
    into v from fin_prasad_settings s where s.retreat_id = p_retreat;
  return coalesce(v, jsonb_build_object('is_internal', false,
    'components', to_jsonb(array['food','dish','ext','payroll','equipment','utilities','household','retreat'])));
end;
$function$;

create or replace function public.fin_set_prasad_settings(p_retreat uuid, p_is_internal boolean, p_components text[])
returns void language plpgsql security definer set search_path = public
as $function$
begin
  if not fin_is_admin(auth.uid()) then
    raise exception 'forbidden' using detail = 'Менять может только администратор финансов';
  end if;
  insert into fin_prasad_settings (retreat_id, is_internal, components, updated_at, updated_by)
  values (p_retreat, coalesce(p_is_internal, false), coalesce(p_components, '{}'), now(), auth.uid())
  on conflict (retreat_id) do update
     set is_internal = excluded.is_internal, components = excluded.components, updated_at = now(), updated_by = auth.uid();
end;
$function$;

revoke all on function public.fin_get_prasad_settings(uuid) from public, anon;
revoke all on function public.fin_set_prasad_settings(uuid, boolean, text[]) from public, anon;
grant execute on function public.fin_get_prasad_settings(uuid) to authenticated;
grant execute on function public.fin_set_prasad_settings(uuid, boolean, text[]) to authenticated;
