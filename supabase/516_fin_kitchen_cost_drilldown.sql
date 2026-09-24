-- Себестоимость: детализация расходов списком с переходом в ДДС (решение ВГ 24.09.2026).
-- Только чтение, то же право, что у сверки и накладных (fin_kitchen_can_view).
--   fin_kitchen_direct_postings — расходы кухни по «прямым» статьям за период построчно
--                                 (то, что в сверке с ДДС показано суммой);
--   fin_kitchen_posting_operations — операция ДДС для проводок накладных (для ссылки dds.html?op=).
create or replace function public.fin_kitchen_direct_postings(p_from date, p_to date)
returns table (operation_id uuid, occurred_on date, category_code text, category_name text, amount_base numeric, comment text)
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
    select o.id, o.occurred_on, c.code, c.name, p.amount_base, o.comment
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
      join fin_categories c on c.id = p.category_id
      join fin_cost_groups g on g.category_id = c.id and g.cost_group = 'direct'
     where p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
       and o.occurred_on between p_from and p_to
     order by o.occurred_on, c.code;
end;
$$;

create or replace function public.fin_kitchen_posting_operations(p_posting_ids uuid[])
returns table (posting_id uuid, operation_id uuid)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  return query
    select p.id, p.operation_id
      from fin_postings p
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
     where p.id = any(p_posting_ids);
end;
$$;

revoke all on function public.fin_kitchen_direct_postings(date, date) from public, anon;
revoke all on function public.fin_kitchen_posting_operations(uuid[]) from public, anon;
grant execute on function public.fin_kitchen_direct_postings(date, date) to authenticated;
grant execute on function public.fin_kitchen_posting_operations(uuid[]) to authenticated;
