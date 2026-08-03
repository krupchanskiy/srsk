-- Регистрация из сделки: даты рейсов, питание и честный сигнал «без места».
--
-- Разбор с Адрианом 03.08.2026 (кейс Екатерины Удаловой): гость живёт в
-- партнёрской гостинице (Анийор Ашрая), но питается в ШРСК. Вскрылось три
-- дыры:
-- 1) регистрации, созданные из CRM, не несли дат приезда/отъезда — кухня
--    таких людей не считала вовсе (26 человек Сева-ретрита ели бы незапланированно);
-- 2) meal_type всегда 'prasad', хотя в чеклисте сделки бывает «питание сам»;
-- 3) «без места» в сводке ресепшена требовал комнату у тех, кому она не
--    нужна: partner_hotel и self из чеклиста сделки.

create or replace function crm_register_on_booked()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_paid constant text[] := array['booked', 'checklist', 'ready', 'completed'];
  v_entering boolean;
begin
  if new.status <> all (v_paid) then return new; end if;
  if new.vaishnava_id is null or new.retreat_id is null then return new; end if;

  v_entering := (tg_op = 'INSERT') or (old.status <> all (v_paid));

  if v_entering then
    insert into retreat_registrations
           (retreat_id, vaishnava_id, status, meal_type,
            arrival_datetime, departure_datetime,
            registration_date, org_notes)
    values (new.retreat_id, new.vaishnava_id, 'guest',
            case when new.checklist_meals = 'self' then 'self' else 'prasad' end,
            new.arrival_datetime, new.departure_datetime,
            current_date, 'Создано автоматически: оплачена бронь в CRM')
    on conflict (vaishnava_id, retreat_id) do update
       set is_deleted = false
     where retreat_registrations.is_deleted;
  end if;

  -- Даты рейсов появляются позже (на этапе чеклиста) — дозаполняем их в
  -- автосозданную регистрацию. Только пустые поля: ручные правки оргов
  -- не перетираем.
  update retreat_registrations rr
     set arrival_datetime   = coalesce(rr.arrival_datetime, new.arrival_datetime),
         departure_datetime = coalesce(rr.departure_datetime, new.departure_datetime)
   where rr.vaishnava_id = new.vaishnava_id
     and rr.retreat_id = new.retreat_id
     and rr.org_notes like 'Создано автоматически%'
     and (rr.arrival_datetime is null or rr.departure_datetime is null)
     and (new.arrival_datetime is not null or new.departure_datetime is not null);

  return new;
end;
$$;

drop trigger if exists trg_crm_register_on_booked on crm_deals;
create trigger trg_crm_register_on_booked
  after insert or update of status, arrival_datetime, departure_datetime on crm_deals
  for each row execute function crm_register_on_booked();

-- Бэкфилл: даты и питание для уже созданных регистраций
update retreat_registrations rr
   set arrival_datetime   = coalesce(rr.arrival_datetime, d.arrival_datetime),
       departure_datetime = coalesce(rr.departure_datetime, d.departure_datetime)
  from crm_deals d
 where d.vaishnava_id = rr.vaishnava_id and d.retreat_id = rr.retreat_id
   and d.status in ('booked', 'checklist', 'ready', 'completed')
   and rr.org_notes like 'Создано автоматически%'
   and (rr.arrival_datetime is null or rr.departure_datetime is null);

update retreat_registrations rr
   set meal_type = 'self'
  from crm_deals d
 where d.vaishnava_id = rr.vaishnava_id and d.retreat_id = rr.retreat_id
   and d.status in ('booked', 'checklist', 'ready', 'completed')
   and d.checklist_meals = 'self'
   and rr.org_notes like 'Создано автоматически%'
   and rr.meal_type = 'prasad';

-- «Без места»: не требуем комнату у тех, кто по сделке живёт в партнёрской
-- гостинице или самостоятельно. Правится только блок в tg_reception_digest.
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
       -- Комната у нас не нужна: по сделке гость живёт в партнёрской
       -- гостинице или самостоятельно (кейс Удаловой, 03.08.2026)
       AND NOT EXISTS (SELECT 1 FROM crm_deals d
                        WHERE d.vaishnava_id = rr.vaishnava_id
                          AND d.retreat_id = rr.retreat_id
                          AND d.status IN ('booked', 'checklist', 'ready', 'completed')
                          AND d.checklist_accommodation IN ('partner_hotel', 'self'))
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
