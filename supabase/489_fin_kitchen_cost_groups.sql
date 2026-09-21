-- =============================================================
-- Основа в финансах для учёта затрат кухни (этап 4, ТЗ п. 3.6):
--   * fin_cost_groups — «статья → группа» (direct / retreat / general /
--     excluded). Нет строки = группа не подтверждена, считается «общей»;
--   * fin_posting_destinations — назначение расхода группы «На ретрит»,
--     если он не привязан к ретриту через объект учёта: 'period' (период
--     работы, например билет повара) или 'general' (общие расходы кухни);
--   * функции для экрана «Кухня → Себестоимость»: расходы без назначения,
--     подтверждение группы статьи, выбор назначения.
--
-- Ядро финансов (создание расходов, fin_update_posting_analytics, проверки
-- целостности, закрытия) не меняется: всё новое хранится отдельно.
-- Право менять: администратор финансов или держатель edit_prices (кухня).
-- =============================================================

-- ---------- группы статей ----------
create table public.fin_cost_groups (
  category_id uuid primary key references public.fin_categories(id) on delete cascade,
  cost_group text not null check (cost_group in ('direct', 'retreat', 'general', 'excluded')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.fin_cost_groups enable row level security;
revoke all on public.fin_cost_groups from anon;

create or replace function public.fin_kitchen_can_manage()
returns boolean language sql stable security definer set search_path = public
as $$ select fin_is_admin() or kitchen_has_permission(auth.uid(), 'edit_prices') $$;

create or replace function public.fin_kitchen_can_view()
returns boolean language sql stable security definer set search_path = public
as $$
  select fin_kitchen_can_manage() or fin_can_read_all()
      or kitchen_has_permission(auth.uid(), 'view_prices')
      or kitchen_has_permission(auth.uid(), 'edit_archived_prices')
$$;
revoke all on function public.fin_kitchen_can_manage() from public, anon;
revoke all on function public.fin_kitchen_can_view() from public, anon;
grant execute on function public.fin_kitchen_can_manage() to authenticated;
grant execute on function public.fin_kitchen_can_view() to authenticated;

create policy "Cost groups read" on public.fin_cost_groups
  for select to authenticated using (fin_kitchen_can_view());

-- начальная раскладка статей кухни из ТЗ (п. 3.6, таблица «Классификация»)
insert into public.fin_cost_groups (category_id, cost_group)
select c.id, g.grp
from fin_categories c
join (values
  ('dept_food', 'direct'), ('disposable_tableware', 'direct'), ('prasad_order', 'direct'), ('strategic_stock', 'direct'),
  ('tickets', 'retreat'), ('visa', 'retreat'), ('taxi', 'retreat'), ('program', 'retreat'),
  ('retreat_fee', 'retreat'), ('lecture_fee', 'retreat'),
  ('dept_labor', 'general'), ('dept_utilities', 'general'), ('cleaning', 'general'), ('dept_household', 'general'),
  ('kitchen_utensils', 'general'), ('fuel', 'general'), ('dept_transport', 'general'), ('delivery', 'general'),
  ('dept_other', 'general'), ('equipment', 'general'), ('dept_repair', 'general')
) as g(code, grp) on g.code = c.code
on conflict (category_id) do nothing;

create or replace function public.fin_set_cost_group(p_category_id uuid, p_group text)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_manage() then
    raise exception 'forbidden' using detail = 'Нет права менять группу статьи';
  end if;
  if not exists (select 1 from fin_categories where id = p_category_id and direction::text = 'out') then
    raise exception 'invalid_payload' using detail = 'Статья расхода не найдена';
  end if;
  if p_group is null or btrim(p_group) = '' then
    delete from fin_cost_groups where category_id = p_category_id;
    return;
  end if;
  if p_group not in ('direct', 'retreat', 'general', 'excluded') then
    raise exception 'invalid_payload' using detail = 'Неизвестная группа статьи';
  end if;
  insert into fin_cost_groups (category_id, cost_group) values (p_category_id, p_group)
  on conflict (category_id) do update set cost_group = excluded.cost_group, updated_at = now(), updated_by = auth.uid();
end;
$$;

-- ---------- назначение расхода (период / общие) ----------
create table public.fin_posting_destinations (
  posting_id uuid primary key references public.fin_postings(id) on delete cascade,
  mode text not null check (mode in ('period', 'general')),
  period_from date,
  period_to date,
  set_by uuid default auth.uid(),
  set_at timestamptz not null default now(),
  constraint fin_posting_destinations_ck check (
    (mode = 'period' and period_from is not null and period_to is not null and period_from <= period_to)
    or (mode = 'general' and period_from is null and period_to is null))
);

alter table public.fin_posting_destinations enable row level security;
revoke all on public.fin_posting_destinations from anon;
create policy "Posting destinations read" on public.fin_posting_destinations
  for select to authenticated using (fin_kitchen_can_view());

create or replace function public.fin_set_posting_destination(
  p_posting_id uuid, p_mode text, p_from date default null, p_to date default null
) returns void language plpgsql security definer set search_path = public
as $$
declare
  v record;
begin
  if not fin_kitchen_can_manage() then
    raise exception 'forbidden' using detail = 'Нет права назначать расходы';
  end if;

  select p.direction::text dir, p.object_id, o.type::text op_type, o.is_reversed, d.name dept
    into v
    from fin_postings p
    join fin_operations o on o.id = p.operation_id
    join fin_accounts a on a.id = p.account_id
    left join fin_departments d on d.id = a.department_id
   where p.id = p_posting_id;
  if not found then
    raise exception 'invalid_payload' using detail = 'Проводка не найдена';
  end if;
  if v.dir <> 'out' or v.op_type <> 'expense' or v.is_reversed then
    raise exception 'invalid_payload' using detail = 'Назначение задаётся только для действующего расхода';
  end if;
  if not fin_is_admin() and v.dept is distinct from 'Кухня' then
    raise exception 'forbidden' using detail = 'Можно назначать только расходы кухни';
  end if;
  if v.object_id is not null then
    raise exception 'invalid_payload' using detail = 'Расход уже привязан к ретриту';
  end if;

  if p_mode is null or btrim(p_mode) = '' then
    delete from fin_posting_destinations where posting_id = p_posting_id;
  elsif p_mode = 'general' then
    insert into fin_posting_destinations (posting_id, mode) values (p_posting_id, 'general')
    on conflict (posting_id) do update set mode = 'general', period_from = null, period_to = null, set_by = auth.uid(), set_at = now();
  elsif p_mode = 'period' then
    if p_from is null or p_to is null or p_from > p_to then
      raise exception 'invalid_payload' using detail = 'Укажите период работы: дата приезда не позже даты выезда';
    end if;
    insert into fin_posting_destinations (posting_id, mode, period_from, period_to) values (p_posting_id, 'period', p_from, p_to)
    on conflict (posting_id) do update set mode = 'period', period_from = p_from, period_to = p_to, set_by = auth.uid(), set_at = now();
  else
    raise exception 'invalid_payload' using detail = 'Неизвестное назначение';
  end if;
end;
$$;

-- ---------- данные для экрана кухни ----------
-- Расходы кухни по статьям группы «На ретрит», у которых нет ни ретрита, ни назначения
create or replace function public.fin_kitchen_unassigned()
returns table (posting_id uuid, occurred_on date, category_name text, amount numeric, currency_code text, amount_base numeric, comment text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  return query
    select p.id, o.occurred_on, c.name, p.amount, p.currency_code, p.amount_base, o.comment
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
      join fin_categories c on c.id = p.category_id
      join fin_cost_groups g on g.category_id = c.id and g.cost_group = 'retreat'
     where p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
       and p.object_id is null
       and not exists (select 1 from fin_posting_destinations x where x.posting_id = p.id)
     order by o.occurred_on desc;
end;
$$;

-- Статьи, по которым есть расходы на счетах кухни, и их группа (нет группы = не подтверждена)
create or replace function public.fin_kitchen_cost_groups()
returns table (category_id uuid, code text, name text, cost_group text, postings bigint, total_base numeric)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  return query
    select c.id, c.code, c.name, g.cost_group, count(*), coalesce(sum(p.amount_base), 0)
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
      join fin_categories c on c.id = p.category_id
      left join fin_cost_groups g on g.category_id = c.id
     where p.direction::text = 'out' and not o.is_reversed
     group by c.id, c.code, c.name, g.cost_group
     order by g.cost_group is null desc, c.name;
end;
$$;

revoke all on function public.fin_set_cost_group(uuid, text) from public, anon;
revoke all on function public.fin_set_posting_destination(uuid, text, date, date) from public, anon;
revoke all on function public.fin_kitchen_unassigned() from public, anon;
revoke all on function public.fin_kitchen_cost_groups() from public, anon;
grant execute on function public.fin_set_cost_group(uuid, text) to authenticated;
grant execute on function public.fin_set_posting_destination(uuid, text, date, date) to authenticated;
grant execute on function public.fin_kitchen_unassigned() to authenticated;
grant execute on function public.fin_kitchen_cost_groups() to authenticated;
