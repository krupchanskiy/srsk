-- 679: долг, записанный вручную, для показа в CRM (ВГ, 11.10: Сварупананда, Сева-ретрит — «должен $90»).
-- Журнал Сева не трогаем (архив, ₹7 875 по старому пересчёту), а менеджер видит сумму, о которой договорились.
-- Показывается, только пока долг в журнале не закрыт; проверки (>0.5, закрытие задач) идут по журналу.

alter table public.crm_deals
    add column if not exists debt_shown_amount numeric,
    add column if not exists debt_shown_currency text;

comment on column public.crm_deals.debt_shown_amount is
    'Сумма долга для показа в CRM вместо пересчёта журнала (ставится вручную); действует, пока долг в журнале > 0';

alter table public.crm_deals drop constraint if exists crm_deals_debt_shown_check;
alter table public.crm_deals add constraint crm_deals_debt_shown_check
    check ((debt_shown_amount is null) = (debt_shown_currency is null)
           and (debt_shown_currency is null or debt_shown_currency in ('INR', 'RUB', 'USD', 'EUR')));

create or replace function public.crm_deal_debt(p_deal uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    d crm_deals%rowtype;
    v_end date;
    b jsonb;
    v_net numeric;
    v_cur text;
    v_manual boolean;
begin
    select * into d from crm_deals where id = p_deal;
    if d.id is null or d.vaishnava_id is null or d.retreat_id is null then return null; end if;
    select end_date into v_end from retreats where id = d.retreat_id;
    b := fin_private_participant_balance_v2(d.vaishnava_id, d.retreat_id);
    v_net := round(coalesce((b->>'net')::numeric, 0), 2);
    v_cur := coalesce(b->>'currency', 'INR');
    v_manual := v_net > 0.5 and d.debt_shown_amount is not null;
    return jsonb_build_object(
        'net', v_net,
        'currency', v_cur,
        -- что показывать менеджеру (679): ручная сумма, пока долг в журнале не закрыт
        'shown_net', case when v_manual then d.debt_shown_amount else v_net end,
        'shown_currency', case when v_manual then d.debt_shown_currency else v_cur end,
        'retreat_end', v_end,
        'has_promise', exists (select 1 from crm_communications c
                                where c.deal_id = d.id and c.type = 'payment_promise'
                                  and (c.created_at at time zone 'Asia/Kolkata')::date >= coalesce(v_end, '1900-01-01'::date)));
end;
$function$;

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
        select cd.id, cd.vaishnava_id, cd.retreat_id, r.end_date, cd.debt_shown_amount, cd.debt_shown_currency,
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
                then d.debt_shown_amount else round(coalesce((b.b->>'net')::numeric, 0), 2) end,
           case when coalesce((b.b->>'net')::numeric, 0) > 0.5 and d.debt_shown_amount is not null
                then d.debt_shown_currency else coalesce(b.b->>'currency', 'INR') end,
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


create or replace function public.crm_guard_status_transition()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_missing text[];
    v_child text;
    v_debt jsonb;
    v_dep date;
begin
    if new.status is not distinct from old.status then return new; end if;

    -- Отказ (675): только с причиной из справочника; для «Другое» — с комментарием
    if new.status = 'cancelled' then
        if new.cancellation_reason_id is null and coalesce(new.cancellation_reason, '') = '' then
            raise exception 'Нельзя перевести в «Отменён» без причины — выберите причину отказа'
                using hint = 'cancel_reason_required';
        end if;
        if exists (select 1 from crm_cancellation_reasons cr where cr.id = new.cancellation_reason_id and cr.code = 'other')
           and coalesce(trim(new.cancellation_note), '') = '' then
            raise exception 'Для причины «Другое» напишите комментарий — почему отказался'
                using hint = 'cancel_reason_required';
        end if;
    end if;

    if old.status = 'working' and new.status = 'invoiced' then
        if coalesce(new.checklist_accommodation, 'unknown') = 'unknown'
           or coalesce(new.checklist_meals, 'unknown') = 'unknown' then
            raise exception 'Нельзя выставить счёт: заполните в чек-листе %', concat_ws(' и ',
                case when coalesce(new.checklist_accommodation, 'unknown') = 'unknown' then 'проживание' end,
                case when coalesce(new.checklist_meals, 'unknown') = 'unknown' then 'питание' end);
        end if;
    end if;

    if new.status in ('checklist', 'ready', 'completed')
       and old.status in ('lead', 'working', 'invoiced', 'booked') then
        if new.arrival_dates_status = 'unconfirmed' or new.departure_dates_status = 'unconfirmed' then
            raise exception 'Нельзя перейти дальше: даты % не уточнены — подтвердите статус дат в чек-листе сделки', concat_ws(' и ',
                case when new.arrival_dates_status = 'unconfirmed' then 'заезда' end,
                case when new.departure_dates_status = 'unconfirmed' then 'выезда' end);
        end if;
        v_missing := crm_deal_dates_missing(new);
        if cardinality(v_missing) > 0 then
            raise exception 'Нельзя перейти дальше: нет даты % — впишите рейс или дату %в ШРСК в чек-листе сделки',
                array_to_string(v_missing, ' и '),
                case when new.checklist_accommodation = 'self' then '(ест с нами) ' else '' end;
        end if;
    end if;

    if new.status = 'ready' and old.status in ('lead', 'working', 'invoiced', 'booked', 'checklist')
       and exists (select 1 from retreats r where r.id = new.retreat_id and r.end_date >= current_date) then
        v_child := crm_deal_child_issue(new);
        if v_child is not null then
            raise exception 'Нельзя перейти в «Готов»: ребёнок — %', v_child;
        end if;
    end if;

    if new.status = 'completed' then
        -- Отъезд (678): завершать — только когда человек уехал (выезд в шахматке, иначе конец ретрита)
        v_dep := crm_deal_departure(new.vaishnava_id, new.retreat_id);
        if v_dep > (now() at time zone 'Asia/Kolkata')::date then
            raise exception 'Нельзя перевести в «Завершён»: участник ещё не уехал — выезд %', to_char(v_dep, 'DD.MM.YYYY')
                using hint = 'not_departed';
        end if;

        v_debt := crm_deal_debt(new.id);
        if coalesce((v_debt->>'net')::numeric, 0) > 0.5
           and not coalesce((v_debt->>'has_promise')::boolean, false) then
            raise exception 'Нельзя перевести в «Завершён»: у участника долг %. Свяжитесь с ним, напомните об оплате и запишите в сделке «Договорённость об оплате»',
                (case v_debt->>'shown_currency' when 'INR' then '₹' when 'RUB' then '₽' when 'USD' then '$' when 'EUR' then '€' else (v_debt->>'shown_currency') || ' ' end)
                    || replace(to_char(round((v_debt->>'shown_net')::numeric), 'FM999G999G990'), ',', ' ')
                using hint = 'payment_promise_required';
        end if;
    end if;

    return new;
end;
$function$;


-- Сварупананда дас, Сева-ретрит: должен $90 (ВГ, 11.10)
update public.crm_deals set debt_shown_amount = 90, debt_shown_currency = 'USD'
 where id = '63e6ef9a-eea8-492a-a1e9-d34cb6d69644';
