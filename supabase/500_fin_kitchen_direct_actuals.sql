-- Этап 7 (сверка): фактические расходы кухни по «прямым» статьям (dept_food, disposable_tableware,
-- prasad_order, strategic_stock) за период — для сравнения с расчётной моделью себестоимости
-- (js/kitchen-cost.js: продукты/посуда/готовое) на экране kitchen/cost.html.
create or replace function public.fin_kitchen_direct_actuals(p_from date, p_to date)
returns table (category_code text, category_name text, postings bigint, amount_base numeric)
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
    select c.code, c.name, count(*), coalesce(sum(p.amount_base), 0)
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
      join fin_categories c on c.id = p.category_id
      join fin_cost_groups g on g.category_id = c.id and g.cost_group = 'direct'
     where p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
       and o.occurred_on between p_from and p_to
     group by c.code, c.name
     order by c.code;
end;
$$;

revoke all on function public.fin_kitchen_direct_actuals(date, date) from public, anon;
grant execute on function public.fin_kitchen_direct_actuals(date, date) to authenticated;
