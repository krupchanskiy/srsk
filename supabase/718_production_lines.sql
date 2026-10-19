-- 718: производственные линии и аналитика департамента одной функцией (ВГ 19.10).
-- Мастерская производит, Магазин продаёт; ВСЕ продажи мурти — через Магазин.
-- Линия = продукт: кто производит, кто продаёт, статья выручки, объект учёта.
-- Себестоимость линии видна взаимно: у производителя (его траты) и у продавца (показ, деньги
-- не переносятся). Сейчас одна линия — «Мурти»: ВСЕ траты Мастерской, кроме трат на ретриты,
-- — себестоимость мурти. Когда у производителя линий станет несколько, в линию идут только
-- траты с её объектом; как делить общие расходы (зп, электричество) — решим тогда
-- (предложение: доля в % у линии).
-- Траты на ретриты (объект типа «ретрит») — затраты ретрита, в расходы департамента не входят:
-- показываются отдельно.
-- Заменяет fin_department_cost_objects / fin_department_cost_extra (мигр. 715).

create table if not exists fin_production_lines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  producer_department_id uuid not null references fin_departments(id),
  seller_department_id uuid references fin_departments(id),
  revenue_category_id uuid references fin_categories(id),
  object_id uuid references fin_accounting_objects(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table fin_production_lines is 'Производственные линии: что делает департамент и кто это продаёт (Мурти: Мастерская → Магазин)';
alter table fin_production_lines enable row level security;
drop policy if exists fin_production_lines_select on fin_production_lines;
create policy fin_production_lines_select on fin_production_lines for select to authenticated using (true);
revoke insert, update, delete on fin_production_lines from anon, authenticated;

insert into fin_production_lines (name, producer_department_id, seller_department_id, revenue_category_id, object_id)
select 'Мурти', pd.id, sd.id, c.id, o.id
  from fin_departments pd, fin_departments sd, fin_categories c, fin_accounting_objects o
 where pd.name = 'Мастерская' and sd.code = 'shop' and c.code = 'murti' and o.display_name = 'Мурти Госвами'
   and not exists (select 1 from fin_production_lines l where l.name = 'Мурти');

drop function if exists fin_department_cost_extra(text);
drop table if exists fin_department_cost_objects;

-- выручка: статьи департамента + статьи выручки его производственных линий
drop function if exists fin_department_income(text, date, date);
create or replace function fin_department_income(p_department text, p_from date default null, p_to date default null)
returns table(posting_id uuid, operation_id uuid, type text, approval text, is_reversed boolean,
              occurred_on date, created_at timestamptz, account_id uuid, account_name text,
              currency_code text, direction text, amount numeric, signed_amount numeric, amount_base numeric,
              category_id uuid, category_name text, object_name text, comment text, note text, cafe_point text)
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
    select p.id, o.id, o.type::text, o.approval::text, o.is_reversed, o.occurred_on, o.created_at,
           a.id, a.name, p.currency_code, p.direction::text, p.amount,
           case when p.direction = 'in' then p.amount else -p.amount end,
           p.amount_base, c.id, c.name, obj.display_name, o.comment, p.note, p.cafe_point::text
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      left join fin_accounting_objects obj on obj.id = p.object_id
     where o.type <> 'opening'
       and (p.category_id in (select dc.category_id from fin_department_income_categories dc where dc.department_id = v_dept.id)
            or p.category_id in (select l.revenue_category_id from fin_production_lines l
                                  where l.is_active and l.producer_department_id = v_dept.id))
       and (p_from is null or o.occurred_on >= p_from)
       and (p_to is null or o.occurred_on <= p_to)
     order by o.occurred_on, p.ledger_seq;
end;
$$;
revoke execute on function fin_department_income(text, date, date) from public, anon;
grant execute on function fin_department_income(text, date, date) to authenticated;

-- аналитика департамента: все строки выручки и расходов с правилами (ВГ 19.10)
--   kind = 'revenue' | 'cost' | 'retreat' (трата на ретрит — не в итоге)
--   line — производственная линия строки; source — чей это расход, если не свой
create or replace function fin_department_analytics(p_department text)
returns table(kind text, line text, source text, posting_id uuid, operation_id uuid, type text, is_reversed boolean,
              occurred_on date, account_name text, currency_code text, signed_amount numeric, amount_base numeric,
              category_id uuid, category_name text, object_name text, comment text, note text, cafe_point text)
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
  with lines as (
    select l.*, (select count(*) from fin_production_lines l2
                  where l2.is_active and l2.producer_department_id = l.producer_department_id) as producer_lines
      from fin_production_lines l where l.is_active
  ),
  base as (
    select p.id pid, o.id oid, o.type::text otype, o.is_reversed rev, o.occurred_on d, a.name acc, a.department_id adept,
           p.currency_code cur, case when p.direction = 'in' then p.amount else -p.amount end s,
           case when p.direction = 'in' then p.amount_base else -p.amount_base end sb,
           c.id cid, c.name cname, c.direction cdir, obj.display_name oname, obj.type::text otypeobj, p.object_id obid,
           o.comment cmt, p.note nt, p.cafe_point::text cp, p.is_transit tr
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      left join fin_accounting_objects obj on obj.id = p.object_id
     where o.type not in ('opening', 'transfer')
  ),
  -- траты производителя, которые относятся к линии: при одной линии — все, кроме ретритов;
  -- при нескольких — только с объектом линии; с объектом линии — с любого счёта
  line_costs as (
    select b.*, l.name lname, l.producer_department_id prod, l.seller_department_id sell
      from base b join lines l on true
     where b.cdir = 'out' and not b.tr and coalesce(b.otypeobj, '') <> 'retreat'
       and ((b.adept = l.producer_department_id and (l.producer_lines = 1 or b.obid = l.object_id))
            or (b.obid = l.object_id and b.adept is distinct from l.producer_department_id))
  )
  -- выручка
  select 'revenue'::text, l.name, null::text, b.pid, b.oid, b.otype, b.rev, b.d, b.acc, b.cur, b.s, b.sb,
         b.cid, b.cname, b.oname, b.cmt, b.nt, b.cp
    from base b
    left join lines l on l.revenue_category_id = b.cid and (l.producer_department_id = v_dept.id or l.seller_department_id = v_dept.id)
   where b.cid in (select dc.category_id from fin_department_income_categories dc where dc.department_id = v_dept.id)
      or b.cid in (select l2.revenue_category_id from lines l2 where l2.producer_department_id = v_dept.id)
  union all
  -- свои траты (без временной кассы); на ретрит — отдельно
  select case when b.otypeobj = 'retreat' then 'retreat' else 'cost' end,
         (select lc.lname from line_costs lc where lc.pid = b.pid and lc.prod = v_dept.id limit 1),
         null, b.pid, b.oid, b.otype, b.rev, b.d, b.acc, b.cur, b.s, b.sb, b.cid, b.cname, b.oname, b.cmt, b.nt, b.cp
    from base b
   where b.adept = v_dept.id and b.cdir = 'out' and not b.tr
  union all
  -- себестоимость линий, которые этот департамент продаёт (или производит, если трата чужая с объектом линии)
  select 'cost', lc.lname, coalesce((select d.name from fin_departments d where d.id = lc.adept), lc.acc),
         lc.pid, lc.oid, lc.otype, lc.rev, lc.d, lc.acc, lc.cur, lc.s, lc.sb, lc.cid, lc.cname, lc.oname, lc.cmt, lc.nt, lc.cp
    from line_costs lc
   where lc.adept is distinct from v_dept.id
     and (lc.sell = v_dept.id or lc.prod = v_dept.id);
end;
$$;
revoke execute on function fin_department_analytics(text) from public, anon;
grant execute on function fin_department_analytics(text) to authenticated;

insert into translations (key, ru, en, hi, context) values
('dacc_an_lines', 'По направлениям', 'By product line', 'उत्पाद लाइन के अनुसार', 'Аналитика департамента'),
('dacc_an_rest', 'Остальное', 'Everything else', 'बाकी सब', 'Аналитика департамента'),
('dacc_an_retreats', 'Траты на ретриты — затраты ретритов, в итог не входят', 'Spending on retreats — retreat costs, not in the result', 'रिट्रीट पर खर्च — रिट्रीट की लागत, परिणाम में शामिल नहीं', 'Аналитика департамента'),
('dacc_an_cost_line', 'себестоимость', 'cost', 'लागत', 'Аналитика департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
