-- Номер целиком для семьи (к 725): все места номера делятся на людей этой брони в номере.
-- Один человек — одноместный тариф здания (если заведён) или цена места × мест;
-- семья — цена места × (мест / людей брони), одноместный тариф к ней не применяется.

do $mig$
declare
    src text;
    procedure_rep text[][] := array[
        array[$a$v_found boolean; v_single record; v_whole boolean := false;$a$,
              $b$v_found boolean; v_single record; v_whole boolean := false; v_n int; v_k numeric; v_has_single boolean;$b$],
        array[$a$coalesce(x.whole_room, false) as whole_room$a$,
              $b$coalesce(x.whole_room, false) as whole_room, x.room_id, coalesce(x.booking_id, x.id) as bkey$b$],
        array[$a$            select p.*, s.room_capacity as svc_capacity into v_single from crm_retreat_prices p
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
            end if;$a$,
              $b$            -- сколько людей этой брони живёт в номере в эти даты
            select count(*) into v_n from residents o
             where o.room_id = rec.room_id and coalesce(o.booking_id, o.id) = rec.bkey
               and o.status in ('active', 'confirmed', 'checked_out')
               and o.check_in < rec.check_out and coalesce(o.check_out, rec.check_out) > rec.check_in;
            v_n := greatest(v_n, 1);
            v_has_single := false;
            if v_n = 1 then
                select p.*, s.room_capacity as svc_capacity into v_single from crm_retreat_prices p
                  join crm_services s on s.id = p.service_id
                 where p.retreat_id = d.retreat_id and s.category = 'accommodation'
                   and s.building_id = rec.building_id and s.room_capacity = 1
                 limit 1;
                v_has_single := found;
            end if;
            if v_has_single then
                v_price := v_single;
                v_found := true;
                acc_note := concat_ws(' · ', acc_note, 'номер целиком — одноместный тариф');
            elsif v_found then
                v_k := round(rec.capacity::numeric / v_n, 4);
                v_price.price := v_price.price * v_k;
                v_price.price_rub := v_price.price_rub * v_k;
                v_price.price_usd := v_price.price_usd * v_k;
                v_price.price_eur := v_price.price_eur * v_k;
                acc_note := concat_ws(' · ', acc_note, case when v_n = 1
                    then format('номер целиком — цена места × %s', rec.capacity)
                    else format('номер целиком — %s-местный на %s чел.', rec.capacity, v_n) end);
            end if;$b$]
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
