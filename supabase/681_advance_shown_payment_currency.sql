-- 681: аванс в валюте, в которой человек платил (ВГ, 11.10: Нава-нари, Сева-ретрит — €100 PayPal, в журнале ₹9 200).
-- Как debt_shown (679), только для переплаты: CRM показывает и решает в валюте платежа, журнал Сева не трогаем.
-- При переносе (fin_advance_move) получатель — в этой валюте: in_amount/in_currency; с Сева списывается ₹.

alter table public.crm_deals
    add column if not exists advance_shown_amount numeric,
    add column if not exists advance_shown_currency text;

comment on column public.crm_deals.advance_shown_amount is
    'Аванс в валюте платежа для CRM вместо пересчёта журнала (ставится вручную); действует, пока аванс в журнале не разошёлся';

alter table public.crm_deals drop constraint if exists crm_deals_advance_shown_check;
alter table public.crm_deals add constraint crm_deals_advance_shown_check
    check ((advance_shown_amount is null) = (advance_shown_currency is null)
           and (advance_shown_currency is null or advance_shown_currency in ('INR', 'RUB', 'USD', 'EUR')));

create or replace function public.crm_deals_after_departure(p_deal_ids uuid[])
returns table(deal_id uuid, departed_on date, net numeric, currency text,
              promise_at timestamptz, promise_due date,
              advance_decision text, advance_note text, advance_decided_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
    if not is_staff(auth.uid()) then
        raise exception 'forbidden';
    end if;
    return query
    with d0 as (
        select cd.id, cd.vaishnava_id, cd.retreat_id, r.end_date, cd.debt_shown_amount, cd.debt_shown_currency, cd.advance_shown_amount, cd.advance_shown_currency,
               crm_deal_departure(cd.vaishnava_id, cd.retreat_id) as dep
          from crm_deals cd
          join retreats r on r.id = cd.retreat_id
         where cd.id = any(p_deal_ids) and cd.vaishnava_id is not null
    ), d as materialized (
        -- баланс считаем только тем, кто уже уехал
        select * from d0 where d0.dep <= v_today
    )
    select d.id, d.dep,
           -- долг, записанный вручную (679), показываем вместо пересчёта журнала, пока долг не закрыт
           case when coalesce((b.b->>'net')::numeric, 0) > 0.5 and d.debt_shown_amount is not null
                then d.debt_shown_amount
                -- аванс в валюте, в которой человек платил (681), — пока аванс в журнале не разошёлся
                when coalesce((b.b->>'net')::numeric, 0) < -0.5 and d.advance_shown_amount is not null
                then -d.advance_shown_amount
                else round(coalesce((b.b->>'net')::numeric, 0), 2) end,
           case when coalesce((b.b->>'net')::numeric, 0) > 0.5 and d.debt_shown_amount is not null
                then d.debt_shown_currency
                when coalesce((b.b->>'net')::numeric, 0) < -0.5 and d.advance_shown_amount is not null
                then d.advance_shown_currency
                else coalesce(b.b->>'currency', 'INR') end,
           pr.created_at, pr.due_date,
           ad.content, ad.summary, ad.created_at
      from d
      cross join lateral (select fin_private_participant_balance_v2(d.vaishnava_id, d.retreat_id) as b) b
      left join lateral (
          select c.created_at, c.due_date from crm_communications c
           where c.deal_id = d.id and c.type = 'payment_promise'
             and (c.created_at at time zone 'Asia/Kolkata')::date >= coalesce(d.end_date, '1900-01-01'::date)
           order by c.created_at desc limit 1) pr on true
      left join lateral (
          select c.content, c.summary, c.created_at from crm_communications c
           where c.deal_id = d.id and c.type = 'advance_decision'
           order by c.created_at desc limit 1) ad on true;
end;
$function$;



create or replace function public.fin_advance_move(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid; v_request_id uuid; v_participant uuid; v_from uuid; v_to uuid; v_amount numeric;
  v_container uuid := fin_private_deposit_retreat();
  v_b jsonb; v_cur text; v_in_amount numeric; v_in_cur text; v_есть numeric; v_from_name text; v_to_name text; v_detail text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'participant_id', 'from_retreat_id', 'to_retreat_id', 'amount', 'in_amount', 'in_currency']);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_from        := fin_private_get_uuid(payload, 'from_retreat_id', true);
  v_to          := coalesce(fin_private_get_uuid(payload, 'to_retreat_id', false), v_container);
  v_amount      := fin_private_get_money(payload, 'amount', true);
  -- (681) получатель — в валюте, в которой человек платил (Сева-ретрит считал всё в ₹)
  v_in_amount   := fin_private_get_money(payload, 'in_amount', false);
  v_in_cur      := upper(nullif(trim(coalesce(payload->>'in_currency', '')), ''));
  if (v_in_amount is null) <> (v_in_cur is null) or (v_in_cur is not null and v_in_cur not in ('INR', 'RUB', 'USD', 'EUR')) then
    raise exception 'invalid_payload' using detail = 'in_amount и in_currency — вместе, валюта INR/RUB/USD/EUR';
  end if;

  -- повтор той же команды — тот же ответ
  if exists (select 1 from fin_participant_opening_balances where id = fin_private_child_uuid(v_request_id, 'out')) then
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount), 'warnings', '[]'::jsonb);
  end if;

  select coalesce(name_ru, name_en) into v_from_name from retreats where id = v_from and not is_system;
  if v_from_name is null then
    raise exception 'invalid_payload' using detail = 'Исходный ретрит не найден';
  end if;
  if v_to = v_from then
    raise exception 'invalid_payload' using detail = 'Аванс уже на этом ретрите';
  end if;
  if v_to <> v_container then
    select coalesce(name_ru, name_en) into v_to_name from retreats where id = v_to and not is_system;
    if v_to_name is null then
      raise exception 'invalid_payload' using detail = 'Ретрит не найден';
    end if;
  end if;

  v_b := fin_private_participant_balance_v2(v_participant, v_from);
  v_cur := coalesce(v_b->>'currency', 'INR');
  v_есть := -coalesce((v_b->>'net')::numeric, 0);
  if v_есть <= 0.005 then
    raise exception 'no_advance' using detail = 'На этом ретрите у человека нет аванса';
  end if;
  if v_amount <= 0 or v_amount > v_есть + 0.005 then
    raise exception 'invalid_payload'
      using detail = format('Аванс %s — перенести можно не больше', fin_fmt_money(v_есть, v_cur));
  end if;

  insert into fin_participant_opening_balances (id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
                                                source_document, request_hash, comment, created_by)
  values (fin_private_child_uuid(v_request_id, 'out'), v_participant, v_from, v_amount, v_cur, 'debt', 'general',
          'Аванс перенесён',
          fin_private_hash(jsonb_build_object('command', 'advance_move_out', 'request_id', lower(v_request_id::text))),
          case when v_to = v_container then 'Аванс оставлен на балансе гостя (без ретрита)'
               else format('Аванс перенесён на «%s»', v_to_name) end, v_actor),
         (fin_private_child_uuid(v_request_id, 'in'), v_participant, v_to, coalesce(v_in_amount, v_amount), coalesce(v_in_cur, v_cur), 'credit', 'general',
          'Аванс перенесён',
          fin_private_hash(jsonb_build_object('command', 'advance_move_in', 'request_id', lower(v_request_id::text))),
          format('Аванс с «%s»: %s', v_from_name, fin_fmt_money(coalesce(v_in_amount, v_amount), coalesce(v_in_cur, v_cur))), v_actor);

  perform crm_apply_deal_totals(cd.id) from crm_deals cd
    where cd.vaishnava_id = v_participant and cd.retreat_id in (v_from, v_to);

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount, 'currency', v_cur), 'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;


-- Нава-нари дд, Сева-ретрит: заплатила €100 через PayPal (25.03), в журнале ₹9 200
update public.crm_deals set advance_shown_amount = 100, advance_shown_currency = 'EUR'
 where id = 'a8201ae4-9565-41b6-b861-ec53a3f172a1';
