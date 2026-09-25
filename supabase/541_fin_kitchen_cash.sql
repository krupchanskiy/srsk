-- Касса кухни — реальные деньги по датам (Себестоимость, режим «Период», ВГ 25.09).
-- Пришло: оплаты за питание и пожертвования на прасад (как блок «Прасад» в отчёте по ретриту).
-- Ушло: всё со счетов департамента «Кухня» (кроме группы «Не учитывать»). Кафе — отдельное подразделение, не входит (ВГ).
-- Сторно гасит исходную операцию: сумма со знаком по направлению проводки, переводы и открытие не считаются.

create or replace function fin_private_kitchen_cash_postings(p_from date, p_to date)
returns table(posting_id uuid, operation_id uuid, occurred_on date, dir text, category_name text,
              account_name text, comment text, participant_id uuid, amount_base numeric)
language sql stable security definer set search_path to 'public' as $$
  select p.id, o.id, o.occurred_on,
         case when c.direction::text = 'in' then 'in' else 'out' end,
         c.name, a.name, o.comment, p.participant_id,
         case when p.direction::text = c.direction::text then p.amount_base else -p.amount_base end
    from fin_postings p
    join fin_operations o on o.id = p.operation_id
    join fin_categories c on c.id = p.category_id
    join fin_accounts a on a.id = p.account_id
    left join fin_departments d on d.id = a.department_id
    left join fin_cost_groups g on g.category_id = c.id
   where o.type::text not in ('transfer', 'opening')
     and (p_from is null or o.occurred_on >= p_from) and o.occurred_on <= p_to
     and (
       (c.direction::text = 'in' and (c.name = 'Прасад - пожертвование' or p.participant_balance_kind = 'meals'))
       or (c.direction::text = 'out' and coalesce(g.cost_group, 'general') <> 'excluded'
           and d.name = 'Кухня')
     );
$$;
revoke all on function fin_private_kitchen_cash_postings(date, date) from public, anon, authenticated;

-- По месяцам с начала учёта до p_to: остаток на начало любого периода = сумма месяцев до него
create or replace function fin_kitchen_cash_months(p_to date)
returns table(month date, income numeric, expense numeric)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  return query
    select date_trunc('month', x.occurred_on)::date,
           coalesce(sum(x.amount_base) filter (where x.dir = 'in'), 0),
           coalesce(sum(x.amount_base) filter (where x.dir = 'out'), 0)
      from fin_private_kitchen_cash_postings(null, p_to) x
     group by 1 order by 1;
end;
$$;

-- Операции за период (раскрытие карточек): статья → операции со ссылкой в ДДС.
-- Имя плательщика — только тем, кто видит прасад в отчёте по ретриту.
create or replace function fin_kitchen_cash_ops(p_from date, p_to date)
returns table(operation_id uuid, occurred_on date, dir text, category_name text, account_name text,
              comment text, participant text, amount_base numeric)
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_names boolean;
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'invalid_payload' using detail = 'Некорректный период';
  end if;
  v_names := fin_can_read_all() or coalesce(fin_is_dept_viewer() and fin_is_kitchen_head(), false);
  return query
    select x.operation_id, x.occurred_on, x.dir, x.category_name, x.account_name, x.comment,
           case when v_names and x.participant_id is not null then fin_private_person_name(x.participant_id) end,
           sum(x.amount_base)
      from fin_private_kitchen_cash_postings(p_from, p_to) x
     group by x.operation_id, x.occurred_on, x.dir, x.category_name, x.account_name, x.comment, x.participant_id
    having sum(x.amount_base) <> 0
     order by x.occurred_on, x.category_name;
end;
$$;
grant execute on function fin_kitchen_cash_months(date), fin_kitchen_cash_ops(date, date) to authenticated;
