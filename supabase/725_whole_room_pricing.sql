-- Номер целиком (724) — в оплате (ВГ 19.10).
-- Участник ретрита: одноместный тариф здания, если он заведён на ретрит; иначе цена места × мест номера.
-- Гость без события: в списке визитов отметка whole_room и жильцы своей брони — окно делит
-- цену номера на них (один человек платит весь номер).
-- crm_calc_participation правится точечными заменами текущего текста; каждая замена проверяется.

do $mig$
declare
    src text;
    procedure_rep text[][] := array[
        -- 1) переменные
        array[$a$v_rooms jsonb := '[]'::jsonb;$a$,
              $b$v_rooms jsonb := '[]'::jsonb;
    v_found boolean; v_single record; v_whole boolean := false;$b$],
        -- 2) отметка у записи шахматки
        array[$a$coalesce(x.check_out, r.end_date) as check_out
          from residents x
          join rooms rm on rm.id = x.room_id$a$,
              $b$coalesce(x.check_out, r.end_date) as check_out, coalesce(x.whole_room, false) as whole_room
          from residents x
          join rooms rm on rm.id = x.room_id$b$],
        -- 3) цена номера целиком
        array[$a$        v_rooms := v_rooms || jsonb_build_object('building', rec.building_name, 'room', rec.room_number,
            'check_in', rec.check_in, 'check_out', rec.check_out, 'nights', n_all, 'priced', found);
        if found then$a$,
              $b$        v_found := found;
        -- 724: номер целиком — одноместный тариф здания на этот ретрит; нет его — цена места × мест
        if rec.whole_room then
            v_whole := true;
            select p.*, s.room_capacity as svc_capacity into v_single from crm_retreat_prices p
              join crm_services s on s.id = p.service_id
             where p.retreat_id = d.retreat_id and s.category = 'accommodation'
               and s.building_id = rec.building_id and s.room_capacity = 1
             limit 1;
            if found then
                v_price := v_single;
                v_found := true;
                acc_note := concat_ws(' · ', acc_note, 'номер целиком — одноместный тариф');
            elsif v_found then
                v_price.price := v_price.price * rec.capacity;
                v_price.price_rub := v_price.price_rub * rec.capacity;
                v_price.price_usd := v_price.price_usd * rec.capacity;
                v_price.price_eur := v_price.price_eur * rec.capacity;
                acc_note := concat_ws(' · ', acc_note, format('номер целиком — цена места × %s', rec.capacity));
            end if;
        end if;
        v_rooms := v_rooms || jsonb_build_object('building', rec.building_name, 'room', rec.room_number,
            'check_in', rec.check_in, 'check_out', rec.check_out, 'nights', n_all, 'priced', v_found,
            'whole_room', rec.whole_room);
        if v_found then$b$],
        -- 4) у номера целиком нет «доп. кровати»
        array[$a$if v_cap is not null and v_cap <> rec.capacity then$a$,
              $b$if v_cap is not null and v_cap <> rec.capacity and not rec.whole_room then$b$],
        -- 5) отметка в ответе
        array[$a$'rooms', v_rooms),$a$,
              $b$'rooms', v_rooms, 'whole_room', v_whole),$b$]
    ];
    i int;
begin
    select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'crm_calc_participation';
    for i in 1 .. array_length(procedure_rep, 1) loop
        if (length(src) - length(replace(src, procedure_rep[i][1], ''))) / length(procedure_rep[i][1]) <> 1 then
            raise exception 'crm_calc_participation: замена % не нашлась ровно один раз', i;
        end if;
        src := replace(src, procedure_rep[i][1], procedure_rep[i][2]);
    end loop;
    execute src;
end $mig$;

-- Гость без события: отметка и жильцы своей брони
do $mig$
declare src text;
    a text := $a$'roommates', (select max(cnt) from ($a$;
    b text := $b$'whole_room', coalesce(r.whole_room, false),
            -- 724: номер целиком — делим цену номера на жильцов своей брони
            'booking_roommates', (select max(cnt) from (
                select count(*) cnt from generate_series(r.check_in, coalesce(r.check_out, r.check_in), interval '1 day') g(d)
                  join residents o on o.room_id = r.room_id and o.status in ('confirmed', 'checked_out')
                   and coalesce(o.booking_id, o.id) = coalesce(r.booking_id, r.id)
                   and o.check_in <= g.d::date and coalesce(o.check_out, o.check_in) > g.d::date
                 group by g.d) x),
            'roommates', (select max(cnt) from ($b$;
begin
    select pg_get_functiondef(p.oid) into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'fin_list_no_event_visits';
    if (length(src) - length(replace(src, a, ''))) / length(a) <> 1 then
        raise exception 'fin_list_no_event_visits: замена не нашлась ровно один раз';
    end if;
    execute replace(src, a, b);
end $mig$;
