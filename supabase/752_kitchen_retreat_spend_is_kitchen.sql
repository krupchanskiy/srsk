-- 752: у Кухни траты с объектом-ретритом — расходы кухни, а не «траты на ретриты» (ВГ 24.10).
-- Правило мигр. 718 «трата департамента на ретрит — затрата ретрита, в итог не входит» делалось
-- для себестоимости мурти Мастерской. У кухни логика другая: кухня покупает для себя, а куда
-- легла трата (ретрит, команда, департаменты) — решает Себестоимость прасада; отчёт ретрита
-- берёт рассчитанный прасад, а не покупки. Пометка ретрита у покупки кухни — только подсказка
-- Себестоимости. Меняется одна строка: kind = 'retreat' — у всех, кроме кухни.
create or replace function public.fin_department_analytics(p_department text)
 returns table(kind text, line text, source text, posting_id uuid, operation_id uuid, type text, is_reversed boolean, occurred_on date, account_name text, currency_code text, signed_amount numeric, amount_base numeric, category_id uuid, category_name text, object_name text, comment text, note text, cafe_point text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
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
  line_costs as (
    select b.*, l.name lname, l.producer_department_id prod, l.seller_department_id sell
      from base b join lines l on true
     where b.cdir = 'out' and not b.tr and coalesce(b.otypeobj, '') <> 'retreat'
       and ((b.adept = l.producer_department_id and (l.producer_lines = 1 or b.obid = l.object_id))
            or (b.obid = l.object_id and b.adept is distinct from l.producer_department_id))
  )
  select 'revenue'::text, l.name, null::text, b.pid, b.oid, b.otype, b.rev, b.d, b.acc, b.cur, b.s, b.sb,
         b.cid, b.cname, b.oname, b.cmt, b.nt, b.cp
    from base b
    left join lines l on l.revenue_category_id = b.cid and (l.producer_department_id = v_dept.id or l.seller_department_id = v_dept.id)
   where b.cid in (select dc.category_id from fin_department_income_categories dc where dc.department_id = v_dept.id)
      or b.cid in (select l2.revenue_category_id from lines l2 where l2.producer_department_id = v_dept.id)
  union all
  -- у кухни трата с объектом-ретритом — её расход: куда легла, решает Себестоимость (752)
  select case when b.otypeobj = 'retreat' and v_dept.code is distinct from 'kitchen' then 'retreat' else 'cost' end,
         (select lc.lname from line_costs lc where lc.pid = b.pid and lc.prod = v_dept.id limit 1),
         null, b.pid, b.oid, b.otype, b.rev, b.d, b.acc, b.cur, b.s, b.sb, b.cid, b.cname, b.oname, b.cmt, b.nt, b.cp
    from base b
   where b.adept = v_dept.id and b.cdir = 'out' and not b.tr
  union all
  select 'cost', lc.lname, coalesce((select d.name from fin_departments d where d.id = lc.adept), lc.acc),
         lc.pid, lc.oid, lc.otype, lc.rev, lc.d, lc.acc, lc.cur, lc.s, lc.sb, lc.cid, lc.cname, lc.oname, lc.cmt, lc.nt, lc.cp
    from line_costs lc
   where lc.adept is distinct from v_dept.id
     and (lc.sell = v_dept.id or lc.prod = v_dept.id);
end;
$function$;
