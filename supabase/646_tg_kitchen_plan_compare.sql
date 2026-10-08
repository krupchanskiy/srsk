-- «План на завтра» кухни: рядом с числом — сколько было в плане на предыдущую дату.
-- Просьба Сундары Рупы 08.10: «Завтрак: 54 (08.10 — 53)», чтобы видеть динамику.
-- Сравнение — ровно с тем числом, что бот прислал вчерашним планом, а не пересчитанным:
-- иначе цифра в скобках расходится с той, что повар видел в чате.

CREATE TABLE IF NOT EXISTS tg_eating_plan_sent (
    d          date PRIMARY KEY,
    breakfast  int NOT NULL,
    lunch      int NOT NULL,
    sent_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tg_eating_plan_sent ENABLE ROW LEVEL SECURITY;

-- План на 08.10 ушёл 07.10 до появления таблицы — цифры из отправленного сообщения
INSERT INTO tg_eating_plan_sent (d, breakfast, lunch, sent_at)
VALUES ('2026-10-08', 58, 68, '2026-10-07 02:30:00+00')
ON CONFLICT (d) DO NOTHING;

DROP FUNCTION IF EXISTS public.tg_eating_text(date, boolean);

-- p_compare = true — только для «Плана на завтра»: «(дд.мм — N)» из tg_eating_plan_sent
CREATE OR REPLACE FUNCTION public.tg_eating_text(p_date date, p_detail boolean DEFAULT false,
                                                 p_compare boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bf record; ln record;
  prev tg_eating_plan_sent%rowtype;
  v_line text;
  parts text;
BEGIN
  SELECT * INTO bf FROM eating_counts(p_date, p_date) WHERE meal = 'breakfast';
  SELECT * INTO ln FROM eating_counts(p_date, p_date) WHERE meal = 'lunch';
  IF bf IS NULL THEN RETURN NULL; END IF;

  IF p_compare THEN
    SELECT * INTO prev FROM tg_eating_plan_sent WHERE d = p_date - 1;
  END IF;

  v_line := format('🍽 <b>Вкушающие %s</b>', to_char(p_date, 'DD.MM.YYYY'));

  parts := concat_ws(E'\n',
    CASE WHEN bf.team > 0 THEN 'Команда – ' || bf.team END,
    CASE WHEN bf.volunteers > 0 THEN 'Волонтёры – ' || bf.volunteers END,
    CASE WHEN bf.vips > 0 THEN 'Важные гости – ' || bf.vips END,
    CASE WHEN bf.guests > 0 THEN 'Гости – ' || bf.guests END,
    CASE WHEN bf.groups > 0 THEN 'Группы – ' || bf.groups END,
    CASE WHEN bf.expected > 0 THEN 'Ожидаются – ' || bf.expected END,
    CASE WHEN bf.expected > 0 THEN '<i>«Ожидаются» — бронь есть, гость ещё не заселён.</i>' END);
  v_line := v_line || format(E'\n☀️ Завтрак: <b>%s</b>',
                             bf.team + bf.volunteers + bf.vips + bf.guests + bf.groups + bf.expected)
                   || CASE WHEN prev.d IS NOT NULL
                           THEN format(' (%s — %s)', to_char(prev.d, 'DD.MM'), prev.breakfast) ELSE '' END
                   || CASE WHEN p_detail AND parts <> '' THEN E'\n<blockquote>' || parts || '</blockquote>' ELSE '' END;

  parts := concat_ws(E'\n',
    CASE WHEN ln.team > 0 THEN 'Команда – ' || ln.team END,
    CASE WHEN ln.volunteers > 0 THEN 'Волонтёры – ' || ln.volunteers END,
    CASE WHEN ln.vips > 0 THEN 'Важные гости – ' || ln.vips END,
    CASE WHEN ln.guests > 0 THEN 'Гости – ' || ln.guests END,
    CASE WHEN ln.groups > 0 THEN 'Группы – ' || ln.groups END,
    CASE WHEN ln.expected > 0 THEN 'Ожидаются – ' || ln.expected END,
    CASE WHEN ln.expected > 0 THEN '<i>«Ожидаются» — бронь есть, гость ещё не заселён.</i>' END);
  v_line := v_line || format(E'\n🍛 Обед: <b>%s</b>',
                             ln.team + ln.volunteers + ln.vips + ln.guests + ln.groups + ln.expected)
                   || CASE WHEN prev.d IS NOT NULL
                           THEN format(' (%s — %s)', to_char(prev.d, 'DD.MM'), prev.lunch) ELSE '' END
                   || CASE WHEN p_detail AND parts <> '' THEN E'\n<blockquote>' || parts || '</blockquote>' ELSE '' END;

  -- примечания к этому дню для поваров (640)
  SELECT string_agg('• ' || replace(replace(replace(mg.name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                    || ': ' || replace(replace(replace(gd.note, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                    E'\n' ORDER BY mg.name)
    INTO parts
    FROM meal_group_days gd
    JOIN meal_groups mg ON mg.id = gd.group_id AND mg.by_day
   WHERE gd.d = p_date AND nullif(btrim(gd.note), '') IS NOT NULL;
  IF parts IS NOT NULL THEN
    v_line := v_line || E'\n\n📝 <b>Примечания</b>\n' || parts;
  END IF;

  RETURN v_line;
END;
$function$;

grant execute on function tg_eating_text(date, boolean, boolean) to authenticated, service_role, anon;

-- Текст «Плана на завтра» целиком — им пользуются и утренняя отправка, и кнопка «Подробнее»
CREATE OR REPLACE FUNCTION public.tg_kitchen_plan_text(p_date date, p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT format('📋 <b>План на завтра (%s)</b>', to_char(p_date, 'DD.MM')) || E'\n'
         || tg_eating_text(p_date, p_detail, true);
$function$;

grant execute on function tg_kitchen_plan_text(date, boolean) to service_role;

CREATE OR REPLACE FUNCTION public.tg_kitchen_morning()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_chat bigint; v_txt text; v_id bigint;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат кухни не привязан');
  END IF;

  v_txt := tg_kitchen_plan_text(current_date + 1, false);
  IF v_txt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'нет данных'); END IF;

  BEGIN
    INSERT INTO tg_outbox (chat_id, text, reply_to, kind, reply_markup)
    VALUES (v_chat, v_txt, NULL, 'notify',
            jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
              jsonb_build_object('text', 'Подробнее',
                                 'callback_data', format('eat:1:%s:p', current_date + 1))))))
    RETURNING id INTO v_id;
    PERFORM tg_outbox_try(v_id);
  EXCEPTION WHEN others THEN NULL;
  END;

  -- запоминаем отправленные числа: завтрашний план сравнит с ними.
  -- Отдельным блоком — сбой здесь не должен отменить отправку сообщения.
  BEGIN
    INSERT INTO tg_eating_plan_sent (d, breakfast, lunch)
    SELECT current_date + 1,
           coalesce(sum(team + volunteers + vips + guests + groups + expected) FILTER (WHERE meal = 'breakfast'), 0),
           coalesce(sum(team + volunteers + vips + guests + groups + expected) FILTER (WHERE meal = 'lunch'), 0)
      FROM eating_counts(current_date + 1, current_date + 1)
    ON CONFLICT (d) DO UPDATE SET breakfast = excluded.breakfast, lunch = excluded.lunch, sent_at = now();
  EXCEPTION WHEN others THEN NULL;
  END;
  RETURN jsonb_build_object('ok', true, 'date', current_date + 1);
END;
$function$;
