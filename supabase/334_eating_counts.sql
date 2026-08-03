-- Расчёт едоков в базе — тот же, что на сайте.
--
-- Просьба Адриана (02.08.2026): бот должен уметь называть количество вкушающих
-- по датам в теме «Информация» и сообщать об изменениях на ближайшие дни.
-- Расчёт до сих пор жил только в браузере (js/eating-utils.js), и бот его не
-- видел. Своя отдельная формула для бота означала бы расхождение с сайтом —
-- ровно та беда, которую мы сегодня чинили дважды. Поэтому логика повторена
-- здесь один в один, а совпадение проверяется сверкой с браузером.
--
-- Правила (все из eating-utils.js):
--   • резидент ест, если has_meals не «нет»;
--   • день заезда без завтрака, день выезда без обеда — если нет отметки
--     раннего заезда / позднего выезда;
--   • у вайшнава с регистрацией на ретрит день уточняется по времени рейса:
--     завтрак — прилёт до 10, обед — вылет после 13;
--   • галочки «Завтрак»/«Обед» из брони сильнее всего перечисленного;
--   • незаселённые участники ретрита считаются по своей регистрации;
--   • группы (meal_groups) — своими галочками;
--   • ожидаемые — бронь без имени.

create or replace function eating_counts(p_from date, p_to date)
returns table (
  d date, meal text,
  team int, volunteers int, vips int, guests int, groups int, expected int)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  BREAKFAST_CUTOFF constant int := 10;
  LUNCH_CUTOFF constant int := 13;
  v_day date;
  r record;
  bf_team int; bf_vol int; bf_vip int; bf_guest int; bf_exp int;
  ln_team int; ln_vol int; ln_vip int; ln_guest int; ln_exp int;
  bf_groups int; ln_groups int;
  v_seen uuid[];
  v_bf boolean; v_ln boolean;
  v_first boolean; v_last boolean;
  v_hour int;
  v_start date; v_end date;
  v_arr timestamp; v_dep timestamp;
BEGIN
  v_day := p_from;
  WHILE v_day <= p_to LOOP
    bf_team := 0; bf_vol := 0; bf_vip := 0; bf_guest := 0; bf_exp := 0;
    ln_team := 0; ln_vol := 0; ln_vip := 0; ln_guest := 0; ln_exp := 0;
    v_seen := ARRAY[]::uuid[];

    -- ---------- размещённые и забронированные ----------
    FOR r IN
      SELECT res.id, res.vaishnava_id, res.guest_name, res.retreat_id,
             res.check_in, res.check_out, res.early_checkin, res.late_checkout,
             res.breakfast, res.lunch, rc.slug,
             -- время из регистрации на ретрит: у поля TIMESTAMPTZ «локальное»
             -- значение лежит как UTC, поэтому читаем его без сдвига
             (SELECT rr.arrival_datetime AT TIME ZONE 'UTC' FROM retreat_registrations rr
               WHERE rr.vaishnava_id = res.vaishnava_id AND rr.retreat_id = res.retreat_id
                 AND rr.is_deleted = false LIMIT 1) AS reg_arrival,
             (SELECT rr.departure_datetime AT TIME ZONE 'UTC' FROM retreat_registrations rr
               WHERE rr.vaishnava_id = res.vaishnava_id AND rr.retreat_id = res.retreat_id
                 AND rr.is_deleted = false LIMIT 1) AS reg_departure
        FROM residents res
        JOIN resident_categories rc ON rc.id = res.category_id
       WHERE res.status = 'confirmed'
         AND res.has_meals IS DISTINCT FROM false
         AND res.check_in <= v_day
         AND (res.check_out IS NULL OR res.check_out >= v_day)
    LOOP
      IF r.vaishnava_id IS NOT NULL THEN v_seen := v_seen || r.vaishnava_id; END IF;

      v_first := (v_day = r.check_in);
      v_last  := (r.check_out IS NOT NULL AND v_day = r.check_out);
      v_bf := (NOT v_first) OR COALESCE(r.early_checkin, false);
      v_ln := (NOT v_last)  OR COALESCE(r.late_checkout, false);

      IF v_first AND NOT COALESCE(r.early_checkin, false) AND r.reg_arrival IS NOT NULL THEN
        v_bf := extract(hour FROM r.reg_arrival) < BREAKFAST_CUTOFF;
      END IF;
      IF v_last AND NOT COALESCE(r.late_checkout, false) AND r.reg_departure IS NOT NULL THEN
        v_ln := extract(hour FROM r.reg_departure) >= LUNCH_CUTOFF;
      END IF;

      -- галочки «Прасад» сильнее любых уточнений
      IF r.breakfast IS false THEN v_bf := false; END IF;
      IF r.lunch IS false THEN v_ln := false; END IF;

      IF r.vaishnava_id IS NULL AND COALESCE(btrim(r.guest_name), '') = '' THEN
        IF v_bf THEN bf_exp := bf_exp + 1; END IF;
        IF v_ln THEN ln_exp := ln_exp + 1; END IF;
      ELSIF r.slug = 'team' THEN
        IF v_bf THEN bf_team := bf_team + 1; END IF;
        IF v_ln THEN ln_team := ln_team + 1; END IF;
      ELSIF r.slug = 'volunteer' THEN
        IF v_bf THEN bf_vol := bf_vol + 1; END IF;
        IF v_ln THEN ln_vol := ln_vol + 1; END IF;
      ELSIF r.slug = 'vip' THEN
        IF v_bf THEN bf_vip := bf_vip + 1; END IF;
        IF v_ln THEN ln_vip := ln_vip + 1; END IF;
      ELSE
        IF v_bf THEN bf_guest := bf_guest + 1; END IF;
        IF v_ln THEN ln_guest := ln_guest + 1; END IF;
      END IF;
    END LOOP;

    -- ---------- участники ретрита, которых ещё не расселили ----------
    FOR r IN
      SELECT rr.status, rr.vaishnava_id,
             rr.arrival_datetime AT TIME ZONE 'UTC' AS arr,
             rr.departure_datetime AT TIME ZONE 'UTC' AS dep,
             ret.start_date, ret.end_date,
             (SELECT gt.flight_datetime AT TIME ZONE 'UTC' FROM guest_transfers gt
               WHERE gt.registration_id = rr.id AND gt.direction = 'arrival' LIMIT 1) AS arr_flight,
             (SELECT gt.flight_datetime AT TIME ZONE 'UTC' FROM guest_transfers gt
               WHERE gt.registration_id = rr.id AND gt.direction = 'departure' LIMIT 1) AS dep_flight
        FROM retreat_registrations rr
        JOIN retreats ret ON ret.id = rr.retreat_id
       WHERE rr.is_deleted = false
         AND rr.status NOT IN ('cancelled', 'rejected')
         AND (rr.meal_type = 'prasad' OR rr.meal_type IS NULL)
         AND ret.start_date <= v_day AND ret.end_date >= v_day
         AND NOT (rr.vaishnava_id = ANY (v_seen))
    LOOP
      v_arr := COALESCE(r.arr, r.arr_flight);
      v_dep := COALESCE(r.dep, r.dep_flight);
      -- Дата приезда неизвестна — человека не считаем. Раньше его записывали
      -- едоком на весь ретрит: на двухмесячном «Ретрите Художников» это дало
      -- 25 лишних порций с первого дня, хотя люди заезжали позже (02.08.2026).
      -- Приехавших расселяют, а расселённые считаются по размещению.
      CONTINUE WHEN v_arr IS NULL;
      v_start := v_arr::date;
      v_end   := COALESCE(v_dep::date, r.end_date);
      CONTINUE WHEN v_day < v_start OR v_day > v_end;

      v_first := (v_day = v_start);
      v_last  := (v_day = v_end);
      v_bf := true; v_ln := true;

      IF v_first THEN
        IF v_arr IS NOT NULL THEN
          v_hour := extract(hour FROM v_arr);
          v_bf := v_hour < BREAKFAST_CUTOFF;
          v_ln := v_hour < LUNCH_CUTOFF;
        ELSE
          v_bf := false;
        END IF;
      END IF;
      IF v_last THEN
        IF v_dep IS NOT NULL THEN
          v_hour := extract(hour FROM v_dep);
          v_bf := v_bf AND v_hour >= BREAKFAST_CUTOFF;
          v_ln := v_ln AND v_hour >= LUNCH_CUTOFF;
        ELSE
          v_ln := false;
        END IF;
      END IF;

      IF r.status = 'team' THEN
        IF v_bf THEN bf_team := bf_team + 1; END IF;
        IF v_ln THEN ln_team := ln_team + 1; END IF;
      ELSIF r.status = 'volunteer' THEN
        IF v_bf THEN bf_vol := bf_vol + 1; END IF;
        IF v_ln THEN ln_vol := ln_vol + 1; END IF;
      ELSIF r.status = 'vip' THEN
        IF v_bf THEN bf_vip := bf_vip + 1; END IF;
        IF v_ln THEN ln_vip := ln_vip + 1; END IF;
      ELSE
        IF v_bf THEN bf_guest := bf_guest + 1; END IF;
        IF v_ln THEN ln_guest := ln_guest + 1; END IF;
      END IF;
    END LOOP;

    -- ---------- группы ----------
    SELECT COALESCE(sum(people_count) FILTER (WHERE breakfast), 0),
           COALESCE(sum(people_count) FILTER (WHERE lunch), 0)
      INTO bf_groups, ln_groups
      FROM meal_groups
     WHERE start_date <= v_day AND end_date >= v_day;

    d := v_day; meal := 'breakfast';
    team := bf_team; volunteers := bf_vol; vips := bf_vip; guests := bf_guest;
    groups := bf_groups; expected := bf_exp;
    RETURN NEXT;

    meal := 'lunch';
    team := ln_team; volunteers := ln_vol; vips := ln_vip; guests := ln_guest;
    groups := ln_groups; expected := ln_exp;
    RETURN NEXT;

    v_day := v_day + 1;
  END LOOP;
END;
$function$;

grant execute on function eating_counts(date, date) to authenticated, service_role;
