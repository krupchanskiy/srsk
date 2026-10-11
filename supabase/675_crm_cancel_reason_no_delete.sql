-- 675: (1) «Отказ» — только с причиной из crm_cancellation_reasons (для «Другое» — с комментарием);
-- (2) сделку удалить нельзя — она хранит историю человека: платежи, переписку, отказ (ВГ, 11.10).
-- Разовая чистка настоящей ошибки: в той же транзакции set_config('app.allow_deal_delete', 'on', true).

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

    -- Отказ (675): только с причиной из справочника; для «Другое» — с комментарием
    if new.status = 'cancelled' then
        if new.cancellation_reason_id is null and coalesce(new.cancellation_reason, '') = '' then
            raise exception 'Нельзя перевести в «Отказ» без причины — выберите причину отказа'
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

create or replace function public.crm_deal_block_delete()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
    if coalesce(current_setting('app.allow_deal_delete', true), '') <> 'on' then
        raise exception 'Сделку удалить нельзя: в ней история человека — платежи, переписка, отказ. Переведите её в «Отказ» — через 2 недели после ретрита она уйдёт с доски';
    end if;
    return old;
end;
$function$;

drop trigger if exists trg_crm_deal_block_delete on public.crm_deals;
create trigger trg_crm_deal_block_delete before delete on public.crm_deals
    for each row execute function public.crm_deal_block_delete();
