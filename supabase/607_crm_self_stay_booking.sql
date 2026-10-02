-- 607: сделка CRM «Сам организует» → бронь без номера в шахматке (решение ВГ 02.10.2026, вариант А).
-- Раньше такие люди были в блоке «Самостоятельное проживание» только отражением сделки (строка «CRM»):
-- ни брони, ни «Заселить», ни плашки «Не заселены». Теперь бронь создаётся сама, когда сделка в оплаченной
-- стадии (booked … completed) и известны даты; даты следуют за регистрацией (туда их пишет crm_register_on_booked).
-- Заезд руками, как везде в шахматке. Сделка отменена или «Сам организует» снято — бронь убирается,
-- если заезд ещё не отмечен. Прошедшие ретриты не трогаем: цифры кухни задним числом не меняются.

create or replace function public.crm_self_stay_sync(p_vaishnava uuid, p_retreat uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    c_marker constant text := 'Из CRM: «Сам организует»';
    v_deal crm_deals%rowtype;
    v_ret retreats%rowtype;
    v_reg retreat_registrations%rowtype;
    v_res residents%rowtype;
    v_want boolean;
    v_in date;
    v_out date;
begin
    if p_vaishnava is null or p_retreat is null then return; end if;
    select * into v_ret from retreats where id = p_retreat;
    if v_ret.id is null or v_ret.end_date < current_date then return; end if;

    -- уже в номере или прожил — шахматку ведут люди, не трогаем
    if exists (select 1 from residents r
                where r.vaishnava_id = p_vaishnava and r.retreat_id = p_retreat
                  and r.status <> 'cancelled'
                  and (r.room_id is not null or r.status = 'checked_out')) then
        return;
    end if;

    select * into v_deal from crm_deals d
     where d.vaishnava_id = p_vaishnava and d.retreat_id = p_retreat and d.status <> 'cancelled'
     order by (d.status in ('booked', 'checklist', 'ready', 'completed')) desc, d.updated_at desc
     limit 1;
    select * into v_reg from retreat_registrations rr
     where rr.vaishnava_id = p_vaishnava and rr.retreat_id = p_retreat
       and not rr.is_deleted and rr.status not in ('cancelled', 'rejected')
     limit 1;

    -- без дат бронь не ставим: остаётся строка «CRM», кухня его так же не считает (eating_detail)
    v_want := v_deal.id is not null
          and v_deal.status in ('booked', 'checklist', 'ready', 'completed')
          and v_deal.checklist_accommodation = 'self'
          and v_reg.id is not null
          and cardinality(crm_deal_dates_missing(v_deal)) = 0;

    -- даты: регистрация → рейс → даты ретрита (TIMESTAMPTZ хранит местное время как UTC)
    if v_want then
        v_in := coalesce((v_reg.arrival_datetime at time zone 'UTC')::date,
                         (select (gt.flight_datetime at time zone 'UTC')::date from guest_transfers gt
                           where gt.registration_id = v_reg.id and gt.direction = 'arrival' limit 1),
                         v_ret.start_date);
        v_out := coalesce((v_reg.departure_datetime at time zone 'UTC')::date,
                          (select (gt.flight_datetime at time zone 'UTC')::date from guest_transfers gt
                            where gt.registration_id = v_reg.id and gt.direction = 'departure' limit 1),
                          v_ret.end_date);
        if v_out < v_in then v_out := v_in; end if;
    end if;

    select * into v_res from residents r
     where r.vaishnava_id = p_vaishnava and r.retreat_id = p_retreat
       and r.room_id is null and r.status in ('confirmed', 'booked')
     order by r.created_at
     limit 1;

    if v_want then
        if v_res.id is null then
            insert into residents (room_id, vaishnava_id, retreat_id, check_in, check_out, status,
                                   category_id, has_housing, has_meals, meal_type, breakfast, lunch, notes)
            values (null, p_vaishnava, p_retreat, v_in, v_out, 'confirmed',
                    case v_reg.status
                        when 'team' then '10c4c929-6aaf-4b73-a15a-b7c5ab70f64b'::uuid
                        when 'volunteer' then 'cdb7a43e-51a8-47cd-ac97-c6fdf4fccd5e'::uuid
                        when 'vip' then 'ab57efc9-504a-4a31-93e6-6de8daa46bb7'::uuid
                        else '6ad3bfdd-cb95-453a-b589-986717615736'::uuid end,
                    false, v_reg.meal_type in ('prasad', 'child'), coalesce(v_reg.meal_type, 'prasad'),
                    true, true, c_marker);
        elsif v_res.arrived_at is null then
            update residents set check_in = v_in, check_out = v_out
             where id = v_res.id and (check_in is distinct from v_in or check_out is distinct from v_out);
        else
            -- уже заехал: начало — факт, следуем только за выездом
            update residents set check_out = v_out
             where id = v_res.id and check_out is distinct from v_out and v_out >= check_in;
        end if;
    elsif v_res.id is not null and v_res.arrived_at is null and v_res.booking_id is null
          and v_res.notes = c_marker then
        delete from residents where id = v_res.id;
    end if;
end;
$function$;

-- Сделка: стадия, «Сам организует», питание, даты, человек/ретрит
create or replace function public.trg_crm_self_stay_from_deal()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    perform crm_self_stay_sync(new.vaishnava_id, new.retreat_id);
    if tg_op = 'UPDATE' and (old.vaishnava_id is distinct from new.vaishnava_id
                             or old.retreat_id is distinct from new.retreat_id) then
        perform crm_self_stay_sync(old.vaishnava_id, old.retreat_id);
    end if;
    return new;
end;
$function$;

-- Имя «trg_crm_self…» идёт после «trg_crm_register_on_booked»: регистрация к этому моменту уже есть
drop trigger if exists trg_crm_self_stay_sync on public.crm_deals;
create trigger trg_crm_self_stay_sync
    after insert or update of status, checklist_accommodation, checklist_meals, checklist_tickets,
        arrival_datetime, departure_datetime, stay_check_in, stay_check_out,
        arrival_dates_status, departure_dates_status, vaishnava_id, retreat_id
    on public.crm_deals
    for each row execute function trg_crm_self_stay_from_deal();

-- Регистрация: даты, питание, статус (правят и на странице предварительного расселения)
create or replace function public.trg_crm_self_stay_from_registration()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    if exists (select 1 from crm_deals d where d.vaishnava_id = new.vaishnava_id
                 and d.retreat_id = new.retreat_id and d.checklist_accommodation = 'self') then
        perform crm_self_stay_sync(new.vaishnava_id, new.retreat_id);
    end if;
    return new;
end;
$function$;

drop trigger if exists trg_crm_self_stay_sync on public.retreat_registrations;
create trigger trg_crm_self_stay_sync
    after update of arrival_datetime, departure_datetime, meal_type, status, is_deleted
    on public.retreat_registrations
    for each row execute function trg_crm_self_stay_from_registration();

-- Рейс — запасной источник дат, если в регистрации их нет
create or replace function public.trg_crm_self_stay_from_transfer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_reg retreat_registrations%rowtype;
begin
    if new.direction not in ('arrival', 'departure') then return new; end if;
    select * into v_reg from retreat_registrations where id = new.registration_id;
    if v_reg.id is not null and exists (select 1 from crm_deals d where d.vaishnava_id = v_reg.vaishnava_id
                 and d.retreat_id = v_reg.retreat_id and d.checklist_accommodation = 'self') then
        perform crm_self_stay_sync(v_reg.vaishnava_id, v_reg.retreat_id);
    end if;
    return new;
end;
$function$;

drop trigger if exists trg_crm_self_stay_sync on public.guest_transfers;
create trigger trg_crm_self_stay_sync
    after insert or update of flight_datetime
    on public.guest_transfers
    for each row execute function trg_crm_self_stay_from_transfer();

revoke all on function public.crm_self_stay_sync(uuid, uuid) from public, anon, authenticated;

-- Разово: идущие и будущие ретриты (прошедшие функция пропускает сама)
select crm_self_stay_sync(d.vaishnava_id, d.retreat_id)
  from (select distinct vaishnava_id, retreat_id from crm_deals
         where checklist_accommodation = 'self' and status <> 'cancelled'
           and vaishnava_id is not null and retreat_id is not null) d;
