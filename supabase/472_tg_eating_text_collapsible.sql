-- /сколько: разбивка по категориям сворачивается (blockquote expandable); шапка,
-- «Завтрак»/«Обед» и числа как были (просьба ВГ 24.09.2026). Пояснение про
-- «Ожидаются» — внутри списка, где такие есть.
CREATE OR REPLACE FUNCTION public.tg_eating_text(p_date date)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  bf record; ln record;
  v_line text;
  parts text;
BEGIN
  SELECT * INTO bf FROM eating_counts(p_date, p_date) WHERE meal = 'breakfast';
  SELECT * INTO ln FROM eating_counts(p_date, p_date) WHERE meal = 'lunch';
  IF bf IS NULL THEN RETURN NULL; END IF;

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
                   || CASE WHEN parts <> '' THEN E'\n<blockquote expandable>' || parts || '</blockquote>' ELSE '' END;

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
                   || CASE WHEN parts <> '' THEN E'\n<blockquote expandable>' || parts || '</blockquote>' ELSE '' END;

  RETURN v_line;
END;
$function$;
