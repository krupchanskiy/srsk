-- Самостоятельное проживание: заезд и выезд по датам шахматки сами (ВГ 29.10.2026)
-- Без ретрита — заезд в день check_in и выезд после check_out автоматически.
-- С ретритом — заезд вручную (строка «Не заселены» ловит неприехавших), выезд автоматически.
-- Автозаезд помечается arrived_auto: «Не приехал / отказ» на нём по-прежнему работает.

alter table residents add column if not exists arrived_auto boolean not null default false;

create or replace function public.self_stay_auto_sync()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_in int; v_out int;
begin
  update residents
     set status = 'confirmed',
         arrived_at = least(now(), (check_in + time '12:00') at time zone 'Asia/Kolkata'),
         arrived_auto = true
   where room_id is null and retreat_id is null
     and status in ('confirmed', 'booked') and arrived_at is null
     and check_in <= v_today;
  get diagnostics v_in = row_count;

  -- даты не трогаем: выезд по шахматке, только статус
  update residents
     set status = 'checked_out'
   where room_id is null
     and status = 'confirmed' and arrived_at is not null
     and check_out < v_today;
  get diagnostics v_out = row_count;

  return jsonb_build_object('checked_in', v_in, 'checked_out', v_out);
end;
$function$;

revoke all on function public.self_stay_auto_sync() from public, anon, authenticated;

-- «Не приехал» и после автозаезда/автовыезда — отметку ставил не человек
create or replace function public.resident_no_show(p_resident_id uuid, p_reason_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r residents%rowtype;
  v_reason uuid := p_reason_id;
  v_line text;
  v_reg_cancelled boolean := false;
  v_deals int := 0;
begin
  if not has_permission(auth.uid(), 'edit_timeline') then
    raise exception 'forbidden' using detail = 'Нет права менять шахматку';
  end if;

  select * into r from residents where id = p_resident_id for update;
  if not found then
    raise exception 'not_found' using detail = 'Бронь не найдена';
  end if;
  if not (r.arrived_auto and r.status in ('confirmed', 'checked_out'))
     and (r.arrived_at is not null or r.status not in ('confirmed', 'booked')) then
    raise exception 'invalid_state' using detail = 'Заезд уже отмечен или бронь снята';
  end if;

  if v_reason is null then
    select id into v_reason from crm_cancellation_reasons where code = 'no_show';
  end if;
  v_line := 'Не приехал ' || to_char(current_date, 'DD.MM.YYYY')
         || coalesce(': ' || (select name_ru from crm_cancellation_reasons where id = v_reason and code <> 'no_show'), '')
         || coalesce(': ' || nullif(trim(p_note), ''), '');

  update residents
     set status = 'cancelled',
         notes = concat_ws(E'\n', nullif(notes, ''), v_line)
   where id = r.id;

  if r.booking_id is not null
     and not exists (select 1 from residents x where x.booking_id = r.booking_id and x.status <> 'cancelled') then
    update bookings set status = 'cancelled' where id = r.booking_id;
  end if;

  if r.vaishnava_id is not null and r.retreat_id is not null then
    if not exists (select 1 from residents x
                    where x.vaishnava_id = r.vaishnava_id and x.retreat_id = r.retreat_id
                      and x.id <> r.id and x.status <> 'cancelled') then
      update retreat_registrations
         set status = 'cancelled',
             org_notes = concat_ws(E'\n', nullif(org_notes, ''), v_line)
       where vaishnava_id = r.vaishnava_id and retreat_id = r.retreat_id
         and not is_deleted and status <> 'cancelled';
      v_reg_cancelled := found;

      update crm_deals
         set status = 'cancelled',
             cancellation_reason_id = v_reason,
             cancellation_note = coalesce(nullif(trim(p_note), ''), cancellation_note)
       where vaishnava_id = r.vaishnava_id and retreat_id = r.retreat_id
         and status not in ('cancelled', 'completed');
      get diagnostics v_deals = row_count;
    end if;
  end if;

  return jsonb_build_object('registration_cancelled', v_reg_cancelled, 'deals_cancelled', v_deals);
end;
$function$;

-- 00:30 по Индии
select cron.schedule('self-stay-auto-sync', '0 19 * * *', 'SELECT public.self_stay_auto_sync()');
