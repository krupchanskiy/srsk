-- 591: своя дата заезда/выезда из сделки CRM → регистрация → кухня
--
-- Когда рейс не совпадает с приездом в ШРСК («Не совпадает с рейсом») или
-- рейса нет вовсе («Билеты не нужны»), менеджер вписывает в сделку свою дату
-- (stay_check_in / stay_check_out). Но crm_register_on_booked переносил в
-- регистрацию только рейс — и кухня (eating_detail читает регистрацию)
-- кормила человека по рейсу: на Сева-ретрите 8 человек уезжали из ШРСК 06.09
-- или 08.09, а числились до вылета 12–24.09 (ВГ, 29.09.2026).
--
-- В регистрации arrival/departure_datetime и так означают «приезд в ШРСК /
-- отъезд из ШРСК» (рейс хранится в guest_transfers), поэтому своя дата
-- пишется туда же, а eating_detail не меняется.
--
-- Правило выбора то же, что в crm_deal_dates_missing (590): при «Не совпадает
-- с рейсом» или «Билеты не нужны» — своя дата, если вписана; иначе рейс.
-- Ручные правки оргов по-прежнему не перетираем: заменяем только пустое или
-- то, что пришло из CRM (рейс либо прежняя своя дата).

create or replace function public.crm_register_on_booked()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_paid constant text[] := array['booked', 'checklist', 'ready', 'completed'];
  v_entering boolean;
  v_arr timestamptz;
  v_dep timestamptz;
  v_old_in timestamptz;
  v_old_out timestamptz;
begin
  if new.status <> all (v_paid) then return new; end if;
  if new.vaishnava_id is null or new.retreat_id is null then return new; end if;

  v_arr := case when (new.arrival_dates_status = 'custom' or new.checklist_tickets = 'not_needed')
                     and new.stay_check_in is not null
                then new.stay_check_in else new.arrival_datetime end;
  v_dep := case when (new.departure_dates_status = 'custom' or new.checklist_tickets = 'not_needed')
                     and new.stay_check_out is not null
                then new.stay_check_out else new.departure_datetime end;
  if tg_op = 'UPDATE' then
    v_old_in := old.stay_check_in;
    v_old_out := old.stay_check_out;
  end if;

  v_entering := (tg_op = 'INSERT') or (old.status <> all (v_paid));

  if v_entering then
    insert into retreat_registrations
           (retreat_id, vaishnava_id, status, meal_type,
            arrival_datetime, departure_datetime,
            registration_date, is_auto_created)
    values (new.retreat_id, new.vaishnava_id, 'guest',
            case when new.checklist_meals = 'self' then 'self' else 'prasad' end,
            v_arr, v_dep,
            current_date, true)
    on conflict (vaishnava_id, retreat_id) do update
       set is_deleted = false
     where retreat_registrations.is_deleted;
  end if;

  -- Даты появляются позже (на этапе чеклиста) — дозаполняем автосозданную
  -- регистрацию. Пустое поле или пришедшее из CRM (рейс / прежняя своя
  -- дата) — заменяем; ручную правку оргов не трогаем.
  update retreat_registrations rr
     set arrival_datetime = case
           when rr.arrival_datetime is null
             or rr.arrival_datetime = new.arrival_datetime
             or rr.arrival_datetime = v_old_in
           then coalesce(v_arr, rr.arrival_datetime) else rr.arrival_datetime end,
         departure_datetime = case
           when rr.departure_datetime is null
             or rr.departure_datetime = new.departure_datetime
             or rr.departure_datetime = v_old_out
           then coalesce(v_dep, rr.departure_datetime) else rr.departure_datetime end
   where rr.vaishnava_id = new.vaishnava_id
     and rr.retreat_id = new.retreat_id
     and rr.is_auto_created
     and ((v_arr is not null and rr.arrival_datetime is distinct from v_arr
           and (rr.arrival_datetime is null or rr.arrival_datetime = new.arrival_datetime
                or rr.arrival_datetime = v_old_in))
       or (v_dep is not null and rr.departure_datetime is distinct from v_dep
           and (rr.departure_datetime is null or rr.departure_datetime = new.departure_datetime
                or rr.departure_datetime = v_old_out)));

  return new;
end;
$function$;

-- Триггер слушал только статус и рейсы — своя дата, её статус и «Билеты не
-- нужны» до регистрации не доходили вовсе.
drop trigger if exists trg_crm_register_on_booked on public.crm_deals;
create trigger trg_crm_register_on_booked
  after insert or update of status, arrival_datetime, departure_datetime,
                            stay_check_in, stay_check_out,
                            arrival_dates_status, departure_dates_status, checklist_tickets
  on public.crm_deals
  for each row execute function crm_register_on_booked();

-- Разовая чистка: сделки, где своя дата уже вписана, а в регистрации лежит
-- рейс из CRM (на 29.09 — 8 выездов на Сева-ретрите, своих дат заезда нет).
update retreat_registrations rr
   set arrival_datetime = case
         when (d.arrival_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
              and d.stay_check_in is not null
              and (rr.arrival_datetime is null or rr.arrival_datetime = d.arrival_datetime)
         then d.stay_check_in else rr.arrival_datetime end,
       departure_datetime = case
         when (d.departure_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
              and d.stay_check_out is not null
              and (rr.departure_datetime is null or rr.departure_datetime = d.departure_datetime)
         then d.stay_check_out else rr.departure_datetime end
  from crm_deals d
 where d.vaishnava_id = rr.vaishnava_id
   and d.retreat_id = rr.retreat_id
   and d.status in ('booked', 'checklist', 'ready', 'completed')
   and rr.is_auto_created
   and not rr.is_deleted
   and (((d.arrival_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
         and d.stay_check_in is not null
         and rr.arrival_datetime is distinct from d.stay_check_in
         and (rr.arrival_datetime is null or rr.arrival_datetime = d.arrival_datetime))
     or ((d.departure_dates_status = 'custom' or d.checklist_tickets = 'not_needed')
         and d.stay_check_out is not null
         and rr.departure_datetime is distinct from d.stay_check_out
         and (rr.departure_datetime is null or rr.departure_datetime = d.departure_datetime)));
