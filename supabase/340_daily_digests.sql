-- Автоматические сводки: кухне утром, ресепшену вечером (ТЗ, п. 11 и 13).
--
-- «Ресепшн — вечером план. Кухня — утром план + изменения сразу.»
-- Обе сводки — на СЛЕДУЮЩИЙ день: их читают, чтобы подготовиться, а не чтобы
-- узнать про сегодня, когда уже поздно.
--
-- Время: Мумбаи UTC+5:30. Кухня 8:00 = 2:30 UTC, ресепшен 18:00 = 12:30 UTC.

-- ---------------------------------------------------------------------------
-- Кухня: план на завтра в тему «Информация»
-- ---------------------------------------------------------------------------
create or replace function tg_kitchen_morning()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_chat bigint; v_txt text;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат кухни не привязан');
  END IF;

  v_txt := tg_eating_text(current_date + 1);
  IF v_txt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'нет данных'); END IF;

  PERFORM tg_send_chat(v_chat, '📋 <b>План на завтра</b>' || E'\n' || v_txt, NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'date', current_date + 1);
END;
$function$;

grant execute on function tg_kitchen_morning() to service_role;

-- ---------------------------------------------------------------------------
-- Ресепшен: план на завтра со списками и долгами
-- ---------------------------------------------------------------------------
create or replace function tg_reception_evening()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_chat bigint;
  v_day date := current_date + 1;
  v_text text;
  r record;
  v_debt numeric;
  v_block text := '';
  v_n int := 0;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Гест-хаус';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат гест-хауса не привязан');
  END IF;

  v_text := format('🌙 <b>План на завтра, %s</b>', to_char(v_day, 'DD.MM.YYYY'))
          || E'\n\n' || tg_arrivals_text(v_day, 'in')
          || E'\n\n' || tg_arrivals_text(v_day, 'out');

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
     WHERE res.status = 'confirmed' AND res.check_out = v_day
       AND res.vaishnava_id IS NOT NULL AND res.retreat_id IS NOT NULL
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
    v_text := v_text || format(E'\n\n❗️ <b>Уезжают с долгом: %s</b>', v_n) || v_block;
  END IF;

  PERFORM tg_send_chat(v_chat, v_text, NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'date', v_day, 'debtors', v_n);
END;
$function$;

grant execute on function tg_reception_evening() to service_role;

-- ---------------------------------------------------------------------------
-- Расписание. Изменения по кухне — раз в час и только днём (ТЗ: «не чаще
-- 1 раза за час, ночью не беспокоить»), вместо прежних двух часов.
-- ---------------------------------------------------------------------------
select cron.unschedule('reception-digest');
select cron.unschedule('eating-changes');

select cron.schedule('kitchen-morning',    '30 2 * * *',  $$SELECT tg_kitchen_morning()$$);
select cron.schedule('reception-evening',  '30 12 * * *', $$SELECT tg_reception_evening()$$);
-- 3:30–14:30 UTC = 9:00–20:00 по Мумбаи
select cron.schedule('eating-changes',     '30 3-14 * * *', $$SELECT tg_notify_eating_changes(7)$$);
