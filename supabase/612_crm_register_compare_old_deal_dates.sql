-- 612: даты сделки → регистрация: сравнивать регистрацию со СТАРОЙ датой сделки, а не с новой.
--
-- Ошибка миграции 591: условие «регистрацию ещё никто не правил руками» проверяло
-- rr.arrival_datetime = new.arrival_datetime. Если регистрация совпадала со сделкой,
-- а менеджер поменял дату в сделке, новая дата в регистрацию не попадала
-- (регистрация равна старой дате, а не новой). То же для отъезда.
-- Регистрация — источник дат для кухни (eating_detail) и для «Сам организует».
--
-- Теперь регистрация обновляется, если в ней было пусто, старая дата рейса сделки
-- (old.arrival/departure_datetime) или старая своя дата (old.stay_check_in/out).
-- Ручная правка регистрации по-прежнему не перетирается. При INSERT old нет — null.
--
-- Плюс разовая подтяжка двух регистраций Лила-киртан-ретрита 2027, отставших
-- из-за этой ошибки (в сделке поправлено время рейса, в регистрации осталось старое).

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
  v_old_arr timestamptz;
  v_old_dep timestamptz;
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
  -- Старые даты сделки: регистрация, равная им, считается «не тронутой руками»
  if tg_op = 'UPDATE' then
    v_old_arr := old.arrival_datetime;
    v_old_dep := old.departure_datetime;
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

  update retreat_registrations rr
     set arrival_datetime = case
           when rr.arrival_datetime is null
             or rr.arrival_datetime = v_old_arr
             or rr.arrival_datetime = v_old_in
           then coalesce(v_arr, rr.arrival_datetime) else rr.arrival_datetime end,
         departure_datetime = case
           when rr.departure_datetime is null
             or rr.departure_datetime = v_old_dep
             or rr.departure_datetime = v_old_out
           then coalesce(v_dep, rr.departure_datetime) else rr.departure_datetime end
   where rr.vaishnava_id = new.vaishnava_id
     and rr.retreat_id = new.retreat_id
     and rr.is_auto_created
     and ((v_arr is not null and rr.arrival_datetime is distinct from v_arr
           and (rr.arrival_datetime is null or rr.arrival_datetime = v_old_arr
                or rr.arrival_datetime = v_old_in))
       or (v_dep is not null and rr.departure_datetime is distinct from v_dep
           and (rr.departure_datetime is null or rr.departure_datetime = v_old_dep
                or rr.departure_datetime = v_old_out)));

  return new;
end;
$function$;

-- Разовая подтяжка: Амита Рай дд и Арадхита дд (Лила-киртан-ретрит 2027),
-- только если регистрация всё ещё на старом времени рейса.
update retreat_registrations rr
   set arrival_datetime = '2027-03-07 11:10+00'
 where rr.is_auto_created and not rr.is_deleted
   and rr.arrival_datetime = '2027-03-07 11:01+00'
   and (rr.vaishnava_id, rr.retreat_id) in (
         select vaishnava_id, retreat_id from crm_deals
          where id in ('e94aa247-117a-424b-8060-a2366c954677', '1403ac77-03f4-4ecd-a105-e51e1620b2e3'));

update retreat_registrations rr
   set departure_datetime = '2027-03-19 17:50+00'
 where rr.is_auto_created and not rr.is_deleted
   and rr.departure_datetime = '2027-03-19 17:05+00'
   and (rr.vaishnava_id, rr.retreat_id) in (
         select vaishnava_id, retreat_id from crm_deals
          where id in ('e94aa247-117a-424b-8060-a2366c954677', '1403ac77-03f4-4ecd-a105-e51e1620b2e3'));
