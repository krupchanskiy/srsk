-- Вечерний план ресепшена: строка «Уезжают с долгом» тегает казначея
-- (просьба ВГ 25.09.2026) — чтобы уведомление пришло лично, а не терялось в чате.
-- Ник берём из tg_treasurer(), а не пишем в коде: сменится казначей — сменится и тег.
-- Тег в сводке по-прежнему только при долгах; при «Подробнее/Свернуть» сообщение
-- редактируется, повторного уведомления Телеграм не шлёт.

CREATE OR REPLACE FUNCTION public.tg_reception_plan_text(p_day date, p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_text text;
  r record;
  v_debt numeric;
  v_block text := '';
  v_n int := 0;
  v_tag text;
BEGIN
  v_text := format('🌙 <b>План на завтра, %s</b>', to_char(p_day, 'DD.MM.YYYY'))
          || E'\n\n' || tg_arrivals_text(p_day, 'in', p_detail)
          || E'\n' || CASE WHEN p_detail THEN E'\n' ELSE '' END
          || tg_arrivals_text(p_day, 'out', p_detail);

  -- Долги тех, кто завтра уезжает: последний момент спросить
  FOR r IN
    SELECT res.vaishnava_id, res.retreat_id,
           COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    res.guest_name, '—') AS who,
           rm.number AS room, b.name_ru AS building
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
     WHERE res.status = 'confirmed' AND res.check_out = p_day
       AND res.vaishnava_id IS NOT NULL AND res.retreat_id IS NOT NULL
     ORDER BY b.sort_order NULLS LAST, b.name_ru NULLS LAST,
              NULLIF(substring(rm.number FROM '^\d+'), '')::int NULLS LAST, rm.number
  LOOP
    v_debt := COALESCE((fin_private_participant_balance(r.vaishnava_id, r.retreat_id)
                        ->>'total_debt')::numeric, 0);
    CONTINUE WHEN v_debt <= 0;
    v_n := v_n + 1;
    v_block := v_block || format(E'\n• %s%s — <b>%s</b>', tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''),
                                               NULLIF(tg_escape(r.room), '')), ''), ''),
      fin_fmt_money(v_debt, 'INR'));
  END LOOP;

  IF v_n > 0 THEN
    SELECT '@' || tg_escape(username) INTO v_tag FROM tg_treasurer() WHERE username IS NOT NULL;
    v_text := v_text || format(E'\n\n❗️ <b>Уезжают с долгом: %s</b>', v_n)
                     || COALESCE(' ' || v_tag, '') || v_block;
  END IF;
  RETURN v_text;
END;
$function$;

grant execute on function tg_reception_plan_text(date, boolean) to service_role;
