-- «Изменилось количество вкушающих» (просьба ВГ 24.09.2026). Итог миграций 474–476:
--  • сегодня и завтра — любое изменение, без восклицательного знака;
--  • дальше завтрашнего дня — только сдвиг от 10 человек, с ❗ и при прибавке, и при убыли;
--  • сообщение сгруппировано по датам: дата → Завтрак → Обед;
--  • сегодняшний завтрак после 08:00 и обед после 13:00 (по Индии) не сообщаются —
--    число просто запоминается, чтобы завтра не всплыло старое;
--  • «сегодня» считается по Индии, а не по часовому поясу сервера.
CREATE OR REPLACE FUNCTION public.tg_notify_eating_changes(p_days integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  c_big constant int := 10;
  c_breakfast_end constant time := '08:00';
  c_lunch_end constant time := '13:00';
  v_chat bigint;
  r record;
  v_lines text := '';
  v_count int := 0;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_time time := (now() AT TIME ZONE 'Asia/Kolkata')::time;
  v_delta int;
  v_past boolean;
  v_last date;
  v_line text;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат кухни не привязан');
  END IF;

  FOR r IN
    SELECT c.d, c.meal,
           (c.team + c.volunteers + c.vips + c.guests + c.groups + c.expected) AS total,
           s.total AS was
      FROM eating_counts(v_today, v_today + p_days) c
      LEFT JOIN tg_eating_seen s ON s.d = c.d AND s.meal = c.meal
     ORDER BY c.d, (c.meal = 'lunch')
  LOOP
    IF r.was IS NULL THEN
      INSERT INTO tg_eating_seen (d, meal, total) VALUES (r.d, r.meal, r.total)
        ON CONFLICT (d, meal) DO UPDATE SET total = excluded.total, updated_at = now();
      CONTINUE;
    END IF;

    v_past := r.d = v_today AND (
      (r.meal = 'breakfast' AND v_time >= c_breakfast_end) OR
      (r.meal = 'lunch' AND v_time >= c_lunch_end));
    IF v_past THEN
      UPDATE tg_eating_seen SET total = r.total, updated_at = now()
       WHERE d = r.d AND meal = r.meal AND total <> r.total;
      CONTINUE;
    END IF;

    v_delta := r.total - r.was;
    CONTINUE WHEN v_delta = 0;

    IF r.d <= v_today + 1 THEN
      v_line := format('%s %s: <b>%s</b> (было %s)',
        CASE WHEN v_delta > 0 THEN '▲' ELSE '▼' END,
        CASE WHEN r.meal = 'breakfast' THEN 'Завтрак' ELSE 'Обед' END, r.total, r.was);
    ELSE
      CONTINUE WHEN abs(v_delta) < c_big;
      v_line := format('%s %s: <b>%s</b> (было %s) — %s %s',
        CASE WHEN v_delta > 0 THEN '❗▲' ELSE '❗▼' END,
        CASE WHEN r.meal = 'breakfast' THEN 'Завтрак' ELSE 'Обед' END, r.total, r.was,
        CASE WHEN v_delta > 0 THEN 'прибавилось' ELSE 'убавилось' END, abs(v_delta));
    END IF;

    IF v_last IS DISTINCT FROM r.d THEN
      v_lines := v_lines || format(E'\n\n<b>%s</b>%s', to_char(r.d, 'DD.MM'),
        CASE WHEN r.d = v_today THEN ' (сегодня)' WHEN r.d = v_today + 1 THEN ' (завтра)' ELSE '' END);
      v_last := r.d;
    END IF;
    v_lines := v_lines || E'\n' || v_line;
    v_count := v_count + 1;

    UPDATE tg_eating_seen SET total = r.total, updated_at = now()
     WHERE d = r.d AND meal = r.meal;
  END LOOP;

  IF v_count = 0 THEN RETURN jsonb_build_object('ok', true, 'changes', 0); END IF;

  PERFORM tg_send_chat(v_chat,
    '🔔 <b>Изменилось количество вкушающих</b>' || v_lines,
    NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'changes', v_count);
END;
$function$;

-- Проверки: каждые 15 минут утром (05:30–08:30 по Индии) и перед обедом (10:30–13:15), чтобы
-- изменение до границы 08:00/13:00 успевало прийти; в остальное время раз в час.
-- Окна не пересекаются: параллельный запуск дал бы двойное сообщение.
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'eating-changes'),
                      schedule := '30 3-4,8-14 * * *');
SELECT cron.schedule('eating-changes-frequent', '*/15 0-2,5-7 * * *', 'SELECT tg_notify_eating_changes(7)');
