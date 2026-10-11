-- 678: «Уехал с долгом» на канбане CRM, напоминания менеджеру по договорённости, аванс у уехавшего (ВГ, 11.10).
-- • crm_deal_departure — день отъезда: последний выезд в шахматке, иначе конец ретрита.
-- • crm_deals_after_departure — долг/аванс одной пачкой для канбана (только уехавшие).
-- • «Завершён» — только после отъезда.
-- • Договорённость об оплате → задача менеджеру «Проверить оплату» (срок: день после обещанной даты, без даты — через 7 дней);
--   долг закрыт — задача закрывается сама (cron каждые 15 минут).
-- • Решение по авансу — crm_communications.type 'advance_decision', content = keep | donate | refund.

create or replace function public.crm_deal_departure(p_vaishnava uuid, p_retreat uuid)
returns date
language sql
stable
security definer
set search_path to 'public'
as $function$
    select coalesce(
        (select max(rs.check_out) from residents rs
          where rs.vaishnava_id = p_vaishnava and rs.retreat_id = p_retreat and rs.status <> 'cancelled'),
        (select r.end_date from retreats r where r.id = p_retreat));
$function$;

revoke all on function public.crm_deal_departure(uuid, uuid) from public, anon;
grant execute on function public.crm_deal_departure(uuid, uuid) to authenticated;

-- Канбан: по уехавшим — долг/аванс из фин. журнала, последняя договорённость и решение по авансу
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
        select cd.id, cd.vaishnava_id, cd.retreat_id, r.end_date,
               crm_deal_departure(cd.vaishnava_id, cd.retreat_id) as dep
          from crm_deals cd
          join retreats r on r.id = cd.retreat_id
         where cd.id = any(p_deal_ids) and cd.vaishnava_id is not null
    ), d as materialized (
        -- баланс считаем только тем, кто уже уехал
        select * from d0 where d0.dep <= v_today
    )
    select d.id, d.dep,
           round(coalesce((b.b->>'net')::numeric, 0), 2),
           coalesce(b.b->>'currency', 'INR'),
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

revoke all on function public.crm_deals_after_departure(uuid[]) from public, anon;
grant execute on function public.crm_deals_after_departure(uuid[]) to authenticated;

-- «Завершён» — только когда человек уехал
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
                (case v_debt->>'currency' when 'INR' then '₹' when 'RUB' then '₽' when 'USD' then '$' when 'EUR' then '€' else (v_debt->>'currency') || ' ' end)
                    || replace(to_char(round((v_debt->>'net')::numeric), 'FM999G999G990'), ',', ' ')
                using hint = 'payment_promise_required';
        end if;
    end if;

    return new;
end;
$function$;

-- Договорённость (из сделки или из Финансов) → задача менеджеру сделки «Проверить оплату»
create or replace function public.crm_payment_promise_task()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    d record;
    v_debt jsonb;
    v_due date;
begin
    if new.type <> 'payment_promise' or new.deal_id is null then return new; end if;
    select cd.id, cd.manager_id,
           coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''), 'гость') as имя
      into d
      from crm_deals cd left join vaishnavas v on v.id = cd.vaishnava_id
     where cd.id = new.deal_id;
    v_debt := crm_deal_debt(new.deal_id);
    if coalesce((v_debt->>'net')::numeric, 0) <= 0.5 then return new; end if;

    -- Прежнее напоминание заменяется новым
    update crm_tasks set completed_at = now(), completion_comment = 'Записана новая договорённость'
     where deal_id = new.deal_id and completed_at is null and title like 'Проверить оплату%';

    v_due := coalesce(new.due_date + 1, (now() at time zone 'Asia/Kolkata')::date + 7);
    insert into crm_tasks (deal_id, assignee_id, title, description, due_date, priority, is_auto_created, created_by)
    values (new.deal_id, coalesce(d.manager_id, new.created_by),
            'Проверить оплату: ' || d.имя,
            'Договорённость: ' || coalesce(new.summary, '') ||
            case when new.due_date is not null then E'\nОбещал заплатить к ' || to_char(new.due_date, 'DD.MM.YYYY') || '.'
                 else E'\nСрок не назван — проверяем через неделю.' end ||
            E'\nПроверьте, пришли ли деньги. Если нет — свяжитесь и запишите новую договорённость в сделке. Когда долг закроется, задача закроется сама.',
            v_due, 'high', true, new.created_by);
    return new;
end;
$function$;

drop trigger if exists crm_payment_promise_task on public.crm_communications;
create trigger crm_payment_promise_task
    after insert on public.crm_communications
    for each row when (new.type = 'payment_promise')
    execute function public.crm_payment_promise_task();

-- Долг закрыт — напоминания закрываются сами
create or replace function public.crm_close_paid_debt_tasks()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_closed int;
begin
    update crm_tasks t set completed_at = now(), completion_comment = 'Долг закрыт — оплата пришла'
     where t.completed_at is null and t.title like 'Проверить оплату%' and t.deal_id is not null
       and coalesce((crm_deal_debt(t.deal_id)->>'net')::numeric, 0) <= 0.5;
    get diagnostics v_closed = row_count;
    return v_closed;
end;
$function$;

revoke all on function public.crm_close_paid_debt_tasks() from public, anon, authenticated;

select cron.schedule('crm-close-paid-debt-tasks', '*/15 * * * *', 'SELECT public.crm_close_paid_debt_tasks()');

-- Над канбаном — слова вместо ключей
insert into translations (key, ru, en, hi) values
  ('crm_deals_count', 'Сделок', 'Deals', 'सौदे'),
  ('crm_deals_open', 'не закрыто', 'open', 'खुले')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
