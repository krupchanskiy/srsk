-- Контроль незаселённых броней по времени (ТЗ, п. 8).
--
-- «если указан ранний заезд → проверка до 12:00, если обычный → после 18:00
-- или на следующее утро… Повторные уведомления 1 раз в день, пока статус не
-- изменится или бронь не изменится/не отменится».
--
-- Проверяем не «сколько висит», а «пора ли уже спросить»: гость с обычным
-- заездом в 11 утра ещё в пути, а в 19:00 его отсутствие — уже вопрос.

create table if not exists tg_checkin_alerts (
  resident_id uuid primary key references residents(id) on delete cascade,
  last_sent   date not null
);

alter table tg_checkin_alerts enable row level security;
comment on table tg_checkin_alerts is
  'Когда по брони последний раз спрашивали про заселение. Чтобы напоминать раз в день, а не каждый прогон.';

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
           rm.number AS room, b.name_ru AS building,
           bk.contact_name, bk.name AS booking_name,
           a.last_sent
      FROM residents res
      LEFT JOIN rooms rm ON rm.id = res.room_id
      LEFT JOIN buildings b ON b.id = rm.building_id
      LEFT JOIN bookings bk ON bk.id = res.booking_id
      LEFT JOIN tg_checkin_alerts a ON a.resident_id = res.id
     WHERE res.status = 'confirmed'
       -- «Заселить» ещё не нажимали: имени нет
       AND res.vaishnava_id IS NULL AND COALESCE(btrim(res.guest_name), '') = ''
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
      tg_escape(COALESCE(NULLIF(btrim(r.booking_name), ''), r.contact_name, 'бронь без имени')),
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

grant execute on function tg_checkin_control() to service_role;

-- Дважды в день: в полдень ловим ранние заезды, вечером — обычные.
-- 6:30 UTC = 12:00 Мумбаи, 12:40 UTC = 18:10 Мумбаи.
select cron.schedule('checkin-control-noon',    '30 6 * * *',  $$SELECT tg_checkin_control()$$);
select cron.schedule('checkin-control-evening', '40 12 * * *', $$SELECT tg_checkin_control()$$);
