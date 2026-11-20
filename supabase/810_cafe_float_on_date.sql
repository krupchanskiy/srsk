-- 810: размен кафе возвращается с каждой кассой обязательно (ВГ 20.11.2026), как у магазина (783).
-- Раньше вычет размена был по кнопке (15.10) — его не нажимали, и со 2.11 весь выданный
-- размен ушёл в доход кафе. Теперь приход «Касса кафе» сам вычитает размен, выданный
-- ДО дня этого прихода: утренняя касса дня D содержит размен, выданный по D−1.
-- Размен, выданный в день D, — уже новый, вернётся со следующей кассой.
--
-- Сколько вычесть за день D = (поступило без держателя до D) − (ушло без держателя до D)
--                             − (уже возвращено переводом в день D: вторая касса того же дня).
create or replace function public.fin_department_float_before(p_department uuid, p_currency text, p_date date)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_acc uuid := fin_private_float_account(p_department, p_currency);
begin
  if not fin_can_read_all(auth.uid()) then return null; end if;
  if v_acc is null then return 0; end if;
  return greatest(round(coalesce((
    select sum(case when o.occurred_on < p_date then case p.direction when 'in' then p.amount else -p.amount end
                    when o.type = 'transfer' and p.direction = 'out' then -p.amount
                    else 0 end)
      from fin_postings p join fin_operations o on o.id = p.operation_id
     where p.account_id = v_acc and p.holder_person_id is null
       and o.occurred_on <= p_date), 0), 2), 0);
end;
$$;
revoke execute on function public.fin_department_float_before(uuid, text, date) from public, anon;
grant execute on function public.fin_department_float_before(uuid, text, date) to authenticated;
