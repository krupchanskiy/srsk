-- =============================================================
-- «Счёт» департамента (решение ВГ 25.09.2026): глава департамента видит
-- движение денег по счетам СВОЕГО департамента — только просмотр.
-- Пилот — Кухня (kitchen/account.html); страница общая для всех департаментов.
--
-- Функция отдаёт счета департамента по названию. Сами проводки страница берёт
-- из fin_v_account_ledger (там уже работает fin_can_see_account: глава видит
-- счета своего департамента), здесь только «какие счета чьи» —
-- справочник департаментов главе не открыт.
-- Кому отвечает: финансистам (fin_can_read_all) и главе этого департамента.
-- =============================================================

create or replace function public.fin_department_accounts(p_department text)
returns table (account_id uuid, name text, currency_code text, is_active boolean)
language plpgsql stable security definer set search_path = public
as $function$
declare
  v_dept fin_departments%rowtype;
begin
  select * into v_dept from fin_departments d where d.name = p_department;
  if not found then return; end if;

  if not fin_can_read_all() and not exists (
      select 1 from vaishnavas v
       where v.user_id = auth.uid() and v.id = v_dept.responsible_person_id) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  return query
    select a.id, a.name, a.currency_code, a.is_active
      from fin_accounts a
     where a.department_id = v_dept.id
     order by a.is_active desc, a.name;
end;
$function$;

revoke all on function public.fin_department_accounts(text) from public, anon;
grant execute on function public.fin_department_accounts(text) to authenticated;

-- ---------- подписи ----------
insert into translations (key, ru, en, hi, context) values
('nav_dept_account', 'Счёт', 'Account', 'खाता', 'Подменю Кухня: движение денег по счёту департамента'),
('dacc_title', 'Счёт', 'Account', 'खाता', 'Счёт департамента'),
('dacc_subtitle', 'Движение денег по счёту — только просмотр', 'Money movement on the account — view only', 'खाते में धन की आवाजाही — केवल देखना', 'Счёт департамента'),
('dacc_balance_now', 'Сейчас на счёте', 'Balance now', 'अभी खाते में', 'Счёт департамента'),
('dacc_in', 'Пришло', 'Came in', 'आया', 'Счёт департамента'),
('dacc_out', 'Ушло', 'Went out', 'गया', 'Счёт департамента'),
('dacc_opening', 'На начало', 'Opening', 'शुरुआत में', 'Счёт департамента'),
('dacc_closing', 'На конец', 'Closing', 'अंत में', 'Счёт департамента'),
('dacc_no_access', 'Счёт видят только глава департамента и финансисты', 'Only the department head and finance staff can see this account', 'यह खाता केवल विभाग प्रमुख और वित्त कर्मचारी देख सकते हैं', 'Счёт департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
