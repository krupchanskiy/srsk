-- Вкушающие: одна формула для сайта и бота.
--
-- До сих пор расчёт жил в двух копиях: в браузере (js/eating-utils.js) и в
-- базе (eating_counts, для бота). С 6 сентября браузерную копию правили
-- трижды, а базовую ни разу — и бот разошёлся с сайтом: не видел продлённого
-- периода питания (Элиада: живёт до 30.09, обедает до 12.10 — у бота на обед
-- 1–12 октября на человека меньше), не брал время рейса у заселённых и
-- применял час рейса к чужому дню (24.09.2026).
--
-- Теперь расчёт один — eating_detail, построчно «кто ест в этот день».
-- Сайт берёт итоги через eating_by_event, бот — через eating_counts; обе
-- функции только суммируют eating_detail, поэтому разойтись им нечем.
--
-- Заодно возвращён обед в день выезда тем, кто уезжает после 13:00. В правке
-- от 06.09 проверка стала «обед И вылет после 13», а обед в последний день
-- по умолчанию снят — и уезжающий в 15:00 оставался без обеда. Решение ВГ
-- (24.09.2026): уезжает после 13 — успевает поесть, обед даём, как до 06.09.
--
-- Правила:
--   • резидент ест, если has_meals не «нет», в пределах периода питания
--     (meal_start_date/meal_end_date, по умолчанию — заезд/выезд);
--   • день заезда без завтрака, день выезда без обеда — если нет отметки
--     раннего заезда / позднего выезда;
--   • у вайшнава с регистрацией на ретрит время приезда/отъезда (или рейса)
--     уточняет свой день: завтрак — прилёт до 10; в день отъезда завтрак —
--     вылет с 10, обед — вылет с 13; уехал раньше конца брони — не ест;
--   • галочки «Завтрак»/«Обед» из брони сильнее всего перечисленного;
--   • ожидаемый — бронь, не отмеченная приехавшей;
--   • незаселённые участники ретрита — по своей регистрации, без даты
--     приезда не считаются;
--   • группы (meal_groups) — своими галочками.

create or replace function eating_detail(p_from date, p_to date)
returns table (
  d date, kind text, ref_id uuid, vaishnava_id uuid, retreat_id uuid,
  bucket text, breakfast boolean, lunch boolean, people int)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
  -- ---------- размещённые и забронированные ----------
  res AS (
    SELECT dd.d, r.id, r.vaishnava_id, r.retreat_id, rc.slug, r.arrived_at,
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
     WHERE r.status = 'confirmed'
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
         -- галочки «Завтрак»/«Обед» сильнее любых уточнений
         f.bf0 AND f.bf_flag IS DISTINCT FROM false,
         f.ln0 AND f.ln_flag IS DISTINCT FROM false,
         1
    FROM res_flags f
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

-- Итоги по дню, приёму пищи и событию (ретрит; NULL — без события).
-- Этим пользуется сайт: меню, склад, себестоимость.
create or replace function eating_by_event(p_from date, p_to date)
returns table (
  d date, meal text, retreat_id uuid,
  team int, volunteers int, vips int, guests int, groups int, expected int)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT e.d, m.meal, e.retreat_id,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'team'), 0)::int,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'volunteers'), 0)::int,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'vips'), 0)::int,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'guests'), 0)::int,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'groups'), 0)::int,
         COALESCE(sum(e.people) FILTER (WHERE e.bucket = 'expected'), 0)::int
    FROM eating_detail(p_from, p_to) e
    CROSS JOIN LATERAL (VALUES ('breakfast', e.breakfast), ('lunch', e.lunch)) m(meal, eats)
   WHERE m.eats
   GROUP BY e.d, m.meal, e.retreat_id
$function$;

-- Итоги по дню и приёму пищи — для бота. Сигнатура прежняя.
create or replace function eating_counts(p_from date, p_to date)
returns table (
  d date, meal text,
  team int, volunteers int, vips int, guests int, groups int, expected int)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT g.d::date, m.meal,
         COALESCE(sum(b.team), 0)::int, COALESCE(sum(b.volunteers), 0)::int,
         COALESCE(sum(b.vips), 0)::int, COALESCE(sum(b.guests), 0)::int,
         COALESCE(sum(b.groups), 0)::int, COALESCE(sum(b.expected), 0)::int
    FROM generate_series(p_from, p_to, interval '1 day') g(d)
    CROSS JOIN (VALUES ('breakfast'), ('lunch')) m(meal)
    LEFT JOIN eating_by_event(p_from, p_to) b ON b.d = g.d::date AND b.meal = m.meal
   GROUP BY g.d, m.meal
   ORDER BY g.d, m.meal
$function$;

revoke execute on function eating_detail(date, date) from public, anon;
revoke execute on function eating_by_event(date, date) from public, anon;
grant execute on function eating_detail(date, date) to authenticated, service_role;
grant execute on function eating_by_event(date, date) to authenticated, service_role;
grant execute on function eating_counts(date, date) to authenticated, service_role;
