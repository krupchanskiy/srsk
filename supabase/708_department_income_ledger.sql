-- 708: выручка департамента — в общую ленту «Счёта» (ВГ 18.10: все приходы и расходы в одном месте).
-- Функция отдаёт строки в форме ленты (как fin_v_account_ledger) и только с ЧУЖИХ счетов
-- (Касса, Гест-хаус): операции на счетах самого департамента лента уже показывает.
drop function if exists fin_department_income(text, date, date);

create or replace function fin_department_income(p_department text, p_from date default null, p_to date default null)
returns table(posting_id uuid, operation_id uuid, type text, approval text, is_reversed boolean,
              occurred_on date, created_at timestamptz, account_id uuid, account_name text,
              currency_code text, direction text, amount numeric, signed_amount numeric, amount_base numeric,
              category_id uuid, category_name text, object_name text, comment text)
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
           p.amount_base, c.id, c.name, obj.display_name, o.comment
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_categories c on c.id = p.category_id
      join fin_department_income_categories dc on dc.category_id = p.category_id and dc.department_id = v_dept.id
      left join fin_accounting_objects obj on obj.id = p.object_id
     where o.type <> 'opening'
       and a.department_id is distinct from v_dept.id
       and (p_from is null or o.occurred_on >= p_from)
       and (p_to is null or o.occurred_on <= p_to)
     order by o.occurred_on, p.ledger_seq;
end;
$$;
revoke execute on function fin_department_income(text, date, date) from public, anon;
grant execute on function fin_department_income(text, date, date) to authenticated;

insert into translations (key, ru, en, hi, context) values
('dacc_on_hand', 'На руках у департамента', 'Held by the department', 'विभाग के पास', 'Счёт департамента: итог'),
('dacc_earned', 'Заработал', 'Earned', 'कमाया', 'Счёт департамента: итог'),
('dacc_received', 'Получил на расходы', 'Received for expenses', 'खर्च के लिए मिला', 'Счёт департамента: итог'),
('dacc_spent', 'Потратил', 'Spent', 'खर्च किया', 'Счёт департамента: итог'),
('dacc_handed_to', 'сдано', 'handed in', 'जमा किया', 'Счёт департамента: выручка на другом счёте'),
('dacc_ext_hint', 'Выручка сдана на другой счёт — входит в «Заработал», но не в «На руках»', 'Revenue handed in to another account — counted in Earned, not in Held', 'राजस्व दूसरे खाते में जमा — «कमाया» में शामिल, «विभाग के पास» में नहीं', 'Счёт департамента: выручка на другом счёте'),
('dacc_earned_hint', 'Выручка и другие приходы по статьям — и на счёт департамента, и сданные в Кассу или Гест-хаус', 'Revenue and other categorised income — both on the department account and handed in to the Cash desk or Guest house', 'राजस्व और अन्य आय — विभाग के खाते में भी और कैश या गेस्ट-हाउस में जमा भी', 'Счёт департамента: итог'),
('dacc_received_hint', 'Деньги, выданные департаменту из общей кассы или с других счетов', 'Money given to the department from the common cash or other accounts', 'सामान्य कैश या अन्य खातों से विभाग को दिया गया पैसा', 'Счёт департамента: итог'),
('dacc_passed_on', 'передано на другие счета', 'passed to other accounts', 'अन्य खातों में दिया गया', 'Счёт департамента: итог')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
