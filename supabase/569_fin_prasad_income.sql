-- =============================================================
-- Блок «Прасад» по ТЗ (п. 3.7): приход прасада «начислено и получено»,
-- окупаемость по начисленному, правило «один расход — один раз».
--
-- fin_prasad_income(p_retreat) отдаёт:
--   charged        — начислено за питание (fin_charges kind=meals, без отменённых, за вычетом скидок), ₹
--   gross/discount — до скидок и сами скидки, ₹
--   cancelled      — сколько начислений отменено (не входят)
--   by_status      — начислено по статусу регистрации (guest / vip / team / volunteer / none)
--   donations      — пожертвования на прасад (статья «Прасад - пожертвование») по ретриту, ₹
--   no_rate        — начисления в валюте без курса (в charged не вошли — ⚠ на странице)
--   kitchen_postings — расходы со счетов Кухни, проведённые на этот ретрит (кроме статей прасада):
--                    страница вычитает их из собственных расходов ретрита, если они вошли в себестоимость прасада
-- Курс: курс ретрита на дату начисления, иначе общий курс (как у старой системы), иначе no_rate.
-- Только чтение. Деньги и начисления не трогает.
-- =============================================================

create or replace function public.fin_prasad_income(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare
  v_obj uuid;
  v jsonb;
begin
  if not (fin_kitchen_can_view() or fin_can_read_all()) then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  select id into v_obj from fin_accounting_objects where retreat_id = p_retreat limit 1;

  with ch as (
    select c.amount, c.discount_amount, c.currency_code, c.is_cancelled,
           coalesce((select rr.status from retreat_registrations rr
                      where rr.retreat_id = c.retreat_id and rr.vaishnava_id = c.participant_id
                        and not coalesce(rr.is_deleted, false)
                      order by rr.created_at limit 1), 'none') as st,
           case when c.currency_code = 'INR' then 1 else coalesce(
             (select x.rate from fin_exchange_rates x where x.from_currency = c.currency_code and x.object_id = v_obj
                 and x.effective_date <= coalesce(c.occurred_on, c.created_at::date) order by x.effective_date desc limit 1),
             (select x.rate from fin_exchange_rates x where x.from_currency = c.currency_code and x.object_id is null
                 and x.effective_date <= coalesce(c.occurred_on, c.created_at::date) order by x.effective_date desc limit 1)) end as rate
      from fin_charges c
     where c.retreat_id = p_retreat and c.kind = 'meals'
  ), ok as (
    select * from ch where not is_cancelled and rate is not null
  ), don as (
    select coalesce(sum(p.amount_base), 0) as s
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_categories cat on cat.id = p.category_id
     where p.object_id = v_obj and p.direction::text = 'in' and not o.is_reversed
       and cat.name = 'Прасад - пожертвование'
  ), kp as (
    select p.id as posting_id, cat.name as category, coalesce(g.cost_group, 'general') as cost_group,
           p.amount_base, o.occurred_on
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_accounts a on a.id = p.account_id
      join fin_departments d on d.id = a.department_id and d.name = 'Кухня'
      join fin_categories cat on cat.id = p.category_id
      left join fin_cost_groups g on g.category_id = cat.id
     where p.object_id = v_obj and p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
       and cat.name not in ('Прасад', 'Закупка готового Прасада')
       and coalesce(g.cost_group, 'general') <> 'excluded'
  )
  select jsonb_build_object(
    'charged',   round(coalesce((select sum((amount - discount_amount) * rate) from ok), 0), 2),
    'gross',     round(coalesce((select sum(amount * rate) from ok), 0), 2),
    'discount',  round(coalesce((select sum(discount_amount * rate) from ok), 0), 2),
    'cancelled', (select count(*) from ch where is_cancelled),
    'by_status', coalesce((select jsonb_object_agg(st, s) from
                   (select st, round(sum((amount - discount_amount) * rate), 2) s from ok group by st) z), '{}'::jsonb),
    'donations', (select s from don),
    'no_rate',   coalesce((select jsonb_agg(jsonb_build_object('currency', currency_code, 'amount', amount - discount_amount))
                            from ch where not is_cancelled and rate is null), '[]'::jsonb),
    'kitchen_postings', coalesce((select jsonb_agg(to_jsonb(kp) order by kp.occurred_on) from kp), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;

revoke all on function public.fin_prasad_income(uuid) from public, anon;
grant execute on function public.fin_prasad_income(uuid) to authenticated;
