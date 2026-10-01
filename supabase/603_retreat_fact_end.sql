-- Фактическое окончание ретрита (ВГ, 01.10.2026): формально ретрит кончился, а его люди
-- живут дальше (художники после 30.09 — до 20.10). Пока в шахматке живёт хоть кто-то,
-- кто заехал на ретрит и остался, ретрит «идёт»: его можно выбрать в брони и при заселении,
-- финансы держат его в «Идут». Уехал последний — ретрит перестаёт предлагаться,
-- но не закрывается и не архивируется: платежи, долги и отчёты по нему живут как раньше.
--
-- Считаются только места, начатые не позже планового конца: заехал на ретрит и остался.
-- Иначе опечатка в годе (место на 2028 год у фестиваля 2026) продлила бы ретрит на два года.

create or replace view retreat_fact_end with (security_invoker = true) as
select r.id as retreat_id,
       greatest(r.end_date, max(res.check_out)) as fact_end
  from retreats r
  left join residents res
    on res.retreat_id = r.id
   and res.status in ('confirmed', 'checked_out')
   and res.check_in <= r.end_date
 group by r.id, r.end_date;

grant select on retreat_fact_end to authenticated;

comment on view retreat_fact_end is
  'Фактическое окончание ретрита: плановый конец или выезд последнего, кто заехал на ретрит и остался';
