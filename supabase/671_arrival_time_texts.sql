-- 671: подписи времени у места (670) и склейка одинаковых примечаний поварам (ВГ, 09.10.2026, «Шахматка 13»).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('arrival_expected_at', 'Ожидается в ~', 'Expected at ~', 'अपेक्षित समय ~'),
    ('departure_leaves_at', 'Уезжает в ~', 'Leaves at ~', 'प्रस्थान ~'),
    ('arrival_hint_all', 'успевает на завтрак и обед', 'in time for breakfast and lunch', 'नाश्ते और दोपहर के भोजन के समय तक'),
    ('arrival_hint_no_breakfast', 'опоздает на завтрак', 'will miss breakfast', 'नाश्ता छूट जाएगा'),
    ('arrival_hint_no_lunch', 'опоздает на обед', 'will miss lunch', 'दोपहर का भोजन छूट जाएगा'),
    ('departure_hint_no_meals', 'уедет до завтрака — в этот день не ест', 'leaves before breakfast — no meals that day', 'नाश्ते से पहले जाएगा — उस दिन भोजन नहीं'),
    ('departure_hint_breakfast', 'позавтракает, обед не считается', 'has breakfast, lunch not counted', 'नाश्ता करेगा, दोपहर का भोजन नहीं गिना जाएगा'),
    ('departure_hint_lunch', 'пообедает перед отъездом', 'has lunch before leaving', 'जाने से पहले दोपहर का भोजन करेगा'),
    ('arrival_keep_breakfast', 'Оставить завтрак', 'Keep breakfast aside', 'नाश्ता रख दें'),
    ('arrival_keep_lunch', 'Оставить обед', 'Keep lunch aside', 'दोपहर का भोजन रख दें'),
    ('arrival_legacy_hint', 'Старая отметка — считается как раньше. Снимите и укажите время.', 'Old mark — counted as before. Untick it and set the time.', 'पुराना निशान — पहले की तरह गिना जाता है। हटाकर समय डालें।'),
    ('kitchen_note_label', 'Примечание поварам', 'Note for the cooks', 'रसोइयों के लिए नोट'),
    ('kitchen_note_placeholder', 'Например: приедут позже, отложить две порции', 'E.g.: arriving later, keep two portions', 'जैसे: देर से आएँगे, दो भाग रख दें')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);

-- Одинаковые строки (безымянные места одной брони) — одной строкой «×N»
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
  SELECT x.d, x.name, x.note || CASE WHEN count(*) > 1 THEN ' (×' || count(*) || ')' ELSE '' END
    FROM (
      -- день приезда: «ожидается в ~» + «оставить» (если пропускает приём) и/или примечание поварам
      SELECT r.check_in AS d,
             COALESCE(nullif(btrim(v.spiritual_name), ''),
                      nullif(btrim(concat_ws(' ', v.first_name, v.last_name)), ''),
                      nullif(btrim(r.guest_name), ''),
                      nullif(btrim(b.name), ''), '—') AS name,
             concat_ws('. ',
               nullif(concat_ws(' — ',
                 CASE WHEN r.arrival_time IS NOT NULL THEN 'ожидается в ~' || to_char(r.arrival_time, 'HH24:MI') END,
                 CASE WHEN r.keep_arrival_meal AND r.arrival_time >= time '09:00'
                      THEN CASE WHEN r.arrival_time >= time '14:00' THEN 'оставить обед' ELSE 'оставить завтрак' END END), ''),
               nullif(btrim(r.kitchen_note), '')) AS note
        FROM residents r
        LEFT JOIN vaishnavas v ON v.id = r.vaishnava_id
        LEFT JOIN bookings b ON b.id = r.booking_id
       WHERE r.check_in BETWEEN p_from AND p_to
         AND ((r.keep_arrival_meal AND r.arrival_time >= time '09:00') OR nullif(btrim(r.kitchen_note), '') IS NOT NULL)
         AND r.status IN ('confirmed', 'checked_out')
         AND r.has_meals IS DISTINCT FROM false
    ) x
   GROUP BY x.d, x.name, x.note
$function$;
