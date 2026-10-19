-- 715: траты других департаментов, которые относятся и к этому департаменту (ВГ 19.10).
-- Мурти делает Мастерская, продаёт Магазин: траты на изготовление мурти должны быть видны
-- и в расходах Мастерской (там они и проведены), и в «Аналитике» Магазина — иначе Магазин
-- показывает выручку за мурти без затрат на них, и картина искажена.
-- Отмечаются траты объектом учёта (поле «Ретрит» в ДДС): «Мурти Госвами» — объект, который
-- модуль магазина уже ставит на выручку за мурти. Деньги не делятся и не переносятся: трата
-- остаётся у Мастерской, у Магазина она только показывается в аналитике.

create table if not exists fin_department_cost_objects (
  department_id uuid not null references fin_departments(id) on delete cascade,
  object_id     uuid not null references fin_accounting_objects(id) on delete cascade,
  primary key (department_id, object_id)
);
alter table fin_department_cost_objects enable row level security;
drop policy if exists fin_department_cost_objects_select on fin_department_cost_objects;
create policy fin_department_cost_objects_select on fin_department_cost_objects
  for select to authenticated using (fin_can_read_all());
revoke insert, update, delete on fin_department_cost_objects from anon, authenticated;

insert into fin_department_cost_objects (department_id, object_id)
select d.id, o.id from fin_departments d join fin_accounting_objects o on o.display_name = 'Мурти Госвами'
 where d.code = 'shop'
on conflict do nothing;

-- траты с ЧУЖИХ счетов по объектам департамента; доступ — тем, кто видит департамент
create or replace function fin_department_cost_extra(p_department text)
returns table(posting_id uuid, operation_id uuid, type text, is_reversed boolean, occurred_on date,
              account_name text, source_department text, currency_code text, signed_amount numeric,
              amount_base numeric, category_id uuid, category_name text, object_name text, comment text)
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
    select p.id, o.id, o.type::text, o.is_reversed, o.occurred_on, a.name, sd.name, p.currency_code,
           case when p.direction = 'in' then p.amount else -p.amount end,
           case when p.direction = 'in' then p.amount_base else -p.amount_base end,
           c.id, c.name, obj.display_name, o.comment
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id and c.direction = 'out'
      join fin_department_cost_objects dco on dco.object_id = p.object_id and dco.department_id = v_dept.id
      join fin_accounting_objects obj on obj.id = p.object_id
      left join fin_departments sd on sd.id = a.department_id
     where a.department_id is distinct from v_dept.id
       and o.type <> 'opening'
     order by o.occurred_on, p.ledger_seq;
end;
$$;
revoke execute on function fin_department_cost_extra(text) from public, anon;
grant execute on function fin_department_cost_extra(text) to authenticated;

insert into translations (key, ru, en, hi, context) values
('dacc_an_revenue', 'Выручка', 'Revenue', 'राजस्व', 'Аналитика департамента'),
('dacc_an_costs', 'Расходы', 'Costs', 'खर्च', 'Аналитика департамента'),
('dacc_an_result', 'Итог', 'Result', 'परिणाम', 'Аналитика департамента'),
('dacc_an_margin', 'от выручки', 'of revenue', 'राजस्व का', 'Аналитика департамента'),
('dacc_an_per_bucket', 'в среднем за', 'average per', 'औसत प्रति', 'Аналитика департамента'),
('dacc_an_from_other', 'траты других департаментов на', 'other departments'' spending on', 'अन्य विभागों का खर्च', 'Аналитика департамента'),
('dacc_an_base_hint', 'Все суммы — в рупиях по курсу дня операции, все валюты вместе; сторно не учитывается', 'All amounts in rupees at the operation day''s rate, all currencies together; reversals excluded', 'सभी राशियाँ संचालन के दिन की दर पर रुपये में, सभी मुद्राएँ एक साथ; रिवर्सल शामिल नहीं', 'Аналитика департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
