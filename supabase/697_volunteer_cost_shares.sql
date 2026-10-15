-- 697: волонтёры в себестоимости прасада (решение ВГ + Ачинтья Кришна 15.10, «Задачи кухни 9/10»)
--
-- Две новые категории места в шахматке:
--   «Волонтёр ретрита» (retreat_volunteer) — в брони отмечаются ретриты, на которые приехал
--     (residents.serves_retreat_ids). В дни ретрита его питание — этому ретриту (два в один день —
--     пополам); дни ожидания до, между и после — поровну на все отмеченные ретриты.
--   «Волонтёр ШРСК» (shrsk_volunteer) — ничего не отмечается: любой ретрит, кроме закрытых
--     (не is_public и не is_external — Художники), в свои дни ± 3 дня берёт его питание
--     (несколько ретритов — поровну); остальное — общий расход «Волонтёры ШРСК».
-- Это расход ретрита, а не начисление; в «на участника» не входит (категория — волонтёры).
--
-- Поварам и боту ничего не меняется: eating_detail / eating_by_event отдают тех же людей,
-- новые категории просто попадают в «волонтёры». Доли считает отдельная функция
-- eating_detail_cost — её берёт только себестоимость.

INSERT INTO resident_categories (slug, name_ru, name_en, name_hi, color, sort_order)
SELECT v.* FROM (VALUES
    ('retreat_volunteer', 'Волонтёр ретрита', 'Retreat volunteer', 'रिट्रीट स्वयंसेवक', '#eab308', 4),
    ('shrsk_volunteer',   'Волонтёр ШРСК',    'SRSK volunteer',    'SRSK स्वयंसेवक',    '#b45309', 4)
) v(slug, name_ru, name_en, name_hi, color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM resident_categories c WHERE c.slug = v.slug);

ALTER TABLE residents ADD COLUMN IF NOT EXISTS serves_retreat_ids uuid[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN residents.serves_retreat_ids IS
    '«Волонтёр ретрита»: ретриты, на которые приехал служить (питание за приезд делится между ними, мигр. 697)';

-- Новые категории — «волонтёры» и для кухни (а не гости-участники)
DO $$
DECLARE s text;
BEGIN
    s := pg_get_functiondef('public.eating_detail(date, date)'::regprocedure);
    s := replace(s, $x$WHEN f.slug = 'volunteer' THEN 'volunteers'$x$,
                    $x$WHEN f.slug IN ('volunteer', 'retreat_volunteer', 'shrsk_volunteer') THEN 'volunteers'$x$);
    IF position('retreat_volunteer' IN s) = 0 THEN RAISE EXCEPTION 'eating_detail: не найдена строка категории волонтёра'; END IF;
    EXECUTE s;

    -- место с ретритом создаёт регистрацию — у новых категорий статус «волонтёр», не «гость»
    s := pg_get_functiondef('public.residents_link_retreat_registration()'::regprocedure);
    s := replace(s, $x$when 'volunteer' then 'volunteer'$x$,
                    $x$when 'volunteer' then 'volunteer' when 'retreat_volunteer' then 'volunteer' when 'shrsk_volunteer' then 'volunteer'$x$);
    IF position('retreat_volunteer' IN s) = 0 THEN RAISE EXCEPTION 'residents_link_retreat_registration: не найдена строка категории'; END IF;
    EXECUTE s;
END $$;

-- Кто и что ел — как eating_detail, но питание волонтёров новых категорий разложено по ретритам.
--   w     — доля строки (1 у всех остальных; волонтёр между двумя ретритами — две строки по 0.5)
--   share — 'retreat_volunteer' | 'retreat_volunteer_unmarked' (ретриты не отмечены — ⚠)
--           | 'shrsk_volunteer' (retreat_id null — общий расход «Волонтёры ШРСК») | null
CREATE OR REPLACE FUNCTION public.eating_detail_cost(p_from date, p_to date)
RETURNS TABLE(d date, kind text, ref_id uuid, vaishnava_id uuid, retreat_id uuid, bucket text,
              breakfast boolean, lunch boolean, people integer, w numeric, share text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT e.*, rc.slug, r.serves_retreat_ids
      FROM eating_detail(p_from, p_to) e
      LEFT JOIN residents r ON e.kind = 'resident' AND r.id = e.ref_id
      LEFT JOIN resident_categories rc ON rc.id = r.category_id
  ),
  targets AS (
    SELECT b.d, b.ref_id,
           CASE WHEN b.slug = 'retreat_volunteer'
                -- в дни отмеченных ретритов — им; ожидание — всем отмеченным поровну
                THEN COALESCE(
                       (SELECT array_agg(x.id) FROM retreats x
                         WHERE x.id = ANY(b.serves_retreat_ids) AND b.d BETWEEN x.start_date AND x.end_date),
                       (SELECT array_agg(x.id) FROM retreats x WHERE x.id = ANY(b.serves_retreat_ids)))
                -- любой открытый ретрит в свои дни ± 3 дня (подготовка и уборка)
                ELSE (SELECT array_agg(x.id) FROM retreats x
                       WHERE (x.is_public OR x.is_external)
                         AND b.d BETWEEN x.start_date - 3 AND x.end_date + 3)
           END AS ids
      FROM base b
     WHERE b.slug IN ('retreat_volunteer', 'shrsk_volunteer')
  )
  SELECT b.d, b.kind, b.ref_id, b.vaishnava_id, b.retreat_id, b.bucket, b.breakfast, b.lunch, b.people,
         1::numeric, NULL::text
    FROM base b
   WHERE b.slug IS NULL OR b.slug NOT IN ('retreat_volunteer', 'shrsk_volunteer')
  UNION ALL
  SELECT b.d, b.kind, b.ref_id, b.vaishnava_id,
         CASE WHEN t.ids IS NULL AND b.slug = 'retreat_volunteer' THEN b.retreat_id ELSE x.id END,
         'volunteers', b.breakfast, b.lunch, b.people,
         CASE WHEN t.ids IS NULL THEN 1 ELSE 1::numeric / cardinality(t.ids) END,
         CASE WHEN t.ids IS NULL AND b.slug = 'retreat_volunteer' THEN 'retreat_volunteer_unmarked' ELSE b.slug END
    FROM base b
    JOIN targets t ON t.d = b.d AND t.ref_id = b.ref_id
    LEFT JOIN LATERAL unnest(t.ids) x(id) ON true
   WHERE b.slug IN ('retreat_volunteer', 'shrsk_volunteer')
$function$;

-- То же по событиям — как eating_by_event, но с дробными долями
CREATE OR REPLACE FUNCTION public.eating_by_event_cost(p_from date, p_to date)
RETURNS TABLE(d date, meal text, retreat_id uuid, team numeric, volunteers numeric, vips numeric,
              guests numeric, groups numeric, expected numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT e.d, m.meal, e.retreat_id,
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'team'), 0),
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'volunteers'), 0),
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'vips'), 0),
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'guests'), 0),
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'groups'), 0),
         COALESCE(sum(e.people * e.w) FILTER (WHERE e.bucket = 'expected'), 0)
    FROM eating_detail_cost(p_from, p_to) e
    CROSS JOIN LATERAL (VALUES ('breakfast', e.breakfast), ('lunch', e.lunch)) m(meal, eats)
   WHERE m.eats
   GROUP BY e.d, m.meal, e.retreat_id
$function$;

REVOKE ALL ON FUNCTION public.eating_detail_cost(date, date) FROM public, anon;
REVOKE ALL ON FUNCTION public.eating_by_event_cost(date, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.eating_detail_cost(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.eating_by_event_cost(date, date) TO authenticated;

-- Подписи шахматки и Себестоимости (в коде есть русский запасной текст)
insert into translations (key, ru, en, hi) values
  ('timeline_serves_retreats', 'Ретриты, на которые приехал служить', 'Retreats they came to serve', 'जिन रिट्रीट में सेवा करने आए'),
  ('timeline_serves_hint', 'Питание за весь приезд делится между отмеченными ретритами, дни ожидания — поровну', 'Meals for the whole stay are split between the ticked retreats; waiting days — equally', 'पूरे प्रवास का भोजन चुने गए रिट्रीट में बँटता है; प्रतीक्षा के दिन — बराबर'),
  ('timeline_serves_none', 'В даты брони ретритов нет', 'No retreats on the booking dates', 'बुकिंग की तिथियों में कोई रिट्रीट नहीं'),
  ('timeline_serves_empty', 'Не отмечены ретриты волонтёра — его питание не попадёт в ретриты, в Себестоимости будет ⚠', 'No retreats ticked — the volunteer''s meals will not go to retreats, Cost will show ⚠', 'रिट्रीट नहीं चुने गए — भोजन रिट्रीट में नहीं जाएगा, लागत में ⚠ दिखेगा'),
  ('timeline_serves_short', 'Служит на ретритах', 'Serves at retreats', 'रिट्रीट में सेवा'),
  ('timeline_serves_not_set', 'не отмечены', 'not ticked', 'चुने नहीं गए'),
  ('cost_w_unmarked', 'Волонтёры ретрита без отмеченных ретритов — их питание не попало в ретриты; отметьте ретриты в брони', 'Retreat volunteers with no retreats ticked — their meals did not go to retreats; tick retreats in the booking', 'बिना चुने रिट्रीट वाले रिट्रीट स्वयंसेवक — भोजन रिट्रीट में नहीं गया; बुकिंग में रिट्रीट चुनें'),
  ('cost_q_unmarked', 'волонтёры ретрита без отмеченных ретритов', 'retreat volunteers with no retreats ticked', 'बिना चुने रिट्रीट वाले रिट्रीट स्वयंसेवक'),
  ('cost_shrsk_volunteers', 'Волонтёры ШРСК (общий расход)', 'SRSK volunteers (general expense)', 'SRSK स्वयंसेवक (सामान्य व्यय)'),
  ('cost_unmarked_row', 'Волонтёры ретрита — ретриты не отмечены', 'Retreat volunteers — retreats not ticked', 'रिट्रीट स्वयंसेवक — रिट्रीट नहीं चुने गए')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
