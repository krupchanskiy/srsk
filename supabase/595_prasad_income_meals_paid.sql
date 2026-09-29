-- 595: приход прасада — «получено за питание» так же, как в карточке участника (ВГ 30.09.2026).
-- Оплаты до переезда лежат «общими» и зачитываются в блоки по приоритету
-- (оргвзнос → проживание → питание); прямых проводок в блок «Питание» у них нет.
-- Получено за питание = начислено блока − остаток долга блока (fin_private_participant_balance_v2).
-- Сева: 882 920 прямыми + 60 745 зачтено из общего = 943 665; долг по питанию 7 875.
CREATE OR REPLACE FUNCTION public.fin_prasad_income(p_retreat uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     where p.direction::text = 'in' and not o.is_reversed
       and cat.name = 'Прасад - пожертвование'
       and (p.object_id = v_obj or (p.object_id is null and fin_private_common_retreat_on(o.occurred_on) = p_retreat))
  ), don_auto as (
    select coalesce(sum(p.amount_base), 0) as s, count(*) as n
      from fin_postings p
      join fin_operations o on o.id = p.operation_id
      join fin_categories cat on cat.id = p.category_id
     where p.direction::text = 'in' and not o.is_reversed and cat.name = 'Прасад - пожертвование'
       and p.object_id is null and fin_private_common_retreat_on(o.occurred_on) = p_retreat
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
  ), bal as (
    -- блок «Питание» каждого участника, как в его карточке: оплачено + зачтено из общего
    select b, case when b->>'currency' = 'INR' then 1 else coalesce(
             (select x.rate from fin_exchange_rates x where x.from_currency = b->>'currency' and x.object_id = v_obj
                 order by x.effective_date desc limit 1),
             (select x.rate from fin_exchange_rates x where x.from_currency = b->>'currency' and x.object_id is null
                 order by x.effective_date desc limit 1)) end as rate
      from (select fin_private_participant_balance_v2(z.pid, p_retreat) as b
              from (select distinct c.participant_id as pid from fin_charges c
                     where c.retreat_id = p_retreat and c.kind = 'meals' and not c.is_cancelled) z) y
  ), mp as (
    select sum(((b->'blocks'->'meals'->>'charged')::numeric - greatest((b->'blocks'->'meals'->>'balance')::numeric, 0)) * rate) as paid,
           sum(greatest((b->'blocks'->'meals'->>'balance')::numeric, 0) * rate) as debt
      from bal
  )
  select jsonb_build_object(
    'charged',   round(coalesce((select sum((amount - discount_amount) * rate) from ok), 0), 2),
    'gross',     round(coalesce((select sum(amount * rate) from ok), 0), 2),
    'discount',  round(coalesce((select sum(discount_amount * rate) from ok), 0), 2),
    'cancelled', (select count(*) from ch where is_cancelled),
    'by_status', coalesce((select jsonb_object_agg(st, s) from
                   (select st, round(sum((amount - discount_amount) * rate), 2) s from ok group by st) z), '{}'::jsonb),
    'donations', (select s from don),
    'donations_auto', (select s from don_auto),
    'donations_auto_n', (select n from don_auto),
    'meals_paid', round(coalesce((select paid from mp), 0), 2),
    'meals_debt', round(coalesce((select debt from mp), 0), 2),
    'no_rate',   coalesce((select jsonb_agg(jsonb_build_object('currency', currency_code, 'amount', amount - discount_amount))
                            from ch where not is_cancelled and rate is null), '[]'::jsonb),
    'kitchen_postings', coalesce((select jsonb_agg(to_jsonb(kp) order by kp.occurred_on) from kp), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;
