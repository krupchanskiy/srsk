-- 670: время у места в шахматке вместо галочек «ранний заезд / поздний выезд» (ВГ, 08–09.10.2026,
-- «Шахматка 13»). «Ожидается в ~» / «Уезжает в ~» — примерно; пусто — как раньше.
-- Пороги прасада с 10.10.2026: ожидается до 9:00 — завтрак, до 14:00 — обед; уезжает после 9:00 —
-- позавтракал, после 14:00 — пообедал. До 10.10 — прежние 10/13 (прошлое не пересчитываем).
-- «Оставить» — только к приезду и только когда из-за времени человек пропускает приём:
-- порция считается, поварам строка в «📝 Примечания» (как у «Разового питания» по дням, 640/641).
-- К отъезду «Оставить» не нужно (ВГ): время отъезда — для подсчёта и доплаты за поздний выезд.
-- Старые галочки early_checkin / late_checkout не трогаем — считаются как раньше.

ALTER TABLE residents
    ADD COLUMN IF NOT EXISTS arrival_time time,
    ADD COLUMN IF NOT EXISTS departure_time time,
    ADD COLUMN IF NOT EXISTS keep_arrival_meal boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS kitchen_note text;

COMMENT ON COLUMN residents.arrival_time IS 'Ожидается в ~ (примерно), день check_in; пусто — по регистрации или как раньше';
COMMENT ON COLUMN residents.departure_time IS 'Уезжает в ~ (примерно), день check_out';
COMMENT ON COLUMN residents.keep_arrival_meal IS 'Оставить пропущенный из-за времени приезда приём (до 14 — завтрак, после — обед)';
COMMENT ON COLUMN residents.kitchen_note IS 'Примечание поварам — в «📝 Примечания» в день приезда';

CREATE OR REPLACE FUNCTION public.eating_detail(p_from date, p_to date)
 RETURNS TABLE(d date, kind text, ref_id uuid, vaishnava_id uuid, retreat_id uuid, bucket text, breakfast boolean, lunch boolean, people integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH days AS (
    SELECT g::date AS d,
           -- пороги приёмов (670): с 10.10.2026 — 9/14, раньше — 10/13
           CASE WHEN g::date >= DATE '2026-10-10' THEN 9 ELSE 10 END AS bh,
           CASE WHEN g::date >= DATE '2026-10-10' THEN 14 ELSE 13 END AS lh
      FROM generate_series(p_from, p_to, interval '1 day') g
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
    SELECT dd.d, dd.bh, dd.lh, r.id, r.vaishnava_id, r.retreat_id, rc.slug,
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
           -- время у места (670) сильнее времени регистрации
           CASE WHEN r.arrival_time IS NOT NULL THEN r.check_in + r.arrival_time ELSE rg.arr END AS arr,
           CASE WHEN r.departure_time IS NOT NULL AND r.check_out IS NOT NULL
                THEN r.check_out + r.departure_time ELSE rg.dep END AS dep,
           r.keep_arrival_meal AS keep_a,
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
  res_t AS (
    SELECT x.*,
           -- уехал раньше, чем кончается бронь — кормить некого
           COALESCE(x.is_last AND NOT x.late AND x.dep::date < x.d, false) AS gone,
           -- время приезда/отъезда уточняет только свой день; старые галочки сильнее
           COALESCE(x.is_first AND NOT x.early AND x.arr::date = x.d, false) AS arr_today,
           COALESCE(x.is_last AND NOT x.late AND x.dep::date = x.d, false) AS dep_today,
           extract(hour FROM x.arr) AS ah,
           extract(hour FROM x.dep) AS dh
      FROM res x
  ),
  res_flags AS (
    SELECT x.*,
           NOT x.gone
           AND CASE WHEN x.arr_today
                    -- приехал после завтрака, но до обеда: «Оставить» — завтрак
                    THEN x.ah < x.bh OR (x.keep_a AND x.ah < x.lh)
                    ELSE (NOT x.is_first OR x.early) END
           AND CASE WHEN x.dep_today THEN x.dh >= x.bh ELSE true END
           AND NOT x.skip_b AS bf0,
           NOT x.gone
           -- с 10.10: ожидается после обеда — обед не считается, если не «Оставить»
           AND CASE WHEN x.arr_today AND x.d >= DATE '2026-10-10'
                    THEN x.ah < x.lh OR x.keep_a
                    ELSE true END
           AND CASE WHEN x.dep_today
                    -- уезжает после обеда — успевает пообедать
                    THEN x.dh >= x.lh
                    ELSE (NOT x.is_last OR x.late) END
           AND NOT x.skip_l AS ln0
      FROM res_t x
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
    SELECT dd.d, dd.bh, dd.lh, g.id, g.vaishnava_id, g.retreat_id, g.status,
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
           (r.d <> r.arr::date OR extract(hour FROM r.arr) < r.bh)
             AND (r.d <> r.v_end OR r.dep IS NULL OR extract(hour FROM r.dep) >= r.bh),
           (r.d <> r.arr::date OR extract(hour FROM r.arr) < r.lh)
             AND (r.d <> r.v_end OR (r.dep IS NOT NULL AND extract(hour FROM r.dep) >= r.lh)),
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

-- ---------- Примечания поварам за период: группы «по дням» (640) + люди из шахматки (670) ----------
CREATE OR REPLACE FUNCTION public.eating_day_notes(p_from date, p_to date)
 RETURNS TABLE(d date, name text, note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT gd.d, mg.name, btrim(gd.note)
    FROM meal_group_days gd
    JOIN meal_groups mg ON mg.id = gd.group_id AND mg.by_day
   WHERE gd.d BETWEEN p_from AND p_to AND nullif(btrim(gd.note), '') IS NOT NULL
  UNION ALL
  -- день приезда: «ожидается в ~» + «оставить» (если пропускает приём) и/или примечание поварам
  SELECT r.check_in,
         COALESCE(nullif(btrim(v.spiritual_name), ''),
                  nullif(btrim(concat_ws(' ', v.first_name, v.last_name)), ''),
                  nullif(btrim(r.guest_name), ''),
                  nullif(btrim(b.name), ''), '—'),
         concat_ws('. ',
           nullif(concat_ws(' — ',
             CASE WHEN r.arrival_time IS NOT NULL THEN 'ожидается в ~' || to_char(r.arrival_time, 'HH24:MI') END,
             CASE WHEN r.keep_arrival_meal AND r.arrival_time >= time '09:00'
                  THEN CASE WHEN r.arrival_time >= time '14:00' THEN 'оставить обед' ELSE 'оставить завтрак' END END), ''),
           nullif(btrim(r.kitchen_note), ''))
    FROM residents r
    LEFT JOIN vaishnavas v ON v.id = r.vaishnava_id
    LEFT JOIN bookings b ON b.id = r.booking_id
   WHERE r.check_in BETWEEN p_from AND p_to
     AND ((r.keep_arrival_meal AND r.arrival_time >= time '09:00') OR nullif(btrim(r.kitchen_note), '') IS NOT NULL)
     AND r.status IN ('confirmed', 'checked_out')
     AND r.has_meals IS DISTINCT FROM false
$function$;

REVOKE ALL ON FUNCTION public.eating_day_notes(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.eating_day_notes(date, date) TO authenticated, service_role;

-- ---------- Бот кухни: примечания из eating_day_notes (группы + люди), как в 641 ----------
do $mig$
declare
    src text := pg_get_functiondef('public.tg_eating_text(date,boolean,boolean)'::regprocedure);
    old_part text := $o$  SELECT string_agg('• ' || replace(replace(replace(mg.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                    || ': ' || replace(replace(replace(gd.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                    E'\n' ORDER BY mg.name)
    INTO parts
    FROM meal_group_days gd
    JOIN meal_groups mg ON mg.id = gd.group_id AND mg.by_day
   WHERE gd.d = p_date AND nullif(btrim(gd.note), '') IS NOT NULL;$o$;
    new_part text := $n$  SELECT string_agg('• ' || replace(replace(replace(n.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                    || ': ' || replace(replace(replace(n.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                    E'\n' ORDER BY n.name)
    INTO parts
    FROM eating_day_notes(p_date, p_date) n;$n$;
begin
    if position(old_part in src) = 0 then
        raise exception 'tg_eating_text: блок примечаний (641) не найден — функция менялась, правьте миграцию';
    end if;
    execute replace(src, old_part, new_part);
end
$mig$;
