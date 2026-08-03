-- Сигналы бота после «Единого пути гостя» (03.08.2026).
--
-- Безымянная бронь — норма (имена могут появиться в последний момент, а
-- случайный гость на день вообще не заводится в справочник), поэтому:
-- 1) tg_checkin_control: имя ищем по всей цепочке (вайшнав → guest_name →
--    бронь), «бронь без имени» остаётся только когда имени нет нигде;
-- 2) tg_reception_digest: убран мёртвый признак is_expected (считался по
--    пустому имени — с 344 признак приезда это arrived_at);
-- 3) переводы: галочка «Гость уже приехал» удалена из формы заселения
--    (форма всегда фиксирует приезд), добавлена подсказка ретрита по датам
--    в форме бронирования.

create or replace function tg_checkin_control()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_chat bigint;
  r record;
  v_block text := '';
  v_n int := 0;
  v_hour int := extract(hour FROM (now() AT TIME ZONE 'Asia/Kolkata'));
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Гест-хаус';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат гест-хауса не привязан');
  END IF;

  FOR r IN
    SELECT res.id, res.early_checkin, res.check_in,
           COALESCE(NULLIF(v.spiritual_name, ''),
                    NULLIF(btrim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                    NULLIF(btrim(res.guest_name), ''),
                    NULLIF(btrim(bk.name), ''), NULLIF(btrim(bk.contact_name), ''),
                    'бронь без имени') AS who,
           rm.number AS room, b.name_ru AS building,
           a.last_sent
      FROM residents res
      LEFT JOIN vaishnavas v ON v.id = res.vaishnava_id
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
      LEFT JOIN bookings bk ON bk.id = res.booking_id
      LEFT JOIN tg_checkin_alerts a ON a.resident_id = res.id
     WHERE res.status = 'confirmed'
       -- «Заселить» ещё не нажимали: приезд не отмечен
       AND res.arrived_at IS NULL
       AND res.check_in <= current_date
       AND (res.check_out IS NULL OR res.check_out >= current_date)
       -- раз в день, не чаще
       AND (a.last_sent IS NULL OR a.last_sent < current_date)
  LOOP
    -- Время проверки: ранний заезд ждём до полудня, обычный — до вечера.
    -- За прошлые дни спрашиваем в любое время: там уже точно опоздание.
    CONTINUE WHEN r.check_in = current_date
                  AND ((r.early_checkin AND v_hour < 12) OR (NOT r.early_checkin AND v_hour < 18));

    v_n := v_n + 1;
    v_block := v_block || format(E'\n• %s%s · заезд %s%s',
      tg_escape(r.who),
      COALESCE(' — ' || NULLIF(concat_ws(', ', NULLIF(tg_escape(r.building), ''),
                                               NULLIF(tg_escape(r.room), '')), ''), ''),
      to_char(r.check_in, 'DD.MM'),
      CASE WHEN r.early_checkin THEN ', ранний' ELSE '' END);

    INSERT INTO tg_checkin_alerts (resident_id, last_sent) VALUES (r.id, current_date)
      ON CONFLICT (resident_id) DO UPDATE SET last_sent = current_date;
  END LOOP;

  IF v_n = 0 THEN RETURN jsonb_build_object('ok', true, 'alerts', 0); END IF;

  PERFORM tg_send_chat(v_chat,
    format('🔔 <b>Гость должен был заехать, но статус не обновлён: %s</b>', v_n)
    || v_block
    || E'\nЗаселите, перенесите дату или отмените бронь.',
    NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'alerts', v_n);
END;
$function$;

-- tg_reception_digest: без мёртвого is_expected (см. 336 — признак считался
-- по пустому имени и нигде не использовался)
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
           rm.number AS room, b.name_ru AS building
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
     AND res.arrived_at IS NULL;
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

-- Переводы
delete from translations where key = 'timeline_arrived';
insert into translations (key, ru, en, hi) values
  ('timeline_retreat_by_dates', 'подставлено по датам', 'matched by dates', 'तिथियों से मिलान')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
