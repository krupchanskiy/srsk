-- Смена валюты расчёта теряла привязку начисления к визиту (ВГ, 01.10.2026).
-- fin_private_apply_settlement_currency отменяет начисление и создаёт его заново в новой
-- валюте, но не переносила resident_id — гость без события после оплаты в € снова
-- показывался «не начислено» (Шаранги д.д., визит 06.09–24.09).
-- Исправление: resident_id копируется вместе с остальными полями + точечно
-- возвращена привязка двум начислениям Шаранги.

CREATE OR REPLACE FUNCTION public.fin_private_apply_settlement_currency(p_participant uuid, p_retreat uuid, p_currency text, p_on date, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
v_obj uuid;
v_legacy boolean;
v_rate_to numeric;
v_rate_from numeric;
v_credits int := 0;
v_converted int := 0;
v_amount numeric;
v_discount numeric;
v_sync jsonb := null;
rec record;
begin
if p_currency is null or p_currency not in ('INR', 'RUB', 'USD', 'EUR') then
raise exception 'invalid_payload' using detail = 'Валюта расчёта: INR | RUB | USD | EUR';
end if;
select id, legacy_inr_settlement into v_obj, v_legacy from fin_accounting_objects where retreat_id = p_retreat;
if v_obj is null then
raise exception 'invalid_payload' using detail = 'У события нет учётного объекта';
end if;
if v_legacy then
raise exception 'legacy_inr_only' using detail = 'Событие на старой системе расчёта: всё в ₹, валюта расчёта не выбирается';
end if;
v_rate_to := fin_private_retreat_rate(p_currency, v_obj, p_on);
insert into fin_participant_settlements (participant_id, retreat_id, currency_code, chosen_on, created_by)
values (p_participant, p_retreat, p_currency, p_on, p_actor)
on conflict (participant_id, retreat_id) do update
set currency_code = excluded.currency_code, chosen_on = excluded.chosen_on;
for rec in
select p.id, p.currency_code, p.amount
from fin_postings p join fin_operations o on o.id = p.operation_id
where p.participant_id = p_participant and p.object_id = v_obj
and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
and not o.is_reversed and o.type <> 'reversal'
and p.currency_code <> p_currency
and not exists (select 1 from fin_settlement_credits sc
where sc.posting_id = p.id and sc.settle_currency = p_currency)
loop
if fin_private_settle_waits(p_retreat, rec.currency_code, p_currency, p_on) then continue; end if;
v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
insert into fin_settlement_credits (posting_id, participant_id, retreat_id, from_currency, from_amount,
settle_currency, settle_amount, rate_from, rate_to, created_by)
values (rec.id, p_participant, p_retreat, rec.currency_code, rec.amount,
p_currency, round(rec.amount * v_rate_from / v_rate_to, 2), v_rate_from, v_rate_to, p_actor);
v_credits := v_credits + 1;
end loop;
for rec in
select b.id, b.currency_code, b.amount
from fin_participant_opening_balances b
where b.participant_id = p_participant and b.retreat_id = p_retreat
and b.currency_code <> p_currency
and not exists (select 1 from fin_settlement_credits sc
where sc.opening_id = b.id and sc.settle_currency = p_currency)
loop
if fin_private_settle_waits(p_retreat, rec.currency_code, p_currency, p_on) then continue; end if;
v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
insert into fin_settlement_credits (opening_id, participant_id, retreat_id, from_currency, from_amount,
settle_currency, settle_amount, rate_from, rate_to, created_by)
values (rec.id, p_participant, p_retreat, rec.currency_code, rec.amount,
p_currency, round(rec.amount * v_rate_from / v_rate_to, 2), v_rate_from, v_rate_to, p_actor);
v_credits := v_credits + 1;
end loop;
for rec in
select * from fin_charges
where participant_id = p_participant and retreat_id = p_retreat and not is_cancelled
and currency_code <> p_currency and creation_reason is distinct from 'crm_auto'
loop
v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
v_amount := round(rec.amount * v_rate_from / v_rate_to, 2);
v_discount := least(round(rec.discount_amount * v_rate_from / v_rate_to, 2), v_amount);
update fin_charges
set is_cancelled = true, cancelled_at = now(), cancelled_by = p_actor,
cancelled_reason = format('Смена валюты расчёта: было %s − %s %s, стало %s − %s %s',
rec.amount, rec.discount_amount, rec.currency_code, v_amount, v_discount, p_currency)
where id = rec.id;
insert into fin_charges (id, request_hash, participant_id, retreat_id, kind, description,
quantity, unit_price, amount, discount_amount, currency_code,
discount_reason, creation_reason, created_by, agreed_with, occurred_on, resident_id)
values (gen_random_uuid(), md5(rec.id::text || ':' || p_currency || ':' || clock_timestamp()::text),
p_participant, p_retreat, rec.kind, rec.description,
rec.quantity, round(v_amount / rec.quantity, 2), v_amount, v_discount, p_currency,
rec.discount_reason,
coalesce(rec.creation_reason || ' · ', '') || format('переведено из %s %s по курсу ретрита', rec.amount - rec.discount_amount, rec.currency_code),
p_actor, rec.agreed_with, rec.occurred_on, rec.resident_id);
v_converted := v_converted + 1;
end loop;
if exists (select 1 from fin_charges
where participant_id = p_participant and retreat_id = p_retreat and not is_cancelled
and currency_code <> p_currency and creation_reason = 'crm_auto') then
v_sync := fin_sync_charges_from_crm(p_participant, p_retreat);
if not coalesce((v_sync->>'ok')::boolean, false) then
raise exception '%', coalesce(v_sync->'error'->>'code', 'internal_error')
using detail = 'Начисления из CRM: ' || coalesce(v_sync->'error'->>'message', 'не удалось пересобрать');
end if;
end if;
return jsonb_build_object('currency', p_currency, 'credits_created', v_credits,
'charges_converted', v_converted, 'crm_sync', v_sync->'result');
end;
$function$;

-- Вернуть привязку к визиту начислениям, переведённым в другую валюту раньше:
-- берём resident_id у отменённого оригинала (тот же гость, событие, вид, описание).
update fin_charges n
   set resident_id = o.resident_id
  from fin_charges o
 where o.participant_id = n.participant_id and o.retreat_id = n.retreat_id
   and o.is_cancelled and o.resident_id is not null and o.kind = n.kind
   and o.description is not distinct from n.description
   and o.cancelled_reason like 'Смена валюты расчёта%'
   and not n.is_cancelled and n.resident_id is null
   and n.creation_reason like '%переведено из%';
