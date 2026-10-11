-- 678 (в журнале базы — 675_sales_fee_manager): Процент отделу продаж — менеджер сделки у каждого участника
-- Менеджер берётся из той же сделки CRM, что и валюта (живая сделка приоритетнее отменённой).
-- Нужен для разбивки итога по менеджерам на странице finance/sales-fee.html.

create or replace function public.fin_private_sales_fee_calc(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare
  v_rate numeric := coalesce((select value from fin_settings where key = 'sales_fee_rate_rub')::numeric, 1500);
  v_thr numeric := coalesce((select value from fin_settings where key = 'sales_fee_threshold')::numeric, 0.8);
  v_obj fin_accounting_objects%rowtype;
  v_prices jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_excluded jsonb := '{}'::jsonb;
  v_qualified int := 0;
  v_unposted int;
  v_fix fin_sales_fee_fixations%rowtype;
  r record;
  v_bal jsonb; v_cur text; v_disp text; v_ch numeric; v_debt numeric; v_extra numeric;
  v_paid numeric; v_price numeric; v_pct numeric; v_auto boolean; v_ok boolean; v_k numeric;
  v_flags text[]; v_ov fin_sales_fee_overrides%rowtype;
begin
  select * into v_obj from fin_accounting_objects where retreat_id = p_retreat;

  select jsonb_strip_nulls(jsonb_build_object('INR', p.price, 'RUB', p.price_rub, 'EUR', p.price_eur, 'USD', p.price_usd))
    into v_prices
  from crm_retreat_prices p join crm_services s on s.id = p.service_id
  where p.retreat_id = p_retreat and s.code = 'org_fee'
  limit 1;
  v_prices := coalesce(v_prices, '{}'::jsonb);

  for r in
    select rr.vaishnava_id as pid, rr.status::text as status,
           trim(coalesce(nullif(trim(v.spiritual_name), ''), concat_ws(' ', v.first_name, v.last_name))) as name,
           (select d.currency from crm_deals d where d.retreat_id = p_retreat and d.vaishnava_id = rr.vaishnava_id
             order by (d.status = 'cancelled'), d.updated_at desc limit 1) as deal_cur,
           (select d.manager_id from crm_deals d where d.retreat_id = p_retreat and d.vaishnava_id = rr.vaishnava_id
             order by (d.status = 'cancelled'), d.updated_at desc limit 1) as manager_id
    from retreat_registrations rr join vaishnavas v on v.id = rr.vaishnava_id
    where rr.retreat_id = p_retreat and rr.status <> 'cancelled'
  loop
    v_bal := case when v_obj.id is null then null else fin_private_participant_balance_v2(r.pid, p_retreat) end;
    v_cur := coalesce(v_bal->>'currency', 'INR');
    v_ch := coalesce((v_bal->'blocks'->'org_fee'->>'charged')::numeric, 0);
    v_debt := greatest(coalesce((v_bal->'blocks'->'org_fee'->>'balance')::numeric, 0), 0);
    select coalesce(sum(c.amount - c.discount_amount), 0) into v_extra
    from fin_charges c
    where c.participant_id = r.pid and c.retreat_id = p_retreat and c.kind = 'org_fee' and not c.is_cancelled
      and c.currency_code = v_cur
      and (c.description ilike 'Излишек%' or c.description ilike 'Курсовая разница%');

    -- команда/волонтёры/VIP без оргвзноса — только счётчик
    if r.status in ('team', 'volunteer', 'vip') and v_ch = 0 then
      v_excluded := jsonb_set(v_excluded, array[r.status], to_jsonb(coalesce((v_excluded->>r.status)::int, 0) + 1));
      continue;
    end if;

    v_paid := greatest(v_ch - v_debt - v_extra, 0);
    v_price := (v_prices->>v_cur)::numeric;
    v_pct := case when v_price > 0 then v_paid / v_price end;
    v_auto := coalesce(v_pct >= v_thr - 0.00001, false);

    -- показ: новая система — в валюте расчёта; архив в рупиях — в валюте сделки через соотношение цен
    v_disp := v_cur; v_k := 1;
    if v_bal->>'system' = 'legacy_inr' and r.deal_cur is not null and r.deal_cur <> 'INR'
       and (v_prices->>r.deal_cur)::numeric > 0 and v_price > 0 then
      v_disp := r.deal_cur;
      v_k := (v_prices->>r.deal_cur)::numeric / v_price;
    end if;

    v_flags := array[]::text[];
    if v_price is null then v_flags := array_append(v_flags, 'no_price'); end if;
    if v_ch = 0 then v_flags := array_append(v_flags, 'no_charge'); end if;
    if v_auto and v_price > 0 and (v_ch - v_extra) < v_price * 0.99 then v_flags := array_append(v_flags, 'discount_pass'); end if;
    if not v_auto and v_debt > 0 and v_price > 0 and (v_ch - v_extra) >= v_price * v_thr then v_flags := array_append(v_flags, 'debt'); end if;
    if jsonb_array_length(coalesce(v_bal->'problems', '[]'::jsonb)) > 0 then v_flags := array_append(v_flags, 'problems'); end if;

    select * into v_ov from fin_sales_fee_overrides o where o.retreat_id = p_retreat and o.participant_id = r.pid;
    v_ok := case when v_ov.participant_id is not null then v_ov.include else v_auto end;
    if v_ok then v_qualified := v_qualified + 1; end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'participant_id', r.pid, 'name', r.name, 'status', r.status,
      'manager_id', r.manager_id, 'manager', fin_private_person_name(r.manager_id),
      'currency', v_disp,
      'price', round(coalesce(v_price, 0) * v_k, 2),
      'charged', round((v_ch - v_extra) * v_k, 2),
      'paid', round(v_paid * v_k, 2),
      'debt', round(v_debt * v_k, 2),
      'pct', round(v_pct * 100, 1),
      'auto', v_auto, 'ok', v_ok,
      'override', case when v_ov.participant_id is null then null
                  else jsonb_build_object('include', v_ov.include, 'comment', v_ov.comment, 'at', v_ov.created_at) end,
      'flags', to_jsonb(v_flags),
      'problems', coalesce(v_bal->'problems', '[]'::jsonb)));
    v_ov := null;
  end loop;

  select count(*) into v_unposted
  from fin_v_unposted_crm_payments u join crm_deals d on d.id = u.deal_id
  where d.retreat_id = p_retreat and u.payment_type = 'org_fee';

  select * into v_fix from fin_sales_fee_fixations where retreat_id = p_retreat and is_active;

  return jsonb_build_object(
    'retreat_id', p_retreat,
    'has_object', v_obj.id is not null,
    'legacy', coalesce(v_obj.legacy_inr_settlement, false),
    'rate_rub', v_rate,
    'threshold', v_thr,
    'prices', v_prices,
    'rows', (select coalesce(jsonb_agg(x order by (x->>'ok')::boolean desc, (x->>'pct')::numeric desc nulls last, x->>'name'), '[]'::jsonb)
             from jsonb_array_elements(v_rows) x),
    'excluded', v_excluded,
    'qualified', v_qualified,
    'amount_rub', v_qualified * v_rate,
    'unposted_crm', v_unposted,
    'fixation', case when v_fix.id is null then null else jsonb_build_object(
      'id', v_fix.id, 'operation_id', v_fix.operation_id, 'created_at', v_fix.created_at,
      'created_by_name', fin_private_person_name((select v.id from vaishnavas v where v.user_id = v_fix.created_by limit 1)),
      'rate_rub', v_fix.rate_rub, 'threshold', v_fix.threshold,
      'qualified_count', v_fix.qualified_count, 'amount_rub', v_fix.amount_rub,
      'comment', v_fix.comment,
      'participant_ids', (select coalesce(jsonb_agg(x->'participant_id'), '[]'::jsonb)
                          from jsonb_array_elements(v_fix.rows) x where (x->>'ok')::boolean)) end
  );
end;
$function$;

