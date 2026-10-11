-- 674: «Договорённость об оплате» — отдельный вид записи в сделке (crm_communications.type = 'payment_promise').
-- Сделку с долгом нельзя перевести в «Ретрит завершён», пока менеджер не связался с участником
-- и не записал договорённость после окончания ретрита (ВГ, 11.10).

-- Долг участника по сделке — из фин. журнала (как в «Участниках и оплатах»).
-- Менеджер CRM видит его без фин. прав: только итог, без операций.
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
begin
    select * into d from crm_deals where id = p_deal;
    if d.id is null or d.vaishnava_id is null or d.retreat_id is null then return null; end if;
    select end_date into v_end from retreats where id = d.retreat_id;
    b := fin_private_participant_balance_v2(d.vaishnava_id, d.retreat_id);
    return jsonb_build_object(
        'net', round(coalesce((b->>'net')::numeric, 0), 2),
        'currency', coalesce(b->>'currency', 'INR'),
        'retreat_end', v_end,
        -- свежая договорённость — записана после окончания ретрита
        'has_promise', exists (select 1 from crm_communications c
                                where c.deal_id = d.id and c.type = 'payment_promise'
                                  and (c.created_at at time zone 'Asia/Kolkata')::date >= coalesce(v_end, '1900-01-01'::date)));
end;
$function$;

revoke all on function public.crm_deal_debt(uuid) from public, anon;
grant execute on function public.crm_deal_debt(uuid) to authenticated;

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
begin
    if new.status is not distinct from old.status then return new; end if;

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

    -- Ребёнок (651): в «Готов» — только когда дата рождения проверена; прошедшие ретриты не трогаем
    if new.status = 'ready' and old.status in ('lead', 'working', 'invoiced', 'booked', 'checklist')
       and exists (select 1 from retreats r where r.id = new.retreat_id and r.end_date >= current_date) then
        v_child := crm_deal_child_issue(new);
        if v_child is not null then
            raise exception 'Нельзя перейти в «Готов»: ребёнок — %', v_child;
        end if;
    end if;

    -- Долг (674): закрыть сделку — только после записанной договорённости об оплате
    if new.status = 'completed' then
        v_debt := crm_deal_debt(new.id);
        if coalesce((v_debt->>'net')::numeric, 0) > 0.5
           and not coalesce((v_debt->>'has_promise')::boolean, false) then
            raise exception 'Нельзя закрыть сделку: у участника долг %. Свяжитесь с ним, напомните об оплате и запишите в сделке «Договорённость об оплате»',
                (case v_debt->>'currency' when 'INR' then '₹' when 'RUB' then '₽' when 'USD' then '$' when 'EUR' then '€' else (v_debt->>'currency') || ' ' end)
                    || replace(to_char(round((v_debt->>'net')::numeric), 'FM999G999G990'), ',', ' ')
                using hint = 'payment_promise_required';
        end if;
    end if;

    return new;
end;
$function$;
