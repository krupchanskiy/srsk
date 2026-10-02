-- Защита от неверных дат (ВГ 02.10.2026, после опечатки «2028» у Намы Чинтамани Прии на фестиваль 2026).
-- Три уровня: в даты ретрита ±3 дня — молча; раньше/позже — предупреждение с подтверждением в форме
-- (это в JS, js/date-guard.js); невозможное — запрет здесь, для всех мест ввода сразу:
--   приезд/прилёт позже конца ретрита, отъезд/вылет раньше начала, отъезд раньше приезда.
-- Внутренние ретриты (художники) не проверяются: люди приезжают и после плановой даты.
-- Проверяется только изменённая дата — старые записи с ошибками не мешают править другие поля.

create or replace function retreat_date_guard(p_retreat uuid, p_arr timestamptz, p_dep timestamptz, p_what text)
returns void language plpgsql stable security definer set search_path = public as $$
declare
    r retreats;
    v_range text;
    fmt constant text := 'DD.MM.YYYY';
begin
    if p_arr is not null and p_dep is not null and p_dep < p_arr then
        raise exception 'Проверьте даты (%): отъезд % раньше приезда %', p_what,
            to_char(p_dep, fmt), to_char(p_arr, fmt) using errcode = 'check_violation';
    end if;
    if p_retreat is null then return; end if;
    select * into r from retreats where id = p_retreat;
    if r.id is null or r.start_date < '2001-01-01' or retreat_is_internal(r.id) then return; end if;
    v_range := to_char(r.start_date, fmt) || '–' || to_char(r.end_date, fmt);
    -- даты хранятся как местное время с меткой UTC — дата берётся без сдвига
    if p_arr is not null and (p_arr at time zone 'UTC')::date > r.end_date then
        raise exception 'Проверьте месяц и год (%): приезд % — после окончания ретрита «%» (%)', p_what,
            to_char(p_arr at time zone 'UTC', fmt), r.name_ru, v_range using errcode = 'check_violation';
    end if;
    if p_dep is not null and (p_dep at time zone 'UTC')::date < r.start_date then
        raise exception 'Проверьте месяц и год (%): отъезд % — до начала ретрита «%» (%)', p_what,
            to_char(p_dep at time zone 'UTC', fmt), r.name_ru, v_range using errcode = 'check_violation';
    end if;
end $$;

-- Регистрация: индивидуальные дата приезда и отъезда
create or replace function trg_registration_date_guard() returns trigger
language plpgsql set search_path = public as $$
begin
    if tg_op = 'INSERT'
       or new.arrival_datetime is distinct from old.arrival_datetime
       or new.departure_datetime is distinct from old.departure_datetime
       or new.retreat_id is distinct from old.retreat_id then
        perform retreat_date_guard(new.retreat_id,
            case when tg_op = 'INSERT' or new.arrival_datetime is distinct from old.arrival_datetime
                      or new.retreat_id is distinct from old.retreat_id then new.arrival_datetime end,
            case when tg_op = 'INSERT' or new.departure_datetime is distinct from old.departure_datetime
                      or new.retreat_id is distinct from old.retreat_id then new.departure_datetime end,
            'регистрация');
        -- отъезд раньше приезда — даже если поменяли только одну из дат
        if new.arrival_datetime is not null and new.departure_datetime is not null
           and new.departure_datetime < new.arrival_datetime then
            perform retreat_date_guard(null, new.arrival_datetime, new.departure_datetime, 'регистрация');
        end if;
    end if;
    return new;
end $$;
drop trigger if exists trg_registration_date_guard on retreat_registrations;
create trigger trg_registration_date_guard before insert or update of arrival_datetime, departure_datetime, retreat_id
    on retreat_registrations for each row execute function trg_registration_date_guard();

-- Трансферы: рейс прилёта / вылета, дорога на ретрит и с ретрита
create or replace function trg_transfer_date_guard() returns trigger
language plpgsql set search_path = public as $$
declare v_retreat uuid;
begin
    if new.flight_datetime is null then return new; end if;
    if tg_op = 'UPDATE' and new.flight_datetime is not distinct from old.flight_datetime
       and new.direction is not distinct from old.direction then return new; end if;
    select retreat_id into v_retreat from retreat_registrations where id = new.registration_id;
    if new.direction in ('arrival', 'arrival_retreat') then
        perform retreat_date_guard(v_retreat, new.flight_datetime, null, 'трансфер');
    elsif new.direction in ('departure', 'departure_retreat') then
        perform retreat_date_guard(v_retreat, null, new.flight_datetime, 'трансфер');
    end if;
    return new;
end $$;
drop trigger if exists trg_transfer_date_guard on guest_transfers;
create trigger trg_transfer_date_guard before insert or update of flight_datetime, direction
    on guest_transfers for each row execute function trg_transfer_date_guard();

-- Сделка CRM: рейсы и свои даты заезда/выезда
create or replace function trg_crm_deal_date_guard() returns trigger
language plpgsql set search_path = public as $$
declare
    ch_arr boolean := tg_op = 'INSERT' or new.arrival_datetime is distinct from old.arrival_datetime or new.retreat_id is distinct from old.retreat_id;
    ch_dep boolean := tg_op = 'INSERT' or new.departure_datetime is distinct from old.departure_datetime or new.retreat_id is distinct from old.retreat_id;
    ch_in  boolean := tg_op = 'INSERT' or new.stay_check_in is distinct from old.stay_check_in or new.retreat_id is distinct from old.retreat_id;
    ch_out boolean := tg_op = 'INSERT' or new.stay_check_out is distinct from old.stay_check_out or new.retreat_id is distinct from old.retreat_id;
begin
    if ch_arr or ch_dep then
        perform retreat_date_guard(new.retreat_id,
            case when ch_arr then new.arrival_datetime end, case when ch_dep then new.departure_datetime end, 'рейс в сделке');
        if new.arrival_datetime is not null and new.departure_datetime is not null
           and new.departure_datetime < new.arrival_datetime then
            perform retreat_date_guard(null, new.arrival_datetime, new.departure_datetime, 'рейс в сделке');
        end if;
    end if;
    if ch_in or ch_out then
        perform retreat_date_guard(new.retreat_id,
            case when ch_in then new.stay_check_in end, case when ch_out then new.stay_check_out end, 'заезд/выезд в сделке');
    end if;
    return new;
end $$;
drop trigger if exists trg_crm_deal_date_guard on crm_deals;
create trigger trg_crm_deal_date_guard before insert or update of arrival_datetime, departure_datetime, stay_check_in, stay_check_out, retreat_id
    on crm_deals for each row execute function trg_crm_deal_date_guard();
