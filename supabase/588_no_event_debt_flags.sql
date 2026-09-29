-- Гости без события, шаг 3 (ВГ, 29.09.2026): значок долга в шахматке.
-- Ресепшен не видит служебный контейнер «Гости без события» (fin_get_no_event_retreat
-- только для финансов), поэтому флаги отдаются отдельно — как fin_retreat_debtors /
-- fin_retreat_creditors у ретритов: только «долг» или «мы должны», без сумм.
-- p_participant — свежая проверка одного гостя (при выселении).
-- Баланс — v2 (валюта расчёта гостя), как в списке визитов.
create or replace function fin_no_event_debt_flags(p_participant uuid default null)
returns table(participant_id uuid, is_debt boolean)
language plpgsql stable security definer set search_path to 'public' as $$
declare
    v_ret uuid := fin_private_no_event_retreat();
begin
    if not is_staff(auth.uid()) then raise exception 'forbidden'; end if;
    if v_ret is null then return; end if;
    return query
    select x.pid, (b.j->>'total_debt')::numeric > 0
      from (
        select distinct c.participant_id pid from fin_charges c
         where c.retreat_id = v_ret and not c.is_cancelled
        union
        select distinct p.participant_id from fin_postings p
          join fin_accounting_objects o on o.id = p.object_id
         where o.retreat_id = v_ret and p.participant_id is not null
           and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
      ) x
     cross join lateral (select fin_private_participant_balance_v2(x.pid, v_ret) j) b
     where (p_participant is null or x.pid = p_participant)
       and (coalesce((b.j->>'total_debt')::numeric, 0) > 0
            or coalesce((b.j->>'net')::numeric, 0) < 0);
end;
$$;

revoke execute on function fin_no_event_debt_flags(uuid) from public, anon;
grant execute on function fin_no_event_debt_flags(uuid) to authenticated;
