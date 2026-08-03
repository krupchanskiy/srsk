-- Утренняя сводка ресепшена в тему «Ресепшен».
--
-- Просьба Адриана (02.08.2026): «Ресепшен (туда все оповещения) о приезжающих,
-- отъезжающих, отъезжающих с задолженностью, и не расселеных».
--
-- Долг считаем через fin_private_participant_balance, а не через fin_has_debt:
-- последняя требует авторизованного сотрудника, а сводку шлёт планировщик,
-- у которого пользователя нет вовсе.

create or replace function tg_reception_digest(p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_day date := COALESCE(p_date, current_date);
  v_chat bigint;
  v_text text;
  r record;
  v_block text;
  v_n int;
  v_debt numeric;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Гест-хаус';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат гест-хауса не привязан');
  END IF;

  v_text := format('🏠 <b>Ресепшен на %s</b>', to_char(v_day, 'DD.MM.YYYY'));

  -- ---------- заезжают ----------
  v_block := ''; v_n := 0;
  FOR r IN
    SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    NULLIF(btrim(res.guest_name), ''),
                    NULLIF(btrim(bk.name), ''), NULLIF(btrim(bk.contact_name), ''),
                    'бронь без имени') AS who,
           rm.number AS room, b.name_ru AS building,
           res.vaishnava_id IS NULL AND COALESCE(btrim(res.guest_name), '') = '' AS is_expected
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
      LEFT JOIN bookings bk ON bk.id = res.booking_id
     WHERE res.status = 'confirmed' AND res.check_in = v_day
     ORDER BY b.name_ru NULLS LAST, rm.number
  LOOP
    v_n := v_n + 1;
    -- место может быть не указано: тогда не рисуем пустое «— ,»
    v_block := v_block || format(E'\n• %s%s', tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''), NULLIF(tg_escape(r.room), '')), ''), ''));
  END LOOP;
  v_text := v_text || format(E'\n\n<b>Заезжают: %s</b>', v_n) || v_block;

  -- ---------- выезжают, отдельно с долгом ----------
  v_block := ''; v_n := 0;
  FOR r IN
    SELECT res.vaishnava_id, res.retreat_id,
           COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    NULLIF(btrim(res.guest_name), ''),
                    NULLIF(btrim(bk.name), ''), NULLIF(btrim(bk.contact_name), ''),
                    'бронь без имени') AS who,
           rm.number AS room, b.name_ru AS building
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
      LEFT JOIN bookings bk ON bk.id = res.booking_id
     WHERE res.status = 'confirmed' AND res.check_out = v_day
     ORDER BY b.name_ru NULLS LAST, rm.number
  LOOP
    v_n := v_n + 1;
    v_debt := 0;
    IF r.vaishnava_id IS NOT NULL AND r.retreat_id IS NOT NULL THEN
      v_debt := COALESCE((fin_private_participant_balance(r.vaishnava_id, r.retreat_id)
                          ->>'total_debt')::numeric, 0);
    END IF;
    v_block := v_block || format(E'\n%s %s%s%s',
      CASE WHEN v_debt > 0 THEN '❗️' ELSE '•' END,
      tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''), NULLIF(tg_escape(r.room), '')), ''), ''),
      CASE WHEN v_debt > 0 THEN format(' — <b>долг %s</b>', fin_fmt_money(v_debt, 'INR')) ELSE '' END);
  END LOOP;
  v_text := v_text || format(E'\n\n<b>Выезжают: %s</b>', v_n) || v_block;

  -- ---------- зависшие брони: заезд был, «Заселить» не нажимали ----------
  SELECT count(*) INTO v_n
    FROM residents res
   WHERE res.status = 'confirmed' AND res.check_in < v_day
     AND (res.check_out IS NULL OR res.check_out >= v_day)
     AND res.vaishnava_id IS NULL AND COALESCE(btrim(res.guest_name), '') = '';
  IF v_n > 0 THEN
    v_text := v_text || format(
      E'\n\n⚠️ <b>Не заселены, а день заезда прошёл: %s</b>'
      '\nЗаселите, перенесите дату или отмените — иначе на них считается питание.', v_n);
  END IF;

  -- ---------- участники ретрита без места ----------
  v_block := ''; v_n := 0;
  FOR r IN
    SELECT ret.name_ru AS retreat, count(*) AS cnt
      FROM retreat_registrations rr
      JOIN retreats ret ON ret.id = rr.retreat_id
     WHERE rr.is_deleted = false
       AND rr.status NOT IN ('cancelled', 'rejected')
       AND ret.end_date >= v_day
       -- только идущие и ближайшие: расселение ретрита следующего года
       -- каждое утро в сводке — шум, а не сигнал
       AND ret.start_date <= v_day + 30
       -- Человек расселён, даже если в записи размещения не проставлен
       -- ретрит: сверяем по пересечению дат, иначе сигнал завышает вдвое
       -- (проверено 02.08.2026: 44 «без места» против 21 настоящего).
       AND NOT EXISTS (SELECT 1 FROM residents res
                        WHERE res.vaishnava_id = rr.vaishnava_id
                          AND res.status = 'confirmed'
                          AND res.check_in <= ret.end_date
                          AND COALESCE(res.check_out, '2100-01-01') >= ret.start_date)
     GROUP BY 1 ORDER BY 2 DESC
  LOOP
    v_n := v_n + r.cnt;
    v_block := v_block || format(E'\n• %s — %s', tg_escape(r.retreat), r.cnt);
  END LOOP;
  IF v_n > 0 THEN
    v_text := v_text || format(E'\n\n<b>Без места: %s</b>', v_n) || v_block;
  END IF;

  PERFORM tg_send_chat(v_chat, v_text, NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'date', v_day);
END;
$function$;

grant execute on function tg_reception_digest(date) to authenticated, service_role;

-- Расписания у этой сводки нет намеренно: по ТЗ (п. 13) ресепшен получает
-- план вечером на следующий день — это делает tg_reception_evening (340).
-- Функция остаётся для ручного вызова на любую дату.
