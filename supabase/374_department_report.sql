-- Отчёт по департаментам за период: кому сколько выдали, сколько потратили, что осталось.
-- Экономика департамента не «доход/расход», а «получил → потратил → остаток на руках»:
-- собственных доходов у них нет, деньги приходят переводом из кассы.
-- Суммы в рупиях (amount_base) — единая база для мультивалютных счетов.
--
-- (Миграция 373 была первой версией этой же функции: она обращалась
-- к несуществующей колонке fin_departments.is_active. Здесь исправлено.)
create or replace function public.fin_get_department_report(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_departments jsonb;
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  with движения as (
    select a.department_id,
           o.type,
           p.direction,
           p.category_id,
           c.name as category_name,
           p.amount_base
      from fin_postings p
      join fin_accounts a on a.id = p.account_id
      join fin_operations o on o.id = p.operation_id
      left join fin_categories c on c.id = p.category_id
     where a.department_id is not null
       and o.type <> 'opening'          -- начальный остаток не движение периода
       and o.occurred_on between p_from and p_to
  ),
  итоги as (
    select department_id,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'in'), 0) as received,
           coalesce(sum(amount_base) filter (where type = 'transfer' and direction = 'out'), 0) as passed_on,
           -- со знаком, поэтому сторно само вычитается из расхода
           coalesce(sum(case when direction = 'out' then amount_base else -amount_base end)
                    filter (where category_id is not null), 0) as spent
      from движения group by department_id
  ),
  по_статьям as (
    select department_id, category_name,
           sum(case when direction = 'out' then amount_base else -amount_base end) as total
      from движения
     where category_id is not null
     group by department_id, category_name
    having sum(case when direction = 'out' then amount_base else -amount_base end) <> 0
  ),
  остатки as (
    -- остаток на конец периода: всё, что было на счетах департамента по p_to включительно
    select a.department_id,
           sum(case when p.direction = 'in' then p.amount_base else -p.amount_base end) as balance_end
      from fin_postings p
      join fin_accounts a on a.id = p.account_id
      join fin_operations o on o.id = p.operation_id
     where a.department_id is not null and o.occurred_on <= p_to
     group by a.department_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'department_id', d.id,
           'name', d.name,
           'received', coalesce(i.received, 0),
           'spent', coalesce(i.spent, 0),
           'passed_on', coalesce(i.passed_on, 0),
           'balance_end', coalesce(b.balance_end, 0),
           'by_category', coalesce(
             (select jsonb_agg(jsonb_build_object('name', k.category_name, 'total', k.total)
                               order by k.total desc)
                from по_статьям k where k.department_id = d.id), '[]'::jsonb)
         ) order by coalesce(i.spent, 0) desc, d.name), '[]'::jsonb)
    into v_departments
    from fin_departments d
    left join итоги i on i.department_id = d.id
    left join остатки b on b.department_id = d.id;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'from', p_from, 'to', p_to,
    'departments', v_departments
  ));
end;
$function$;

revoke all on function public.fin_get_department_report(date, date) from public, anon;
grant execute on function public.fin_get_department_report(date, date) to authenticated, service_role;
