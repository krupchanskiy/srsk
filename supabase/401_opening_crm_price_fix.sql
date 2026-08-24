-- 401: Пересчёт стартовых остатков по прайсу CRM (чек-лист ВГ v3, п.1).
-- Платёж до запуска финмодуля, ровно равный цене блока в своей валюте,
-- зачитывается по рупиевой цене этого блока, а не по случайному курсу CRM
-- того дня (0.95 давал искусственный долг 2 200 ₹, 1.15 — мнимую переплату).
-- Коррекция — штатными дельта-строками fin_create_opening_correction,
-- request_id детерминированный → повторный прогон идемпотентен.
-- Итог применения 24.08.2026: 10 корректировок, сумма −1 003.15 ₹
-- (+2 200 Туласи-према и Премавати; −82…−2 840 восьмерым с мнимой переплатой).
do $$
declare
  v_admin uuid;
  rec record;
  v_res jsonb;
begin
  select u.id into v_admin
  from auth.users u join vaishnavas v on v.user_id = u.id
  where v.spiritual_name ilike '%ванамали%' limit 1;
  if v_admin is null then
    raise exception 'админ финансов не найден';
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  for rec in
    with pays as (
      select d.id as deal_id, p.amount, p.currency, p.amount_inr, p.payment_type
      from crm_deals d
      join crm_payments p on p.deal_id = d.id
      where d.status <> 'cancelled' and d.vaishnava_id is not null and p.is_confirmed
        and p.payment_type in ('org_fee','accommodation')
    ), matched as (
      select py.*, (c.j->'blocks'->py.payment_type->'final'->>'INR')::numeric as price_inr
      from pays py
      join lateral (select crm_calc_participation(py.deal_id) as j) c on true
      where (c.j->>'ok')::boolean
        and py.amount = (c.j->'blocks'->py.payment_type->'final'->>py.currency)::numeric
        and abs((c.j->'blocks'->py.payment_type->'final'->>'INR')::numeric - py.amount_inr) > 0.01
    ), per_deal as (
      select m.deal_id,
             round(sum(m.price_inr - m.amount_inr), 2) as delta,
             string_agg(format('%s %s = цена блока «%s» → зачтено %s ₹ (было %s ₹ по курсу CRM)',
               m.amount, m.currency, m.payment_type, m.price_inr, m.amount_inr), '; ') as detail
      from matched m group by m.deal_id
    )
    select ob.id as ob_id, pd.delta, pd.detail
    from per_deal pd
    join fin_participant_opening_balances ob
      on ob.source_row_id = pd.deal_id::text and ob.cutover_batch_id is not null
    where pd.delta <> 0
  loop
    v_res := fin_create_opening_correction(jsonb_build_object(
      'request_id', fin_private_child_uuid(rec.ob_id, 'crm_price_fix_v3'),
      'corrects_opening_balance_id', rec.ob_id,
      'amount', abs(rec.delta),
      'kind', case when rec.delta > 0 then 'credit' else 'debt' end,
      'balance_kind', 'general',
      'correction_reason', 'Пересчёт по прайсу CRM (чек-лист ВГ, п.1): ' || rec.detail));
    if not coalesce((v_res->>'ok')::boolean, false) then
      raise exception 'коррекция % не прошла: %', rec.ob_id, v_res;
    end if;
  end loop;
end $$;
