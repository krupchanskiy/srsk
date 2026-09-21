-- =============================================================
-- Данные для накладных расходов кухни (этап 5 учёта себестоимости прасада,
-- ТЗ п. 3.6 части 2 и 3): зарплаты по начислениям и расходы кухни по группам.
-- Только чтение; ядро финансов не меняется. Распределение считает клиент
-- (js/kitchen-cost.js): здесь отдаются исходные строки.
--
-- fin_kitchen_payroll — зарплаты кухни по месяцам: начисление за месяц; если
--   начисления ещё нет — оценка (оклад должности либо последнее начисление
--   этой должности), помечается source = 'estimate' («предварительно»).
-- fin_kitchen_overhead_items — расходы кухни (счета департамента «Кухня»),
--   кроме группы «direct» (сверка с ДДС) и «excluded», а также выплат по
--   зарплатной ведомости (они учтены начислениями). kind:
--     general        — общие расходы (период: назначенный, иначе месяц оплаты)
--     retreat_event  — расход привязан к ретриту (период = даты ретрита)
--     retreat_period — билет и подобное с периодом работы
--     unassigned     — статья «на ретрит» без ретрита и назначения (пока как общие)
-- =============================================================

create or replace function public.fin_kitchen_payroll(p_from date, p_to date)
returns table (month date, position_title text, amount numeric, currency_code text, source text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'invalid_payload' using detail = 'Некорректный период';
  end if;

  return query
    with months as (
      select generate_series(date_trunc('month', p_from)::date, date_trunc('month', p_to)::date, interval '1 month')::date as m
    ),
    pos as (
      select pp.* from fin_payroll_positions pp
        join fin_departments d on d.id = pp.department_id and d.name = 'Кухня'
    ),
    acc as (
      select a.position_id, date_trunc('month', a.period)::date as m, sum(a.amount) as amount
        from fin_payroll_accruals a group by 1, 2
    )
    select mo.m, pos.position_title,
           coalesce(acc.amount, est.amount),
           pos.currency_code,
           case when acc.position_id is not null then 'accrual' else 'estimate' end
      from months mo
      cross join pos
      left join acc on acc.position_id = pos.id and acc.m = mo.m
      left join lateral (
        select coalesce(pos.salary_amount,
                        (select a2.amount from fin_payroll_accruals a2
                          where a2.position_id = pos.id and a2.period < mo.m
                          order by a2.period desc limit 1)) as amount
      ) est on true
     where (acc.position_id is not null
            or (pos.effective_from <= (mo.m + interval '1 month - 1 day')::date
                and (pos.effective_to is null or pos.effective_to >= mo.m)))
       and coalesce(acc.amount, est.amount) is not null
     order by mo.m, pos.position_title;
end;
$$;

create or replace function public.fin_kitchen_overhead_items(p_from date, p_to date)
returns table (posting_id uuid, occurred_on date, category_name text, kind text, confirmed boolean,
               amount_base numeric, retreat_id uuid, eff_from date, eff_to date, comment text, labor_unlinked boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'invalid_payload' using detail = 'Некорректный период';
  end if;

  return query
    select x.id, x.occurred_on, x.cname, x.kind, x.confirmed, x.amount_base, x.retreat_id, x.eff_from, x.eff_to, x.comment, x.labor
      from (
        select b.id, b.occurred_on, b.cname, b.kind, b.confirmed, b.amount_base, b.retreat_id, b.comment,
               (b.ccode = 'dept_labor') as labor,
               case b.kind when 'retreat_event' then b.rs
                           when 'retreat_period' then b.period_from
                           else coalesce(b.period_from, date_trunc('month', b.occurred_on)::date) end as eff_from,
               case b.kind when 'retreat_event' then b.re
                           when 'retreat_period' then b.period_to
                           else coalesce(b.period_to, (date_trunc('month', b.occurred_on) + interval '1 month - 1 day')::date) end as eff_to
          from (
            select p.id, o.occurred_on, c.name as cname, c.code as ccode,
                   (g.cost_group is not null) as confirmed, p.amount_base, o.comment,
                   dd.mode as dmode, dd.period_from, dd.period_to, ao.retreat_id, r.start_date as rs, r.end_date as re,
                   case
                     when coalesce(g.cost_group, 'general') = 'retreat' and ao.retreat_id is not null then 'retreat_event'
                     when coalesce(g.cost_group, 'general') = 'retreat' and dd.mode = 'period' then 'retreat_period'
                     when coalesce(g.cost_group, 'general') = 'retreat' and dd.mode is null then 'unassigned'
                     else 'general'
                   end as kind
              from fin_postings p
              join fin_operations o on o.id = p.operation_id
              join fin_accounts a on a.id = p.account_id
              join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
              join fin_categories c on c.id = p.category_id
              left join fin_cost_groups g on g.category_id = c.id
              left join fin_posting_destinations dd on dd.posting_id = p.id
              left join fin_accounting_objects ao on ao.id = p.object_id
              left join retreats r on r.id = ao.retreat_id
             where p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
               and coalesce(g.cost_group, 'general') not in ('direct', 'excluded')
               and not exists (select 1 from fin_payroll_payments pp where pp.posting_id = p.id)
          ) b
      ) x
     where x.eff_from is not null and x.eff_to is not null
       and x.eff_from <= p_to and x.eff_to >= p_from
     order by x.occurred_on;
end;
$$;

revoke all on function public.fin_kitchen_payroll(date, date) from public, anon;
revoke all on function public.fin_kitchen_overhead_items(date, date) from public, anon;
grant execute on function public.fin_kitchen_payroll(date, date) to authenticated;
grant execute on function public.fin_kitchen_overhead_items(date, date) to authenticated;
