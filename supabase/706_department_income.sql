-- 706: «Выручка» департамента (ВГ 18.10). Выручку магазина ВГ вносит приходом по статьям
-- «Касса Магазин» / «Мурти» на тот счёт, куда сдали деньги (Касса, Гест-хаус), — на счёт
-- департамента она не попадает, и «Счёт» её не видел. Поэтому у департамента свои статьи
-- ПРИХОДА, а выручка — приходы по ним с ЛЮБОГО счёта (как касса кухни, мигр. 541).
-- Человеку показываем суммы и название счёта поступления, но доступа к самому счёту не даём:
-- функция SECURITY DEFINER с проверкой «видит департамент».

create table if not exists fin_department_income_categories (
  department_id uuid not null references fin_departments(id) on delete cascade,
  category_id   uuid not null references fin_categories(id) on delete cascade,
  primary key (department_id, category_id)
);
alter table fin_department_income_categories enable row level security;
drop policy if exists fin_department_income_categories_select on fin_department_income_categories;
create policy fin_department_income_categories_select on fin_department_income_categories
  for select to authenticated using (fin_can_read_all());
revoke insert, update, delete on fin_department_income_categories from anon, authenticated;

-- начальные привязки: Магазин — касса, Мурти, пожертвования; Кафе — касса кафе
insert into fin_department_income_categories (department_id, category_id)
select d.id, c.id
  from fin_departments d
  join fin_categories c on (d.code = 'shop' and c.code in ('shop_cash', 'murti', 'shop_donation'))
                        or (d.code = 'cafe' and c.code = 'cafe_cash')
on conflict do nothing;

-- приходы по статьям департамента с любого счёта; сторно (расход по той же статье) — с минусом
create or replace function fin_department_income(p_department text, p_from date default null, p_to date default null)
returns table(operation_id uuid, occurred_on date, category_id uuid, category_name text,
              account_name text, currency_code text, amount numeric, amount_base numeric, comment text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_dept fin_departments%rowtype;
begin
  select * into v_dept from fin_departments d
   where d.code = p_department or d.name = p_department or d.id::text = p_department
   limit 1;
  if not found then return; end if;
  if not fin_can_read_all() and v_dept.id not in (select fin_user_department_ids()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    select o.id, o.occurred_on, c.id, c.name, a.name, p.currency_code,
           case when p.direction = 'in' then p.amount else -p.amount end,
           case when p.direction = 'in' then p.amount_base else -p.amount_base end,
           o.comment
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      join fin_department_income_categories dc on dc.category_id = p.category_id and dc.department_id = v_dept.id
     where o.type <> 'opening'
       and (p_from is null or o.occurred_on >= p_from)
       and (p_to is null or o.occurred_on <= p_to)
     order by o.occurred_on, o.id;
end;
$$;
revoke execute on function fin_department_income(text, date, date) from public, anon;
grant execute on function fin_department_income(text, date, date) to authenticated;

-- статьи прихода департамента правит только fin_admin (Справочники → Департаменты); набор заменяется целиком
create or replace function fin_save_department_income(p_department uuid, p_category_ids uuid[])
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not fin_is_admin() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  end if;
  if exists (select 1 from unnest(coalesce(p_category_ids, '{}')) x
              where not exists (select 1 from fin_categories c where c.id = x and c.direction = 'in')) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload', 'message', 'В наборе есть статья, которая не является статьёй прихода'));
  end if;
  delete from fin_department_income_categories
   where department_id = p_department and category_id <> all (coalesce(p_category_ids, '{}'));
  insert into fin_department_income_categories (department_id, category_id)
  select p_department, x from unnest(coalesce(p_category_ids, '{}')) x
  on conflict do nothing;
  return jsonb_build_object('ok', true, 'result', jsonb_build_object('id', p_department));
end;
$$;
revoke execute on function fin_save_department_income(uuid, uuid[]) from public, anon;
grant execute on function fin_save_department_income(uuid, uuid[]) to authenticated;
