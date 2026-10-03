-- 636: фаза 2, шаг 7б-2 (ВГ, 03.10.2026) — «съехал из номера, но ест с нами».
-- fin_charge_set_stay: stays_self + self_until — номер закрывается выездом, с него открывается
-- «Самостоятельное проживание» с питанием (кухня кормит дальше, жильё не начисляется);
-- resident_id — одна запись (визит гостя без события: без ретрита, без регистрации и CRM).
-- fin_charge_revert_stay: созданную строку удаляет, если её не правили.

alter table public.fin_charge_stay_changes add column if not exists created_resident boolean not null default false;

create or replace function public.fin_charge_set_stay(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_actor uuid; v_detail text;
    v_pid uuid; v_ret uuid; v_in date; v_out date; v_charge uuid; v_dry boolean; v_whole boolean;
    v_reason text;
    r record; v_internal boolean;
    v_first residents%rowtype; v_last residents%rowtype; v_n int;
    v_plan jsonb := '[]'::jsonb;
    v_mates int := 0;
    x record; v_busy date;
    v_reg retreat_registrations%rowtype;
    v_deal uuid; v_who text; v_fmt text; v_vid uuid;
    v_rid uuid; v_self boolean; v_until date; v_new_id uuid;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Даты из начисления переносит администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['participant_id', 'retreat_id', 'check_in', 'check_out',
        'charge_id', 'dry_run', 'whole_booking', 'reason', 'resident_id', 'stays_self', 'self_until']);
    -- resident_id — одна запись шахматки (визит гостя без события); иначе — все записи гостя на ретрите
    v_rid := fin_private_get_uuid(payload, 'resident_id', false);
    if v_rid is not null then
        select vaishnava_id, retreat_id into v_pid, v_ret from residents where id = v_rid;
        if not found then raise exception 'invalid_payload' using detail = 'Проживание не найдено'; end if;
        v_pid := coalesce(v_pid, fin_private_get_uuid(payload, 'participant_id', false));
    else
        v_pid := fin_private_get_uuid(payload, 'participant_id', true);
        v_ret := fin_private_get_uuid(payload, 'retreat_id', true);
    end if;
    -- «остаётся жить сам и питается с нами»: номер закрывается выездом, с него — самостоятельное
    -- проживание с питанием до self_until (по умолчанию — прежний выезд)
    v_self := coalesce((payload->>'stays_self')::boolean, false);
    v_until := nullif(payload->>'self_until', '')::date;
    v_in := nullif(payload->>'check_in', '')::date;
    v_out := nullif(payload->>'check_out', '')::date;
    v_charge := fin_private_get_uuid(payload, 'charge_id', false);
    v_dry := coalesce((payload->>'dry_run')::boolean, false);
    v_whole := (payload->>'whole_booking')::boolean;
    v_reason := nullif(trim(payload->>'reason'), '');
    if v_in is null or v_out is null or v_out <= v_in then
        raise exception 'invalid_payload' using detail = 'Нужны даты заезда и выезда, выезд позже заезда';
    end if;
    if not v_dry and v_charge is null then
        raise exception 'invalid_payload' using detail = 'charge_id: к какому начислению привязать даты';
    end if;

    select * into r from retreats where id = v_ret;
    v_internal := v_ret is null or retreat_is_internal(v_ret);
    -- вариант 2: до 3 дней до/после — часть ретрита, больше — отдельный визит «Гость без события»
    if v_ret is not null and not v_internal and not coalesce(r.is_system, false)
       and (v_in < r.start_date - 3 or greatest(v_out, coalesce(v_until, v_out)) > r.end_date + 3) then
        raise exception 'outside_retreat' using detail = format(
            'Даты выходят за ретрит (%s — %s) больше чем на 3 дня. Ретрит — в его даты (±3 дня), остальное — '
            'визит «Гость без события»: шахматка → окно проживания → «Разделить», начисление — в «Гостях без события»',
            to_char(r.start_date, 'DD.MM'), to_char(r.end_date, 'DD.MM'));
    end if;

    if v_rid is not null then
        v_n := 1;
    else
        select count(*) into v_n from residents x0
         where x0.vaishnava_id = v_pid and x0.retreat_id = v_ret and x0.status in ('active', 'confirmed', 'checked_out');
    end if;
    if v_n = 0 and v_self then
        raise exception 'invalid_payload' using detail = 'Гостя нет в шахматке — «живёт сам» оформляется в шахматке';
    end if;
    if v_n = 0 then
        -- не размещён: даты регистрации (по ней кухня считает незаселённых); время дня сохраняем
        select * into v_reg from retreat_registrations
         where vaishnava_id = v_pid and retreat_id = v_ret and not is_deleted and status <> 'cancelled'
         order by created_at desc limit 1;
        if not found then
            raise exception 'not_placed' using detail = 'Гостя нет ни в шахматке, ни в регистрации — даты переносить некуда';
        end if;
        v_plan := jsonb_build_array(jsonb_build_object('registration_id', v_reg.id, 'what', 'регистрация',
            'old_in', (v_reg.arrival_datetime at time zone 'UTC')::date, 'old_out', (v_reg.departure_datetime at time zone 'UTC')::date,
            'new_in', v_in, 'new_out', v_out));
        if not v_dry then
            insert into fin_charge_stay_changes (charge_id, registration_id, old_arrival, old_departure, new_check_in, new_check_out, created_by)
            values (v_charge, v_reg.id, v_reg.arrival_datetime, v_reg.departure_datetime, v_in, v_out, v_actor);
            update retreat_registrations set
                arrival_datetime = ((v_in + coalesce((arrival_datetime at time zone 'UTC')::time, time '12:00')) at time zone 'UTC'),
                departure_datetime = ((v_out + coalesce((departure_datetime at time zone 'UTC')::time, time '12:00')) at time zone 'UTC')
             where id = v_reg.id;
        end if;
    else
        if v_rid is not null then
            select * into v_first from residents where id = v_rid;
            v_last := v_first;
        else
            select * into v_first from residents x0
             where x0.vaishnava_id = v_pid and x0.retreat_id = v_ret and x0.status in ('active', 'confirmed', 'checked_out')
             order by x0.check_in, x0.id limit 1;
            select * into v_last from residents x0
             where x0.vaishnava_id = v_pid and x0.retreat_id = v_ret and x0.status in ('active', 'confirmed', 'checked_out')
             order by coalesce(x0.check_out, 'infinity'::date) desc, x0.id desc limit 1;
        end if;
        if v_self then
            if v_last.room_id is null then
                raise exception 'invalid_payload' using detail = 'Гость и так на самостоятельном проживании';
            end if;
            if v_out >= coalesce(v_last.check_out, 'infinity'::date) then
                raise exception 'invalid_payload' using detail = '«Живёт сам» — выезд из номера должен быть раньше прежнего выезда';
            end if;
            v_until := coalesce(v_until, v_last.check_out);
            if v_until <= v_out then
                raise exception 'invalid_payload' using detail = 'Самостоятельное проживание: дата «по» позже выезда из номера';
            end if;
        end if;
        if v_first.id = v_last.id then
            null;
        elsif v_in >= coalesce(v_first.check_out, 'infinity'::date) or v_out <= v_last.check_in then
            raise exception 'invalid_payload' using detail = format(
                'У гостя %s записи в шахматке (переезд). Новые даты перекрывают переезд — поправьте записи в шахматке', v_n);
        end if;

        -- соседи по брони на тех же датах — «только он или вся бронь»
        if v_first.booking_id is not null then
            select count(*) into v_mates from residents x0
             where x0.booking_id = v_first.booking_id and x0.id <> v_first.id
               and x0.status in ('active', 'confirmed', 'checked_out')
               and x0.check_in = v_first.check_in and x0.check_out is not distinct from v_first.check_out;
        end if;
        if v_mates > 0 and v_whole is null and v_first.id = v_last.id then
            return jsonb_build_object('ok', true, 'result', jsonb_build_object('ask_booking', v_mates), 'warnings', '[]'::jsonb);
        end if;

        -- кого двигаем: первая/последняя запись гостя (+ соседи по брони, если «вся бронь»)
        for x in
            select x0.*, rm.number as room_number, rm.capacity, b.name_ru as building_name,
                   case when x0.id = v_first.id then v_in else x0.check_in end as n_in,
                   case when x0.id = v_last.id then v_out else x0.check_out end as n_out
              from residents x0
              left join rooms rm on rm.id = x0.room_id
              left join buildings b on b.id = rm.building_id
             where x0.id in (v_first.id, v_last.id)
                or (coalesce(v_whole, false) and v_first.id = v_last.id and x0.booking_id = v_first.booking_id
                    and x0.status in ('active', 'confirmed', 'checked_out')
                    and x0.check_in = v_first.check_in and x0.check_out is not distinct from v_first.check_out)
        loop
            -- у соседа по брони — те же новые даты
            if x.id not in (v_first.id, v_last.id) then x.n_in := v_in; x.n_out := v_out; end if;
            if x.n_in = x.check_in and x.n_out is not distinct from x.check_out then continue; end if;
            -- продление — только если в номере есть свободное место в добавленные дни
            if x.room_id is not null then
                select dd::date into v_busy
                  from generate_series(x.n_in, x.n_out - 1, interval '1 day') dd
                 where (dd::date < x.check_in or dd::date >= coalesce(x.check_out, 'infinity'::date))
                   and (select count(*) from residents o
                         where o.room_id = x.room_id and o.id <> x.id
                           and o.status in ('active', 'confirmed')
                           and o.check_in <= dd::date and coalesce(o.check_out, 'infinity'::date) > dd::date
                           and not (coalesce(v_whole, false) and o.booking_id = v_first.booking_id)) >= coalesce(x.capacity, 1)
                 order by dd limit 1;
                if v_busy is not null then
                    raise exception 'room_busy' using detail = format(
                        '%s №%s занят %s — продлить нельзя. Переселите гостя в шахматке', coalesce(x.building_name, ''), x.room_number, to_char(v_busy, 'DD.MM'));
                end if;
            end if;
            v_plan := v_plan || jsonb_build_object('resident_id', x.id,
                'what', coalesce(x.building_name || ' №' || x.room_number, 'самостоятельное проживание'),
                'old_in', x.check_in, 'old_out', x.check_out, 'new_in', x.n_in, 'new_out', x.n_out);
            if not v_dry then
                insert into fin_charge_stay_changes (charge_id, resident_id, old_check_in, old_check_out, new_check_in, new_check_out, created_by)
                values (v_charge, x.id, x.check_in, x.check_out, x.n_in, x.n_out, v_actor);
                update residents set check_in = x.n_in, check_out = x.n_out,
                       late_checkout = case when v_self and x.id = v_last.id then false else late_checkout end
                 where id = x.id;
            end if;
        end loop;
        -- самостоятельное проживание с питанием: в день переезда номер даёт завтрак, эта строка — обед
        if v_self then
            v_plan := v_plan || jsonb_build_object('what', 'самостоятельное проживание, питается с нами',
                'old_in', null, 'old_out', null, 'new_in', v_out, 'new_out', v_until);
            if not v_dry then
                insert into residents (vaishnava_id, retreat_id, category_id, check_in, check_out, status,
                                       has_housing, has_meals, meal_type, breakfast, lunch, late_checkout, arrived_at,
                                       guest_name, guest_phone, guest_email)
                values (v_last.vaishnava_id, v_last.retreat_id, v_last.category_id, v_out, v_until, v_last.status,
                        false, true, v_last.meal_type, v_last.breakfast, v_last.lunch, v_last.late_checkout, v_last.arrived_at,
                        v_last.guest_name, v_last.guest_phone, v_last.guest_email)
                returning id into v_new_id;
                insert into fin_charge_stay_changes (charge_id, resident_id, new_check_in, new_check_out, created_resident, created_by)
                values (v_charge, v_new_id, v_out, v_until, true, v_actor);
            end if;
        end if;
        -- и регистрация: дни вне шахматки кухня добирает по ней — иначе сокращённый
        -- выезд всё равно кормится до старой даты отъезда
        select * into v_reg from retreat_registrations
         where vaishnava_id = v_pid and retreat_id = v_ret and not is_deleted and status <> 'cancelled'
         order by created_at desc limit 1;
        if v_self then v_out := v_until; end if;   -- в регистрации — до конца питания
        if v_ret is not null and found and jsonb_array_length(v_plan) > 0
           and ((v_reg.arrival_datetime at time zone 'UTC')::date is distinct from v_in
             or (v_reg.departure_datetime at time zone 'UTC')::date is distinct from v_out) then
            if not v_dry then
                insert into fin_charge_stay_changes (charge_id, registration_id, old_arrival, old_departure, new_check_in, new_check_out, created_by)
                values (v_charge, v_reg.id, v_reg.arrival_datetime, v_reg.departure_datetime, v_in, v_out, v_actor);
                update retreat_registrations set
                    arrival_datetime = ((v_in + coalesce((arrival_datetime at time zone 'UTC')::time, time '12:00')) at time zone 'UTC'),
                    departure_datetime = ((v_out + coalesce((departure_datetime at time zone 'UTC')::time, time '12:00')) at time zone 'UTC')
                 where id = v_reg.id;
            end if;
        end if;
    end if;

    -- CRM: заметка в сделке, без денег (ВГ 01.10: «достаточно показать даты из оплаты»)
    if not v_dry and v_ret is not null and jsonb_array_length(v_plan) > 0 then
        select id into v_deal from crm_deals
         where vaishnava_id = v_pid and retreat_id = v_ret and status <> 'cancelled'
         order by updated_at desc nulls last limit 1;
        if v_deal is not null then
            select v.id, coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''))
              into v_vid, v_who from vaishnavas v where v.user_id = v_actor limit 1;
            select string_agg(format('%s: %s — %s → %s — %s', p->>'what',
                       coalesce(to_char((p->>'old_in')::date, 'DD.MM'), 'нет'), coalesce(to_char((p->>'old_out')::date, 'DD.MM'), ''),
                       to_char((p->>'new_in')::date, 'DD.MM'), to_char((p->>'new_out')::date, 'DD.MM')), '; ')
              into v_fmt from jsonb_array_elements(v_plan) p;
            -- тип placement (история размещения в сделке), не note: заметки кассира о долге
            -- (шаг 6) остаются последними и не перекрываются служебной записью
            insert into crm_communications (deal_id, type, direction, summary, content, created_by)
            values (v_deal, 'placement', 'internal', 'Даты проживания из оплаты: ' || v_fmt,
                format('Из карточки оплаты%s: даты проживания %s%s',
                coalesce(', ' || v_who, ''), v_fmt, coalesce('. ' || v_reason, '')), v_vid);
        end if;
    end if;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object('plan', v_plan, 'dry_run', v_dry), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

create or replace function public.fin_charge_revert_stay(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_actor uuid; v_detail text; v_charge uuid;
    c record; v_back int := 0; v_skip jsonb := '[]'::jsonb;
    x residents%rowtype; g retreat_registrations%rowtype;
    v_deal uuid; v_pid uuid; v_ret uuid; v_late boolean;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Даты возвращает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['charge_id']);
    v_charge := fin_private_get_uuid(payload, 'charge_id', true);
    select participant_id, retreat_id into v_pid, v_ret from fin_charges where id = v_charge;
    for c in select * from fin_charge_stay_changes where charge_id = v_charge and reverted_at is null order by created_at desc loop
        if c.created_resident then
            -- строку «живёт сам» создало это начисление — удаляем, если её не правили
            select * into x from residents where id = c.resident_id for update;
            if found and x.check_in = c.new_check_in and x.check_out is not distinct from c.new_check_out then
                v_late := x.late_checkout;   -- поздний выезд переезжал на эту строку — вернём номеру
                delete from resident_meal_skips where resident_id = x.id;
                delete from residents where id = x.id;
                update fin_charge_stay_changes set reverted_at = now() where id = c.id;
                v_back := v_back + 1;
            elsif found then
                v_skip := v_skip || jsonb_build_object('resident_id', c.resident_id, 'now_in', x.check_in, 'now_out', x.check_out);
            end if;
        elsif c.resident_id is not null then
            select * into x from residents where id = c.resident_id for update;
            if found and x.check_in = c.new_check_in and x.check_out is not distinct from c.new_check_out then
                update residents set check_in = c.old_check_in, check_out = c.old_check_out,
                       late_checkout = coalesce(v_late, late_checkout) where id = x.id;
                update fin_charge_stay_changes set reverted_at = now() where id = c.id;
                v_back := v_back + 1;
            else
                v_skip := v_skip || jsonb_build_object('resident_id', c.resident_id,
                    'old_in', c.old_check_in, 'old_out', c.old_check_out, 'now_in', x.check_in, 'now_out', x.check_out);
            end if;
        else
            select * into g from retreat_registrations where id = c.registration_id for update;
            if found and (g.arrival_datetime at time zone 'UTC')::date = c.new_check_in
               and (g.departure_datetime at time zone 'UTC')::date = c.new_check_out then
                update retreat_registrations set arrival_datetime = c.old_arrival, departure_datetime = c.old_departure where id = g.id;
                update fin_charge_stay_changes set reverted_at = now() where id = c.id;
                v_back := v_back + 1;
            else
                v_skip := v_skip || jsonb_build_object('registration_id', c.registration_id);
            end if;
        end if;
    end loop;
    if v_back > 0 then
        select id into v_deal from crm_deals
         where vaishnava_id = v_pid and retreat_id = v_ret and status <> 'cancelled'
         order by updated_at desc nulls last limit 1;
        if v_deal is not null then
            insert into crm_communications (deal_id, type, direction, summary, content, created_by)
            values (v_deal, 'placement', 'internal', 'Начисление отменено — даты проживания возвращены как были',
                    'Из карточки оплаты: начисление отменено — даты проживания возвращены как были',
                    (select id from vaishnavas where user_id = v_actor limit 1));
        end if;
    end if;
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('reverted', v_back, 'changed_since', v_skip), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;


-- 636b (применено отдельно): проверка «resident_id или registration_id» мешала удалению строк шахматки и откату
alter table public.fin_charge_stay_changes drop constraint if exists fin_charge_stay_changes_check;
