-- Вечерний план ресепшена: кроме «Уезжают с долгом» — «Мы должны уезжающим»
-- (просьба ВГ 25.09.2026): переплата/аванс, не закрытый к выезду, — тоже повод
-- разобраться, чтобы человек не уехал, а мы остались ему должны. Сумма —
-- total_advance из fin_private_participant_balance, порога нет (как и для долгов,
-- см. 535). Тег казначея — один на сообщение, в первой из строк-сигналов.

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
  v_adv numeric;
  v_bal jsonb;
  v_where text;
  v_owe text := '';
  v_owe_n int := 0;
  v_block text := '';
  v_n int := 0;
  v_tag text;
BEGIN
  v_text := format('🌙 <b>План на завтра, %s</b>', to_char(p_day, 'DD.MM.YYYY'))
          || E'\n\n' || tg_arrivals_text(p_day, 'in', p_detail)
          || E'\n' || CASE WHEN p_detail THEN E'\n' ELSE '' END
          || tg_arrivals_text(p_day, 'out', p_detail);

  -- Долги и переплаты тех, кто завтра уезжает: последний момент разобраться
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
    v_bal  := fin_private_participant_balance(r.vaishnava_id, r.retreat_id);
    v_debt := COALESCE((v_bal->>'total_debt')::numeric, 0);
    v_adv  := COALESCE((v_bal->>'total_advance')::numeric, 0);
    v_where := COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''),
                                                        NULLIF(tg_escape(r.room), '')), ''), '');
    IF v_debt > 0 THEN
      v_n := v_n + 1;
      v_block := v_block || format(E'\n• %s%s — <b>%s</b>', tg_escape(r.who), v_where,
                                   fin_fmt_money(v_debt, 'INR'));
    END IF;
    IF v_adv > 0 THEN
      v_owe_n := v_owe_n + 1;
      v_owe := v_owe || format(E'\n• %s%s — <b>%s</b>', tg_escape(r.who), v_where,
                               fin_fmt_money(v_adv, 'INR'));
    END IF;
  END LOOP;

  IF v_n > 0 OR v_owe_n > 0 THEN
    SELECT '@' || tg_escape(username) INTO v_tag FROM tg_treasurer() WHERE username IS NOT NULL;
  END IF;

  IF v_n > 0 THEN
    v_text := v_text || format(E'\n\n❗️ <b>Уезжают с долгом: %s</b>', v_n)
                     || COALESCE(' ' || v_tag, '') || v_block;
  END IF;
  IF v_owe_n > 0 THEN
    v_text := v_text || format(E'\n\n💸 <b>Мы должны уезжающим: %s</b>', v_owe_n)
                     || CASE WHEN v_n = 0 THEN COALESCE(' ' || v_tag, '') ELSE '' END || v_owe;
  END IF;
  RETURN v_text;
END;
$function$;

grant execute on function tg_reception_plan_text(date, boolean) to service_role;
