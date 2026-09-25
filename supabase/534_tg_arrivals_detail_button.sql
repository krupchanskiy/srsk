-- Ресепшен в боте: как у кухни (533) — видно только «Заезд: N» / «Выезд: N»,
-- список людей с комнатами раскрывается кнопкой «Подробнее» (просьба ВГ 25.09.2026).
-- Список сгруппирован по гостиницам (порядок как на сайте: sort_order, название),
-- комнаты — по номеру как по числу: раньше сортировка была текстовой («1, 10, 2»).
--
-- tg_arrivals_text(p_date, p_direction, p_detail) — /приезд и /выезд;
-- tg_reception_plan_text(p_day, p_detail) — вечерний «План на завтра» целиком.
-- Кнопку обрабатывает tg-webhook (callback arr:<1|0>:<дата>:<in|out|plan>).
-- Долги уезжающих в плане видны всегда: это то, что надо успеть спросить.

DROP FUNCTION IF EXISTS public.tg_arrivals_text(date, text);

CREATE OR REPLACE FUNCTION public.tg_arrivals_text(p_date date, p_direction text DEFAULT 'in', p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_block text := '';
  v_n int := 0;
  v_when text;
  v_building text;
  v_first boolean := true;
BEGIN
  FOR r IN
    -- Имя может лежать в самой брони: «бронь без имени» вместо «Адирадж д»
    -- ресепшену бесполезно (замечание Адриана, 02.08.2026)
    SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    NULLIF(btrim(res.guest_name), ''),
                    NULLIF(btrim(bk.name), ''), NULLIF(btrim(bk.contact_name), ''),
                    'бронь без имени') AS who,
           rm.number AS room, COALESCE(b.name_ru, 'Без комнаты') AS building,
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
      LEFT JOIN bookings bk ON bk.id = res.booking_id
     WHERE res.status = 'confirmed'
       AND ((p_direction = 'in' AND res.check_in = p_date)
         OR (p_direction = 'out' AND res.check_out = p_date))
     ORDER BY b.sort_order NULLS LAST, b.name_ru NULLS LAST,
              NULLIF(substring(rm.number FROM '^\d+'), '')::int NULLS LAST, rm.number, 1
  LOOP
    v_n := v_n + 1;
    CONTINUE WHEN NOT p_detail;
    v_when := CASE
      WHEN COALESCE(r.reg_time, r.flight_time) IS NOT NULL
        THEN to_char(COALESCE(r.reg_time, r.flight_time), 'HH24:MI')
      WHEN p_direction = 'in' AND r.early_checkin THEN 'ранний заезд'
      WHEN p_direction = 'out' AND r.late_checkout THEN 'поздний выезд'
      ELSE NULL END;

    IF v_first OR r.building IS DISTINCT FROM v_building THEN
      v_block := v_block || CASE WHEN v_first THEN '' ELSE E'\n' END
                         || format('<b>%s</b>', tg_escape(r.building));
      v_building := r.building;
      v_first := false;
    END IF;
    v_block := v_block || format(E'\n%s — %s%s',
      COALESCE(NULLIF(tg_escape(r.room), ''), '—'),
      tg_escape(r.who),
      COALESCE(' · ' || v_when, ''));
  END LOOP;

  RETURN format('%s <b>%s %s: %s</b>',
                CASE WHEN p_direction = 'in' THEN '🛬' ELSE '🛫' END,
                CASE WHEN p_direction = 'in' THEN 'Заезд' ELSE 'Выезд' END,
                to_char(p_date, 'DD.MM.YYYY'), v_n)
      || CASE WHEN v_block <> '' THEN E'\n<blockquote>' || v_block || '</blockquote>' ELSE '' END;
END;
$function$;

grant execute on function tg_arrivals_text(date, text, boolean) to authenticated, service_role, anon;

CREATE OR REPLACE FUNCTION public.tg_reception_plan_text(p_day date, p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_text text;
  r record;
  v_debt numeric;
  v_block text := '';
  v_n int := 0;
BEGIN
  v_text := format('🌙 <b>План на завтра, %s</b>', to_char(p_day, 'DD.MM.YYYY'))
          || E'\n\n' || tg_arrivals_text(p_day, 'in', p_detail)
          || E'\n' || CASE WHEN p_detail THEN E'\n' ELSE '' END
          || tg_arrivals_text(p_day, 'out', p_detail);

  -- Долги тех, кто завтра уезжает: последний момент спросить
  FOR r IN
    SELECT res.vaishnava_id, res.retreat_id,
           COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    res.guest_name, '—') AS who,
           rm.number AS room, b.name_ru AS building
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
     WHERE res.status = 'confirmed' AND res.check_out = p_day
       AND res.vaishnava_id IS NOT NULL AND res.retreat_id IS NOT NULL
     ORDER BY b.sort_order NULLS LAST, b.name_ru NULLS LAST,
              NULLIF(substring(rm.number FROM '^\d+'), '')::int NULLS LAST, rm.number
  LOOP
    v_debt := COALESCE((fin_private_participant_balance(r.vaishnava_id, r.retreat_id)
                        ->>'total_debt')::numeric, 0);
    CONTINUE WHEN v_debt <= 0;
    v_n := v_n + 1;
    v_block := v_block || format(E'\n• %s%s — <b>%s</b>', tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''),
                                               NULLIF(tg_escape(r.room), '')), ''), ''),
      fin_fmt_money(v_debt, 'INR'));
  END LOOP;

  IF v_n > 0 THEN
    v_text := v_text || format(E'\n\n❗️ <b>Уезжают с долгом: %s</b>', v_n) || v_block;
  END IF;
  RETURN v_text;
END;
$function$;

grant execute on function tg_reception_plan_text(date, boolean) to service_role;

CREATE OR REPLACE FUNCTION public.tg_reception_evening()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chat bigint;
  v_day date := current_date + 1;
  v_id bigint;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Гест-хаус';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат гест-хауса не привязан');
  END IF;

  -- tg_send_chat не умеет кнопки — пишем в очередь сами, с той же страховкой
  BEGIN
    INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
    VALUES (v_chat, tg_reception_plan_text(v_day, false), NULL, 'notify',
            jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
              jsonb_build_object('text', 'Подробнее',
                                 'callback_data', format('arr:1:%s:plan', v_day))))))
    RETURNING id INTO v_id;
    PERFORM tg_outbox_try(v_id);
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN jsonb_build_object('ok', true, 'date', v_day);
END;
$function$;
