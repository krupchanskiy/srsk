-- Себестоимость → Накладные: у зарплаты показывать, кто на должности (ВГ 25.09).
-- Добавлены vaishnava_id и person_name; расчёт сумм без изменений (мигр. ранее).
drop function if exists public.fin_kitchen_payroll(date, date);
create function public.fin_kitchen_payroll(p_from date, p_to date)
 returns table(month date, position_title text, amount numeric, currency_code text, source text,
               vaishnava_id uuid, person_name text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
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
           case when acc.position_id is not null then 'accrual' else 'estimate' end,
           pos.vaishnava_id,
           coalesce(nullif(v.spiritual_name, ''), trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')))::text
      from months mo
      cross join pos
      left join vaishnavas v on v.id = pos.vaishnava_id
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
$function$;
revoke all on function public.fin_kitchen_payroll(date, date) from public;
grant execute on function public.fin_kitchen_payroll(date, date) to authenticated, service_role;
