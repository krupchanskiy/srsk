-- Вкушающие: выселенные тоже ели.
-- Было: из размещений брались только status = 'confirmed' — кто уже выехал (checked_out),
-- пропадал из всех прошлых дней (15.08.2026 обед: 24 вместо 52). При выселении check_out
-- ставится фактический, поэтому сегодня и дальше числа не меняются.
-- Заодно: у одного человека бывают пересекающиеся размещения (переезд, двойная бронь) —
-- человек в день считается один раз, завтрак/обед — «хоть по одному размещению».
-- Для строки выбирается подтверждённое размещение, затем с ретритом, затем более позднее.
CREATE OR REPLACE FUNCTION public.eating_detail(p_from date, p_to date)
 RETURNS TABLE(d date, kind text, ref_id uuid, vaishnava_id uuid, retreat_id uuid, bucket text, breakfast boolean, lunch boolean, people integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH days AS (
    SELECT g::date AS d FROM generate_series(p_from, p_to, interval '1 day') g
  ),
  -- регистрации, участвующие в расчёте; у TIMESTAMPTZ «локальное» время
  -- лежит как UTC, поэтому читаем без сдвига; рейс — запасной источник
  regs AS (
    SELECT rr.id, rr.vaishnava_id, rr.retreat_id, rr.status,
           COALESCE(rr.arrival_datetime,
             (SELECT gt.flight_datetime FROM guest_transfers gt
               WHERE gt.registration_id = rr.id AND gt.direction = 'arrival' LIMIT 1)
           ) AT TIME ZONE 'UTC' AS arr,
           COALESCE(rr.departure_datetime,
             (SELECT gt.flight_datetime FROM guest_transfers gt
               WHERE gt.registration_id = rr.id AND gt.direction = 'departure' LIMIT 1)
           ) AT TIME ZONE 'UTC' AS dep
      FROM retreat_registrations rr
     WHERE rr.is_deleted = false
       AND rr.status NOT IN ('cancelled', 'rejected')
       AND (rr.meal_type = 'prasad' OR rr.meal_type IS NULL)
  ),
  -- ---------- размещённые, забронированные и уже выехавшие ----------
  res AS (
    SELECT dd.d, r.id, r.vaishnava_id, r.retreat_id, rc.slug, r.arrived_at,
           r.status AS r_status, r.check_in,
           r.breakfast AS bf_flag, r.lunch AS ln_flag,
           COALESCE(r.early_checkin, false) AS early,
           COALESCE(r.late_checkout, false) AS late,
           (dd.d = r.check_in) AS is_first,
           (r.check_out IS NOT NULL AND dd.d = r.check_out) AS is_last,
           rg.arr, rg.dep
      FROM residents r
      JOIN resident_categories rc ON rc.id = r.category_id
      JOIN days dd
        ON COALESCE(r.meal_start_date, r.check_in) <= dd.d
       AND (COALESCE(r.meal_end_date, r.check_out) IS NULL
            OR COALESCE(r.meal_end_date, r.check_out) >= dd.d)
      LEFT JOIN LATERAL (
        SELECT g.arr, g.dep FROM regs g
         WHERE g.vaishnava_id = r.vaishnava_id AND g.retreat_id = r.retreat_id
         LIMIT 1
      ) rg ON r.vaishnava_id IS NOT NULL AND r.retreat_id IS NOT NULL
     WHERE r.status IN ('confirmed', 'checked_out')
       AND r.has_meals IS DISTINCT FROM false
  ),
  res_flags AS (
    SELECT x.*,
           CASE
             -- уехал раньше, чем кончается бронь — кормить некого
             WHEN x.is_last AND NOT x.late AND x.dep::date < x.d THEN false
             -- утренний рейс — человека нет и на завтраке
             WHEN x.is_last AND NOT x.late AND x.dep::date = x.d
               THEN (CASE WHEN x.is_first AND NOT x.early AND x.arr::date = x.d
                          THEN extract(hour FROM x.arr) < 10
                          ELSE (NOT x.is_first OR x.early) END)
                    AND extract(hour FROM x.dep) >= 10
             -- время приезда уточняет только свой день
             WHEN x.is_first AND NOT x.early AND x.arr::date = x.d
               THEN extract(hour FROM x.arr) < 10
             ELSE (NOT x.is_first OR x.early)
           END AS bf0,
           CASE
             WHEN x.is_last AND NOT x.late AND x.dep::date < x.d THEN false
             -- уезжает после 13 — успевает пообедать
             WHEN x.is_last AND NOT x.late AND x.dep::date = x.d
               THEN extract(hour FROM x.dep) >= 13
             ELSE (NOT x.is_last OR x.late)
           END AS ln0
      FROM res x
  ),
  -- один человек — одна строка в день, даже если размещения пересекаются
  res_one AS (
    SELECT y.* FROM (
      SELECT f.*,
             -- галочки «Завтрак»/«Обед» сильнее любых уточнений
             bool_or(f.bf0 AND f.bf_flag IS DISTINCT FROM false)
               OVER (PARTITION BY COALESCE(f.vaishnava_id, f.id), f.d) AS bf,
             bool_or(f.ln0 AND f.ln_flag IS DISTINCT FROM false)
               OVER (PARTITION BY COALESCE(f.vaishnava_id, f.id), f.d) AS ln,
             row_number() OVER (PARTITION BY COALESCE(f.vaishnava_id, f.id), f.d
               ORDER BY (f.r_status = 'confirmed') DESC, (f.retreat_id IS NOT NULL) DESC,
                        f.check_in DESC, f.id) AS rn
        FROM res_flags f
    ) y WHERE y.rn = 1
  ),
  -- ---------- участники ретрита, которых ещё не расселили ----------
  reg_rows AS (
    SELECT dd.d, g.id, g.vaishnava_id, g.retreat_id, g.status,
           g.arr, g.dep, COALESCE(g.dep::date, ret.end_date) AS v_end
      FROM regs g
      JOIN retreats ret ON ret.id = g.retreat_id
      JOIN days dd ON dd.d BETWEEN ret.start_date AND ret.end_date
     WHERE g.arr IS NOT NULL
       AND dd.d BETWEEN g.arr::date AND COALESCE(g.dep::date, ret.end_date)
       -- расселённые считаются по размещению
       AND NOT EXISTS (SELECT 1 FROM res x WHERE x.d = dd.d AND x.vaishnava_id = g.vaishnava_id)
  )
  SELECT f.d, 'resident', f.id, f.vaishnava_id, f.retreat_id,
         CASE WHEN f.arrived_at IS NULL THEN 'expected'
              WHEN f.slug = 'team' THEN 'team'
              WHEN f.slug = 'volunteer' THEN 'volunteers'
              WHEN f.slug = 'vip' THEN 'vips'
              ELSE 'guests' END,
         f.bf,
         f.ln,
         1
    FROM res_one f
  UNION ALL
  SELECT r.d, 'registration', r.id, r.vaishnava_id, r.retreat_id,
         CASE r.status WHEN 'team' THEN 'team' WHEN 'volunteer' THEN 'volunteers'
                       WHEN 'vip' THEN 'vips' ELSE 'guests' END,
         (r.d <> r.arr::date OR extract(hour FROM r.arr) < 10)
           AND (r.d <> r.v_end OR r.dep IS NULL OR extract(hour FROM r.dep) >= 10),
         (r.d <> r.arr::date OR extract(hour FROM r.arr) < 13)
           AND (r.d <> r.v_end OR (r.dep IS NOT NULL AND extract(hour FROM r.dep) >= 13)),
         1
    FROM reg_rows r
  UNION ALL
  -- ---------- группы ----------
  SELECT dd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups',
         COALESCE(mg.breakfast, false), COALESCE(mg.lunch, false), mg.people_count
    FROM meal_groups mg
    JOIN days dd ON dd.d BETWEEN mg.start_date AND mg.end_date
$function$;
