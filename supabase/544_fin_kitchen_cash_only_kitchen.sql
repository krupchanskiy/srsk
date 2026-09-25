-- Касса кухни: «ушло» — только траты кухни, то есть со счетов департамента «Кухня» (ВГ 25.09).
-- Готовый прасад, купленный другим департаментом (кафе, поклонение…), — не траты кухни.
-- Отметки «для какого департамента» у проводок нет (cost_center_id не используется), чья трата — видно по счёту.
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

update translations set ru = 'всё со счетов департамента «Кухня»; траты других департаментов не входят',
 en = 'everything from the «Kitchen» department accounts; other departments'' expenses are not included',
 hi = '«रसोई» विभाग के खातों से सब; अन्य विभागों के खर्च शामिल नहीं'
where key = 'cost_kcash_out_hint';
update translations set ru = replace(ru, 'ушло — всё со счетов департамента «Кухня» и готовый прасад с любого счёта (прочие расходы кафе не входят)', 'ушло — всё со счетов департамента «Кухня» (траты других департаментов не входят)'),
 en = replace(en, 'spent — everything from the «Kitchen» department accounts and ready-made prasad from any account (other cafe expenses are not included)', 'spent — everything from the «Kitchen» department accounts (other departments'' expenses are not included)')
where key = 'cost_kcash_note';
