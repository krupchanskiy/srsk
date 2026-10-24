-- 753: выручка Кухни — не только «Прасад - пожертвование» (ВГ 24.10). Добавлены оплата питания
-- участниками ретритов, группами и гостями без события (проводки с participant_balance_kind='meals',
-- по дате оплаты, подпись «Оплата питания») и прасад за счёт спонсора (статья sponsor_prasad).
-- Зачтённое из «общих» оплат (дат нет) и долг за питание — отдельно, fin_kitchen_meals_open():
-- в выручку не входят, показываются строками под ней.
create or replace function public.fin_department_income(p_department text, p_from date default null::date, p_to date default null::date)
 returns table(posting_id uuid, operation_id uuid, type text, approval text, is_reversed boolean, occurred_on date, created_at timestamp with time zone, account_id uuid, account_name text, currency_code text, direction text, amount numeric, signed_amount numeric, amount_base numeric, category_id uuid, category_name text, object_name text, comment text, note text, cafe_point text)
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
    select p.id, o.id, o.type::text, o.approval::text, o.is_reversed, o.occurred_on, o.created_at,
           a.id, a.name, p.currency_code, p.direction::text, p.amount,
           case when p.direction = 'in' then p.amount else -p.amount end,
           p.amount_base, c.id,
           case when p.participant_balance_kind::text = 'meals' then 'Оплата питания' else c.name end,
           obj.display_name, o.comment, p.note, p.cafe_point::text
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      left join fin_accounting_objects obj on obj.id = p.object_id
     where o.type <> 'opening'
       and (p.category_id in (select dc.category_id from fin_department_income_categories dc where dc.department_id = v_dept.id)
            or p.category_id in (select l.revenue_category_id from fin_production_lines l
                                  where l.is_active and l.producer_department_id = v_dept.id)
            -- выручка кухни: оплата питания (по дате оплаты) и прасад за счёт спонсора (753)
            or (v_dept.code = 'kitchen' and (p.participant_balance_kind::text = 'meals' or c.code = 'sponsor_prasad')))
       and (p_from is null or o.occurred_on >= p_from)
       and (p_to is null or o.occurred_on <= p_to)
     order by o.occurred_on, p.ledger_seq;
end;
$function$;

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
           o.comment cmt, p.note nt, p.cafe_point::text cp, p.is_transit tr,
           p.participant_balance_kind::text pbk, c.code ccode
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
         b.cid, case when b.pbk = 'meals' then 'Оплата питания' else b.cname end, b.oname, b.cmt, b.nt, b.cp
    from base b
    left join lines l on l.revenue_category_id = b.cid and (l.producer_department_id = v_dept.id or l.seller_department_id = v_dept.id)
   where b.cid in (select dc.category_id from fin_department_income_categories dc where dc.department_id = v_dept.id)
      or b.cid in (select l2.revenue_category_id from lines l2 where l2.producer_department_id = v_dept.id)
      -- выручка кухни: оплата питания участниками и группами (по дате оплаты) и прасад за счёт спонсора (753)
      or (v_dept.code = 'kitchen' and (b.pbk = 'meals' or b.ccode = 'sponsor_prasad'))
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

-- Питание без даты и ожидаемое: по каждому ретриту «получено за питание» (как в отчёте ретрита,
-- fin_prasad_income) минус оплаты питания с датой = зачтено из «общих» оплат (до новой системы,
-- даты нет); meals_debt — начислено, но не оплачено. Только Кухня.
create or replace function public.fin_kitchen_meals_open()
 returns table(retreat_id uuid, retreat_name text, start_date date, end_date date, charged numeric, paid numeric, paid_dated numeric, paid_undated numeric, debt numeric)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_dept uuid;
  r record;
  v_inc jsonb;
  v_dated numeric;
begin
  select d.id into v_dept from fin_departments d where d.code = 'kitchen';
  if not fin_can_read_all() and v_dept not in (select fin_user_department_ids()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  for r in select distinct rt.id, rt.name_ru, rt.start_date, rt.end_date
             from retreats rt join fin_accounting_objects ob on ob.retreat_id = rt.id
            order by rt.start_date loop
    v_inc := fin_prasad_income(r.id);
    if coalesce((v_inc->>'charged')::numeric, 0) = 0 then continue; end if;
    select coalesce(sum(case when p.direction = 'in' then p.amount_base else -p.amount_base end), 0) into v_dated
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounting_objects ob on ob.id = p.object_id
     where ob.retreat_id = r.id and not o.is_reversed and o.type <> 'reversal'
       and p.participant_balance_kind::text = 'meals';
    retreat_id := r.id; retreat_name := r.name_ru; start_date := r.start_date; end_date := r.end_date;
    charged := round((v_inc->>'charged')::numeric);
    paid := round((v_inc->>'meals_paid')::numeric);
    paid_dated := round(v_dated);
    paid_undated := greatest(round((v_inc->>'meals_paid')::numeric - v_dated), 0);
    debt := round(coalesce((v_inc->>'meals_debt')::numeric, 0));
    if paid_undated > 0 or debt > 0 then return next; end if;
  end loop;
end;
$function$;
grant execute on function public.fin_kitchen_meals_open() to authenticated;

insert into translations (key, ru, en, hi, context) values
('dacc_an_meals_undated', 'Оплачено до новой системы — без даты', 'Paid before the new system — no date', 'नई प्रणाली से पहले भुगतान — तिथि नहीं', 'Аналитика кухни: питание, зачтённое из общих оплат'),
('dacc_an_meals_debt', 'Ожидается: начислено за питание, не оплачено', 'Expected: meals charged, not paid', 'अपेक्षित: भोजन शुल्क, भुगतान नहीं', 'Аналитика кухни: долг за питание'),
('dacc_an_meals_hint', 'Выручка — по дате оплаты. Эти суммы в неё не входят', 'Revenue is by payment date. These amounts are not included', 'आय — भुगतान तिथि के अनुसार। ये राशियाँ शामिल नहीं हैं', 'Аналитика кухни: подсказка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
