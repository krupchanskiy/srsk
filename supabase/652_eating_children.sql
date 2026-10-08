-- 652: дети на кухне (ВГ, 08.10.2026, «Шахматка 9»).
-- Ребёнок младше 7 лет (vaishnavas.birth_date на день питания) — не порция: ест с мамой
-- из одной тарелки, денег не берём. С 7 лет — полная обычная порция.
-- Нет даты рождения или ребёнок не подтверждён (651) — считаем как взрослого (⚠ на «Прасаде»).
-- Регистрации с «детским питанием» (meal_type = 'child') теперь тоже в расчёте —
-- раньше без места в шахматке они не считались вовсе, а время рейса не уточняло их края.
-- Деньги (crm_calc_participation, «Начислить группе/гостю») берут приёмы отсюда же:
-- у малыша приёмов нет — питание 0, как и раньше по 100% скидке.

-- Ребёнок без кровати (resident_children, 650) ест в дни родителя и с его приёмами,
-- если сам не размещён и не участник с датами на этот день; возраст — из карточки или своей даты.

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
       -- детское питание — тоже порция; малышей до 7 отсекает возраст ниже
       AND (rr.meal_type IN ('prasad', 'child') OR rr.meal_type IS NULL)
  ),
  -- ---------- размещённые, забронированные и уже выехавшие ----------
  res AS (
    SELECT dd.d, r.id, r.vaishnava_id, r.retreat_id, rc.slug,
           -- заехал: своя отметка или переезд встык из брони с отметкой
           (r.arrived_at IS NOT NULL OR (r.vaishnava_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM residents p
               WHERE p.vaishnava_id = r.vaishnava_id AND p.id <> r.id
                 AND p.arrived_at IS NOT NULL
                 AND p.status IN ('confirmed', 'checked_out')
                 AND p.check_in < r.check_in
                 AND p.check_out BETWEEN r.check_in - 1 AND r.check_in))) AS arrived,
           r.status AS r_status, r.check_in,
           r.breakfast AS bf_flag, r.lunch AS ln_flag,
           COALESCE(r.early_checkin, false) AS early,
           COALESCE(r.late_checkout, false) AS late,
           (dd.d = r.check_in) AS is_first,
           (r.check_out IS NOT NULL AND dd.d = r.check_out) AS is_last,
           rg.arr, rg.dep,
           -- предупредил, что не будет на приёме в этот день (617)
           COALESCE(sk.breakfast, false) AS skip_b,
           COALESCE(sk.lunch, false) AS skip_l
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
      LEFT JOIN resident_meal_skips sk ON sk.resident_id = r.id AND sk.d = dd.d
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
           END AND NOT x.skip_b AS bf0,
           CASE
             WHEN x.is_last AND NOT x.late AND x.dep::date < x.d THEN false
             -- уезжает после 13 — успевает пообедать
             WHEN x.is_last AND NOT x.late AND x.dep::date = x.d
               THEN extract(hour FROM x.dep) >= 13
             ELSE (NOT x.is_last OR x.late)
           END AND NOT x.skip_l AS ln0
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
  ),
  res_bucketed AS (
    SELECT f.*,
           CASE WHEN NOT f.arrived THEN 'expected'
                WHEN f.slug = 'team' THEN 'team'
                WHEN f.slug = 'volunteer' THEN 'volunteers'
                WHEN f.slug = 'vip' THEN 'vips'
                ELSE 'guests' END AS bucket
      FROM res_one f
  ),
  people_rows AS (
    SELECT f.d, 'resident' AS kind, f.id AS ref_id, f.vaishnava_id, f.retreat_id,
           f.bucket, f.bf AS breakfast, f.ln AS lunch, NULL::date AS bd
      FROM res_bucketed f
    UNION ALL
    SELECT r.d, 'registration', r.id, r.vaishnava_id, r.retreat_id,
           CASE r.status WHEN 'team' THEN 'team' WHEN 'volunteer' THEN 'volunteers'
                         WHEN 'vip' THEN 'vips' ELSE 'guests' END,
           (r.d <> r.arr::date OR extract(hour FROM r.arr) < 10)
             AND (r.d <> r.v_end OR r.dep IS NULL OR extract(hour FROM r.dep) >= 10),
           (r.d <> r.arr::date OR extract(hour FROM r.arr) < 13)
             AND (r.d <> r.v_end OR (r.dep IS NOT NULL AND extract(hour FROM r.dep) >= 13)),
           NULL::date
      FROM reg_rows r
    UNION ALL
    -- ребёнок без кровати (650) — в дни родителя и с его приёмами, если сам не размещён
    -- и не участник с датами на этот день
    SELECT f.d, 'extra_child', c.id, c.vaishnava_id, f.retreat_id,
           f.bucket, f.bf, f.ln, c.birth_date
      FROM res_bucketed f
      JOIN resident_children c ON c.resident_id = f.id
     WHERE c.vaishnava_id IS NULL
        OR (NOT EXISTS (SELECT 1 FROM res x WHERE x.d = f.d AND x.vaishnava_id = c.vaishnava_id)
            AND NOT EXISTS (SELECT 1 FROM reg_rows g WHERE g.d = f.d AND g.vaishnava_id = c.vaishnava_id))
  )
  -- подтверждённый ребёнок (651) младше 7 лет на этот день — не порция; у «+1» без карточки
  -- дата своя — добавление в шахматке и есть подтверждение
  SELECT p.d, p.kind, p.ref_id, p.vaishnava_id, p.retreat_id, p.bucket, p.breakfast, p.lunch, 1
    FROM people_rows p
    LEFT JOIN vaishnavas v ON v.id = p.vaishnava_id
    CROSS JOIN LATERAL (SELECT COALESCE(CASE WHEN v.child_confirmed_at IS NOT NULL THEN v.birth_date END, p.bd) AS bd) k
   WHERE k.bd IS NULL OR p.d >= k.bd + interval '7 years'
  UNION ALL
  -- ---------- группы ----------
  SELECT dd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups',
         COALESCE(mg.breakfast, false), COALESCE(mg.lunch, false), mg.people_count
    FROM meal_groups mg
    JOIN days dd ON dd.d BETWEEN mg.start_date AND mg.end_date
   WHERE NOT mg.by_day
  UNION ALL
  -- «По дням» (640): завтрак и обед — отдельными строками со своим числом
  SELECT gd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups', m.b, NOT m.b, m.n
    FROM meal_groups mg
    JOIN meal_group_days gd ON gd.group_id = mg.id
    CROSS JOIN LATERAL (VALUES (true, gd.breakfast), (false, gd.lunch)) m(b, n)
   WHERE mg.by_day
     AND gd.d BETWEEN p_from AND p_to
     AND gd.d BETWEEN mg.start_date AND mg.end_date
     AND m.n > 0
$function$;
