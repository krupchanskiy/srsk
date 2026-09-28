-- 579: курс события — свой или общий (ВГ, 28.09.2026).
-- «Курс для каждого ретрита может быть общим на момент ретрита или конкретно на ретрит —
-- если договорились о другом, ставим руками; может и совпадать с общим».
--   • свой курс события (fin_exchange_rates.object_id = объект события) — главный;
--   • своего по валюте нет → общий курс на дату операции (раньше у событий новой
--     системы это была ошибка retreat_rate_missing, см. 561);
--   • карточка получает признак is_own — видно, какой курс действует.
-- Замер до правки: свой курс есть только у Сева-ретрита (старая система, не затронут);
-- проведённые операции хранят rate_used в проводке — прошлые цифры не меняются.

create or replace function public.fin_private_retreat_rate(p_currency text, p_object uuid, p_on date)
 returns numeric
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_rate numeric;
begin
  if p_currency = 'INR' then return 1; end if;
  -- свой курс события: действующий на дату, а если заведён позже — самый ранний
  -- (договорной курс относится ко всему событию)
  select rate into v_rate from fin_exchange_rates
   where from_currency = p_currency and object_id = p_object
   order by (effective_date <= p_on) desc,
            case when effective_date <= p_on then effective_date end desc,
            effective_date asc
   limit 1;
  if v_rate is not null then return v_rate; end if;
  -- своего нет — общий курс на дату
  select rate into v_rate from fin_exchange_rates
   where from_currency = p_currency and object_id is null and effective_date <= p_on
   order by effective_date desc limit 1;
  if v_rate is null then
    raise exception 'retreat_rate_missing'
      using detail = format('Нет курса %s→INR на %s — ни своего у события, ни общего', p_currency, p_on);
  end if;
  return v_rate;
end;
$function$;

-- Курсы для карточки: по каждой валюте свой курс события, иначе последний общий
drop function if exists public.fin_get_retreat_rates(uuid);
create function public.fin_get_retreat_rates(p_retreat uuid)
 returns table(currency_code text, rate numeric, is_own boolean)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
    select distinct on (r.from_currency) r.from_currency::text, r.rate, r.object_id is not null
      from fin_exchange_rates r
      left join fin_accounting_objects o on o.id = r.object_id
     where o.retreat_id = p_retreat or r.object_id is null
     order by r.from_currency, (o.retreat_id = p_retreat) desc nulls last, r.effective_date desc;
$function$;

revoke all on function public.fin_get_retreat_rates(uuid) from public, anon;
grant execute on function public.fin_get_retreat_rates(uuid) to authenticated;
