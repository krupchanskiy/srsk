-- Вкушающие в чате: команда по запросу и сигнал об изменениях.
--
-- Просьба Адриана (02.08.2026): «нужна команда в теме „информация" в чате кухни
-- для выведения списка вкушающих в разные дни» и «информацию об изменении
-- количества вкушающих на ближайшие дни тоже важно выводить в чатик кухни —
-- чтобы сразу доносить данные о количестве».

-- ---------------------------------------------------------------------------
-- 1. Текст сводки на дату — то же, что кухня видит в меню.
-- ---------------------------------------------------------------------------
create or replace function tg_eating_text(p_date date)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  bf record; ln record;
  v_line text;
  fmt_parts text;
BEGIN
  SELECT * INTO bf FROM eating_counts(p_date, p_date) WHERE meal = 'breakfast';
  SELECT * INTO ln FROM eating_counts(p_date, p_date) WHERE meal = 'lunch';
  IF bf IS NULL THEN RETURN NULL; END IF;

  v_line := format('🍽 <b>Вкушающие %s</b>', to_char(p_date, 'DD.MM.YYYY'));

  fmt_parts := concat_ws(', ',
    CASE WHEN bf.team > 0 THEN 'Команда – ' || bf.team END,
    CASE WHEN bf.volunteers > 0 THEN 'Волонтёры – ' || bf.volunteers END,
    CASE WHEN bf.vips > 0 THEN 'Важные гости – ' || bf.vips END,
    CASE WHEN bf.guests > 0 THEN 'Гости – ' || bf.guests END,
    CASE WHEN bf.groups > 0 THEN 'Группы – ' || bf.groups END,
    CASE WHEN bf.expected > 0 THEN 'Ожидаются – ' || bf.expected END);
  v_line := v_line || format(E'\n☀️ Завтрак: <b>%s</b>',
                             bf.team + bf.volunteers + bf.vips + bf.guests + bf.groups + bf.expected)
                   || COALESCE(E'\n   ' || fmt_parts, '');

  fmt_parts := concat_ws(', ',
    CASE WHEN ln.team > 0 THEN 'Команда – ' || ln.team END,
    CASE WHEN ln.volunteers > 0 THEN 'Волонтёры – ' || ln.volunteers END,
    CASE WHEN ln.vips > 0 THEN 'Важные гости – ' || ln.vips END,
    CASE WHEN ln.guests > 0 THEN 'Гости – ' || ln.guests END,
    CASE WHEN ln.groups > 0 THEN 'Группы – ' || ln.groups END,
    CASE WHEN ln.expected > 0 THEN 'Ожидаются – ' || ln.expected END);
  v_line := v_line || format(E'\n🍛 Обед: <b>%s</b>',
                             ln.team + ln.volunteers + ln.vips + ln.guests + ln.groups + ln.expected)
                   || COALESCE(E'\n   ' || fmt_parts, '');

  IF bf.expected > 0 OR ln.expected > 0 THEN
    v_line := v_line || E'\n<i>«Ожидаются» — бронь есть, гость ещё не заселён.</i>';
  END IF;
  RETURN v_line;
END;
$function$;

grant execute on function tg_eating_text(date) to authenticated, service_role, anon;

-- ---------------------------------------------------------------------------
-- 2. Изменения на ближайшие дни.
--    Кухне важно не «сколько сейчас», а «что поменялось с прошлого раза»:
--    именно на разницу она реагирует закупкой. Поэтому храним последний
--    сообщённый расклад и шлём только отличия.
-- ---------------------------------------------------------------------------
create table if not exists tg_eating_seen (
  d          date not null,
  meal       text not null,
  total      int  not null,
  updated_at timestamptz not null default now(),
  primary key (d, meal)
);

alter table tg_eating_seen enable row level security;
comment on table tg_eating_seen is
  'Последнее сообщённое кухне количество едоков. Нужно, чтобы слать только изменения.';

create or replace function tg_notify_eating_changes(p_days int default 7)
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
  v_sign text;
BEGIN
  -- Кухня: тема «Информация», если привязана
  SELECT l.chat_id INTO v_chat
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  IF v_chat IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'чат кухни не привязан');
  END IF;

  FOR r IN
    SELECT c.d, c.meal,
           (c.team + c.volunteers + c.vips + c.guests + c.groups + c.expected) AS total,
           s.total AS was
      FROM eating_counts(current_date, current_date + p_days) c
      LEFT JOIN tg_eating_seen s ON s.d = c.d AND s.meal = c.meal
     ORDER BY c.d, (c.meal = 'lunch')
  LOOP
    -- Первый прогон только запоминает: иначе кухня получит простыню
    -- «изменилось всё» вместо полезного сигнала.
    IF r.was IS NULL THEN
      INSERT INTO tg_eating_seen (d, meal, total) VALUES (r.d, r.meal, r.total)
        ON CONFLICT (d, meal) DO UPDATE SET total = excluded.total, updated_at = now();
      CONTINUE;
    END IF;
    CONTINUE WHEN r.was = r.total;

    v_sign := CASE WHEN r.total > r.was THEN '▲' ELSE '▼' END;
    v_lines := v_lines || format(E'\n%s %s %s: <b>%s</b> (было %s)',
      v_sign, to_char(r.d, 'DD.MM'),
      CASE WHEN r.meal = 'breakfast' THEN 'завтрак' ELSE 'обед' END,
      r.total, r.was);
    v_count := v_count + 1;

    UPDATE tg_eating_seen SET total = r.total, updated_at = now()
     WHERE d = r.d AND meal = r.meal;
  END LOOP;

  IF v_count = 0 THEN RETURN jsonb_build_object('ok', true, 'changes', 0); END IF;

  PERFORM tg_send_chat(v_chat,
    '🔔 <b>Изменилось количество вкушающих</b>' || v_lines,
    NULL, 'notify');
  RETURN jsonb_build_object('ok', true, 'changes', v_count);
END;
$function$;

grant execute on function tg_notify_eating_changes(int) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Расписание: проверяем изменения днём каждые два часа по Мумбаи
--    (9:00–19:00 = 3:30–13:30 UTC). Ночью кухне это не нужно.
--    Первый прогон только запомнит текущий расклад, слать начнёт со второго.
-- ---------------------------------------------------------------------------
select cron.schedule('eating-changes', '30 3,5,7,9,11,13 * * *',
  $$SELECT tg_notify_eating_changes(7)$$);
