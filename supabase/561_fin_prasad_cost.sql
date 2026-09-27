-- =============================================================
-- Себестоимость прасада ретрита — в Финансах (решение ВГ 27.09.2026).
-- Считает кухонный движок (js/kitchen-cost.js) по фактическим датам ретрита,
-- результат сохраняется здесь: один расчёт для Себестоимости и Финансов,
-- при закрытии ретрита попадает в снимок (fin_private_build_snapshot → prasad_cost)
-- и фиксируется в PDF. Деньги и ДДС не трогаются: это расчёт, не проводка.
-- =============================================================

create table if not exists public.fin_prasad_cost (
  retreat_id   uuid primary key references public.retreats(id) on delete cascade,
  span_from    date not null,
  span_to      date not null,
  data         jsonb not null,          -- строки (участники / команда ретрита…), итог, пропуски
  provisional  boolean not null default true,
  computed_at  timestamptz not null default now(),
  computed_by  uuid default auth.uid()
);
alter table public.fin_prasad_cost enable row level security;   -- только через функции ниже
revoke all on public.fin_prasad_cost from anon, authenticated;

-- Сохранить расчёт (вызывает страница после пересчёта). Кто видит себестоимость — тот и сохраняет.
create or replace function public.fin_save_prasad_cost(p_retreat uuid, p_from date, p_to date, p_data jsonb, p_provisional boolean)
returns void language plpgsql security definer set search_path = public
as $function$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  insert into fin_prasad_cost (retreat_id, span_from, span_to, data, provisional, computed_at, computed_by)
  values (p_retreat, p_from, p_to, p_data, coalesce(p_provisional, true), now(), auth.uid())
  on conflict (retreat_id) do update
     set span_from = excluded.span_from, span_to = excluded.span_to, data = excluded.data,
         provisional = excluded.provisional, computed_at = now(), computed_by = auth.uid();
end;
$function$;

create or replace function public.fin_get_prasad_cost(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare v jsonb;
begin
  if not (fin_kitchen_can_view() or fin_can_read_all()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  select jsonb_build_object('span_from', c.span_from, 'span_to', c.span_to, 'data', c.data,
         'provisional', c.provisional, 'computed_at', c.computed_at)
    into v from fin_prasad_cost c where c.retreat_id = p_retreat;
  return v;
end;
$function$;

revoke all on function public.fin_save_prasad_cost(uuid, date, date, jsonb, boolean) from public, anon;
revoke all on function public.fin_get_prasad_cost(uuid) from public, anon;
grant execute on function public.fin_save_prasad_cost(uuid, date, date, jsonb, boolean) to authenticated;
grant execute on function public.fin_get_prasad_cost(uuid) to authenticated;

-- ---------- снимок закрытия: добавить prasad_cost (точечная замена, остальное не трогаем) ----------
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_private_build_snapshot';
  if position('''prasad_cost''' in v_def) > 0 then return; end if;   -- уже добавлено
  v_new := replace(v_def, '''cost_per_participant'', NULL',
    '''prasad_cost'', (SELECT jsonb_build_object(''span_from'', c.span_from, ''span_to'', c.span_to, ''data'', c.data, ''provisional'', c.provisional, ''computed_at'', c.computed_at) FROM fin_prasad_cost c WHERE c.retreat_id = v_obj.retreat_id), ''cost_per_participant'', NULL');
  if v_new = v_def then raise exception 'fin_private_build_snapshot: не найдено место для prasad_cost'; end if;
  execute v_new;
end $$;
