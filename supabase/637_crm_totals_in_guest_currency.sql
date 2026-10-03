-- Фаза 2, шаг 8 (часть 2): итоги сделки CRM — в валюте гостя (v2), без пересчёта в ₹.
-- Правило ВГ 03.10: по одному гостю — в его валюте; суммы по многим сделкам — ₹ по курсу
-- ретрита + разбивка. Поэтому у сделки:
--   total_charged / total_paid    — в totals_currency (валюта расчёта гостя из v2);
--   total_charged_inr / _paid_inr — те же суммы в ₹ по курсу ретрита (для сумм по сделкам;
--                                   пересчитываются при заведении курса).
-- Сева-ретрит (legacy_inr_settlement) — прежняя формула в ₹, цифры не двигаются.
-- Менеджеру — разбивка долга по блокам своих сделок (crm_get_deal_balance).

alter table crm_deals
  add column if not exists totals_currency text not null default 'INR',
  add column if not exists total_charged_inr numeric,
  add column if not exists total_paid_inr numeric;

comment on column crm_deals.totals_currency is 'Валюта total_charged/total_paid — валюта расчёта гостя (фаза 2). Сева-ретрит — INR';
comment on column crm_deals.total_charged_inr is 'total_charged в ₹ по курсу ретрита — только для сумм по многим сделкам';
comment on column crm_deals.total_paid_inr is 'total_paid в ₹ по курсу ретрита — только для сумм по многим сделкам';

-- Старая формула (всё в ₹) — без изменений, только под другим именем: нужна Сева-ретриту
do $$
declare d text;
begin
  d := pg_get_functiondef('crm_calc_deal_totals(uuid)'::regprocedure);
  d := replace(d, 'FUNCTION public.crm_calc_deal_totals(', 'FUNCTION public.crm_private_calc_deal_totals_inr(');
  if d !~ 'crm_private_calc_deal_totals_inr' then raise exception 'шаблон не найден'; end if;
  execute d;
end $$;
revoke all on function crm_private_calc_deal_totals_inr(uuid) from public, anon, authenticated;

create or replace function public.crm_calc_deal_totals_v2(p_deal uuid,
  out o_currency text, out o_charged numeric, out o_paid numeric,
  out o_charged_inr numeric, out o_paid_inr numeric)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_vaishnava uuid;
  v_retreat uuid;
  v_deal_cur text;
  v_obj uuid;
  v_legacy boolean;
  v_primary uuid;
  v_bal jsonb;
  v_has_fin boolean := false;
  v_on date := current_date;
  rec record;
begin
  select vaishnava_id, retreat_id, coalesce(currency, 'INR') into v_vaishnava, v_retreat, v_deal_cur
  from crm_deals where id = p_deal;
  select id, legacy_inr_settlement into v_obj, v_legacy from fin_accounting_objects where retreat_id = v_retreat;

  -- старая система или событие без учёта — всё в ₹, как было
  if v_obj is null or v_legacy then
    select t.o_charged, t.o_paid into o_charged, o_paid from crm_private_calc_deal_totals_inr(p_deal) t;
    o_currency := 'INR'; o_charged_inr := o_charged; o_paid_inr := o_paid;
    return;
  end if;

  o_charged := 0; o_paid := 0;
  if v_vaishnava is not null then
    select id into v_primary from crm_deals
    where vaishnava_id = v_vaishnava and retreat_id = v_retreat
    order by (status = 'cancelled'), created_at desc
    limit 1;
  end if;

  -- финансы пары «человек × ретрит» — только на основной сделке, в валюте расчёта гостя
  if v_primary = p_deal then
    v_bal := fin_private_participant_balance_v2(v_vaishnava, v_retreat);
    o_currency := v_bal->>'currency';
    select coalesce(sum((v_bal->'blocks'->k->>'charged')::numeric), 0) + coalesce((v_bal->>'general_charged')::numeric, 0),
           coalesce(sum((v_bal->'blocks'->k->>'paid')::numeric), 0) + coalesce((v_bal->>'general_paid')::numeric, 0)
      into o_charged, o_paid
    from unnest(array['org_fee', 'accommodation', 'meals', 'extra']) k;
    v_has_fin := (v_bal->>'currency_source') <> 'default' or o_charged <> 0 or o_paid <> 0;
  end if;
  -- у гостя ещё нет денег в финансах — валюта сделки
  if not v_has_fin then o_currency := v_deal_cur; end if;

  -- услуги сделки (в валюте сделки) и подтверждённые платежи CRM, которых нет в учёте
  -- (ни операции, ни стартового остатка) — переводим в валюту итога по курсу ретрита
  for rec in
    select v_deal_cur as c, total_price as amt, 'charged' as side from crm_deal_services where deal_id = p_deal
    union all
    select cp.currency, cp.amount, 'paid' from crm_payments cp
    where cp.deal_id = p_deal and cp.is_confirmed
      and not exists (select 1 from fin_operations fo where fo.id = cp.id)
      and not exists (select 1 from fin_participant_opening_balances ob where ob.source_row_id = p_deal::text)
  loop
    if rec.c is distinct from o_currency then
      rec.amt := round(rec.amt * fin_private_retreat_rate(rec.c, v_obj, v_on)
                                / fin_private_retreat_rate(o_currency, v_obj, v_on), 2);
    end if;
    if rec.side = 'charged' then o_charged := o_charged + rec.amt; else o_paid := o_paid + rec.amt; end if;
  end loop;

  o_charged := round(o_charged, 2);
  o_paid := round(o_paid, 2);
  o_charged_inr := fin_private_to_inr(o_charged, o_currency, v_retreat, v_on);
  o_paid_inr := fin_private_to_inr(o_paid, o_currency, v_retreat, v_on);
end;
$function$;
revoke all on function crm_calc_deal_totals_v2(uuid) from public, anon, authenticated;

-- Прежнее имя (проверка целостности, восстановление cutover) — та же формула, что пишет сделку
create or replace function public.crm_calc_deal_totals(p_deal uuid, out o_charged numeric, out o_paid numeric)
 language sql stable security definer set search_path to 'public'
as $function$
  select t.o_charged, t.o_paid from crm_calc_deal_totals_v2(p_deal) t;
$function$;

create or replace function public.crm_apply_deal_totals(p_deal uuid)
 returns void
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  t record;
begin
  select * into t from crm_calc_deal_totals_v2(p_deal);
  update crm_deals set total_charged = t.o_charged, total_paid = t.o_paid, totals_currency = t.o_currency,
                       total_charged_inr = t.o_charged_inr, total_paid_inr = t.o_paid_inr
  where id = p_deal
    and (total_charged is distinct from t.o_charged or total_paid is distinct from t.o_paid
         or totals_currency is distinct from t.o_currency
         or total_charged_inr is distinct from t.o_charged_inr or total_paid_inr is distinct from t.o_paid_inr);
end;
$function$;

-- Курс ретрита заведён/изменён → ₹-итоги сделок события пересчитываются; общий курс — все события
create or replace function public.crm_resync_totals_on_rate()
 returns trigger
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_obj uuid := coalesce(new.object_id, old.object_id);
begin
  perform crm_apply_deal_totals(d.id)
  from crm_deals d
  join fin_accounting_objects o on o.retreat_id = d.retreat_id
  where not o.legacy_inr_settlement
    and (v_obj is null or o.id = v_obj);
  return null;
exception when others then
  raise warning 'crm_resync_totals_on_rate: %', sqlerrm;
  return null;
end;
$function$;

drop trigger if exists trg_crm_resync_totals_on_rate on fin_exchange_rates;
create trigger trg_crm_resync_totals_on_rate
  after insert or update or delete on fin_exchange_rates
  for each row execute function crm_resync_totals_on_rate();

-- Оргвзнос оплачен? (сейчас никем не вызывается — держим в согласии с v2)
create or replace function public.crm_deal_org_fee_status(p_retreat uuid)
 returns table(deal_id uuid, org_charged numeric, org_paid numeric, fully_paid boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_full boolean;
  v_legacy boolean;
begin
  if not is_staff(auth.uid()) then
    raise exception 'forbidden';
  end if;
  v_full := fin_can_read_all(auth.uid());
  select legacy_inr_settlement into v_legacy from fin_accounting_objects where retreat_id = p_retreat;
  if coalesce(v_legacy, true) then
    return query
    select d.id,
           case when v_full then round(coalesce(ch.s, 0), 2) end,
           case when v_full then round(coalesce(lg.s, 0) + coalesce(pp.s, 0), 2) end,
           coalesce(ch.s, 0) > 0 and coalesce(lg.s, 0) + coalesce(pp.s, 0) >= coalesce(ch.s, 0)
    from crm_deals d
    left join lateral (
      select sum(c.amount - c.discount_amount) as s from fin_charges c
      where c.participant_id = d.vaishnava_id and c.retreat_id = d.retreat_id
        and c.kind = 'org_fee' and not c.is_cancelled
    ) ch on true
    left join lateral (
      select sum(cp.amount_inr) as s from crm_payments cp
      where cp.deal_id = d.id and cp.is_confirmed
        and not exists (select 1 from fin_operations fo where fo.id = cp.id)
    ) lg on true
    left join lateral (
      select sum(case p.direction when 'in' then p.amount_base else -p.amount_base end) as s
      from fin_postings p join fin_accounting_objects o on o.id = p.object_id
      where p.participant_id = d.vaishnava_id and o.retreat_id = d.retreat_id
        and p.participant_balance_kind = 'org_fee'
    ) pp on true
    where d.retreat_id = p_retreat;
    return;
  end if;
  -- новая система: блок «Оргвзнос» из v2 в валюте гостя; оплачен — долг по блоку закрыт
  return query
  select d.id,
         case when v_full then (b.j->'blocks'->'org_fee'->>'charged')::numeric end,
         case when v_full then (b.j->'blocks'->'org_fee'->>'paid')::numeric end,
         (b.j->'blocks'->'org_fee'->>'charged')::numeric > 0
           and (b.j->'blocks'->'org_fee'->>'balance')::numeric <= 0
  from crm_deals d
  cross join lateral (select fin_private_participant_balance_v2(d.vaishnava_id, d.retreat_id) as j) b
  where d.retreat_id = p_retreat and d.vaishnava_id is not null;
end;
$function$;

-- Разбивка долга по сделке: финансы видят всё, менеджер — свои сделки
create or replace function public.crm_get_deal_balance(p_deal uuid)
 returns jsonb
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_deal crm_deals%rowtype;
  v_primary uuid;
begin
  select * into v_deal from crm_deals where id = p_deal;
  if not found or v_deal.vaishnava_id is null or v_deal.retreat_id is null then
    return null;
  end if;
  if not (fin_can_read_all()
          or exists (select 1 from vaishnavas v where v.id = v_deal.manager_id and v.user_id = auth.uid())) then
    raise exception 'forbidden' using detail = 'Итог видят финансы и менеджер сделки';
  end if;
  -- финансы пары показываются на основной сделке (как в итогах сделки)
  select id into v_primary from crm_deals
  where vaishnava_id = v_deal.vaishnava_id and retreat_id = v_deal.retreat_id
  order by (status = 'cancelled'), created_at desc limit 1;
  if v_primary <> p_deal then
    return null;
  end if;
  return fin_private_participant_balance_v2(v_deal.vaishnava_id, v_deal.retreat_id) - 'writeoffs';
end;
$function$;
revoke all on function crm_get_deal_balance(uuid) from public, anon;
grant execute on function crm_get_deal_balance(uuid) to authenticated;

-- Пересчитать все сделки
select crm_apply_deal_totals(id) from crm_deals;
