-- Списки заезда и выезда по команде (ТЗ Адриана, п. 7).
--
-- «/приезд» и «/выезд»: ФИО, комната, время. Время берём из регистрации на
-- ретрит или из рейса — того же источника, что и расчёт питания, иначе
-- ресепшен и кухня разошлись бы во мнении, когда человек приедет.

create or replace function tg_arrivals_text(p_date date, p_direction text default 'in')
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  r record;
  v_text text;
  v_block text := '';
  v_n int := 0;
  v_when text;
BEGIN
  FOR r IN
    SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    res.guest_name, 'бронь без имени') AS who,
           rm.number AS room, b.name_ru AS building,
           res.early_checkin, res.late_checkout,
           (SELECT CASE WHEN p_direction = 'in' THEN rr.arrival_datetime ELSE rr.departure_datetime END
                     AT TIME ZONE 'UTC'
              FROM retreat_registrations rr
             WHERE rr.vaishnava_id = res.vaishnava_id AND rr.retreat_id = res.retreat_id
               AND rr.is_deleted = false LIMIT 1) AS reg_time,
           (SELECT gt.flight_datetime AT TIME ZONE 'UTC'
              FROM guest_transfers gt
              JOIN retreat_registrations rr2 ON rr2.id = gt.registration_id
             WHERE rr2.vaishnava_id = res.vaishnava_id AND rr2.retreat_id = res.retreat_id
               AND gt.direction = CASE WHEN p_direction = 'in' THEN 'arrival' ELSE 'departure' END
             LIMIT 1) AS flight_time
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
     WHERE res.status = 'confirmed'
       AND ((p_direction = 'in' AND res.check_in = p_date)
         OR (p_direction = 'out' AND res.check_out = p_date))
     ORDER BY b.name_ru NULLS LAST, rm.number
  LOOP
    v_n := v_n + 1;
    v_when := CASE
      WHEN COALESCE(r.reg_time, r.flight_time) IS NOT NULL
        THEN to_char(COALESCE(r.reg_time, r.flight_time), 'HH24:MI')
      WHEN p_direction = 'in' AND r.early_checkin THEN 'ранний заезд'
      WHEN p_direction = 'out' AND r.late_checkout THEN 'поздний выезд'
      ELSE NULL END;

    v_block := v_block || format(E'\n• %s%s%s',
      tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''),
                                               NULLIF(tg_escape(r.room), '')), ''), ''),
      COALESCE(' · ' || v_when, ''));
  END LOOP;

  v_text := format('%s <b>%s %s: %s</b>',
    CASE WHEN p_direction = 'in' THEN '🛬' ELSE '🛫' END,
    CASE WHEN p_direction = 'in' THEN 'Заезд' ELSE 'Выезд' END,
    to_char(p_date, 'DD.MM.YYYY'), v_n);

  RETURN v_text || COALESCE(NULLIF(v_block, ''), E'\nНикого.');
END;
$function$;

grant execute on function tg_arrivals_text(date, text) to anon, authenticated, service_role;
