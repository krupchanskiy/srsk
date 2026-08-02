-- Изменения по ресепшену: копим и сообщаем раз в час (ТЗ, п. 11.1).
--
-- «автоматическое оповещение происходит только при изменениях. При этом
-- накапливать данные и если они есть оповещать, не чаще 1 раза за час —
-- суммой изменений, ночью не беспокоить».
--
-- План на завтра ушёл вечером; днём ресепшену важно узнать, что он поменялся:
-- кто-то добавился, кто-то съехал раньше. Повторять весь план ради одной
-- строки — верный способ, чтобы сводки перестали читать.

create table if not exists tg_reception_seen (
  d          date not null,
  kind       text not null,          -- 'in' | 'out'
  total      int  not null,
  updated_at timestamptz not null default now(),
  primary key (d, kind)
);

alter table tg_reception_seen enable row level security;
comment on table tg_reception_seen is
  'Последнее сообщённое ресепшену число заездов и выездов по дням.';

create or replace function tg_notify_reception_changes(p_days int default 3)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_chat bigint;
  r record;
  v_lines text := '';
  v_count int := 0;
BEGIN
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Гест-хаус';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат гест-хауса не привязан');
  END IF;

  FOR r IN
    WITH days AS (
      SELECT generate_series(current_date, current_date + p_days, '1 day')::date AS d
    ), now_counts AS (
      SELECT d.d, k.kind,
             (SELECT count(*) FROM residents res
               WHERE res.status = 'confirmed'
                 AND ((k.kind = 'in'  AND res.check_in  = d.d)
                   OR (k.kind = 'out' AND res.check_out = d.d)))::int AS total
        FROM days d CROSS JOIN (VALUES ('in'), ('out')) AS k(kind)
    )
    SELECT n.d, n.kind, n.total, s.total AS was
      FROM now_counts n
      LEFT JOIN tg_reception_seen s ON s.d = n.d AND s.kind = n.kind
     ORDER BY n.d, n.kind
  LOOP
    -- Первый прогон только запоминает: иначе вместо сигнала придёт простыня.
    IF r.was IS NULL THEN
      INSERT INTO tg_reception_seen (d, kind, total) VALUES (r.d, r.kind, r.total)
        ON CONFLICT (d, kind) DO UPDATE SET total = excluded.total, updated_at = now();
      CONTINUE;
    END IF;
    CONTINUE WHEN r.was = r.total;

    v_lines := v_lines || format(E'\n%s %s %s: <b>%s</b> (было %s)',
      CASE WHEN r.total > r.was THEN '▲' ELSE '▼' END,
      to_char(r.d, 'DD.MM'),
      CASE WHEN r.kind = 'in' THEN 'заезд' ELSE 'выезд' END,
      r.total, r.was);
    v_count := v_count + 1;

    UPDATE tg_reception_seen SET total = r.total, updated_at = now()
     WHERE d = r.d AND kind = r.kind;
  END LOOP;

  IF v_count = 0 THEN RETURN jsonb_build_object('ok', true, 'changes', 0); END IF;

  PERFORM tg_send_chat(v_chat,
    '🔔 <b>Изменились заезды и выезды</b>' || v_lines
    || E'\nСписки — командами «/приезд» и «/выезд».',
    NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'changes', v_count);
END;
$function$;

grant execute on function tg_notify_reception_changes(int) to service_role;

-- Раз в час днём, как и у кухни: 3:30–14:30 UTC = 9:00–20:00 по Мумбаи.
select cron.schedule('reception-changes', '30 3-14 * * *',
  $$SELECT tg_notify_reception_changes(3)$$);
