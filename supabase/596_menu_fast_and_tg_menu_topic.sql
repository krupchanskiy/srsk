-- =============================================================
-- Меню в чате кухни (решения ВГ 01.10.2026, чат «Телеграм-бот 3»).
--
-- 1) «Пост» — отметка у приёма пищи: в этот день завтрак (реже обед) не готовили.
--    Приём считается заполненным; в расчётах ничего не меняется — только отметка.
-- 2) Тема «Меню» в чате кухни: привязывается командой «/тема меню» (kind = 'menu').
-- 3) Каждое утро (cron kitchen-morning, 08:00 IST) бот проверяет меню основной кухни
--    с 05.08 (старт системы) по завтра. Пропуск — завтрак или обед, в который есть
--    вкушающие, а в меню нет ни блюд, ни «готового со стороны», ни «Готовил Бридж Кишор»,
--    ни «Пост». Всё заполнено — бот молчит. Есть пропуски — список дат (дата = ссылка
--    на день в меню) и тег Сундары Рупы, каждое утро, пока не заполнят.
-- =============================================================

alter table public.menu_meals add column if not exists is_fast boolean not null default false;
comment on column public.menu_meals.is_fast is
  'Пост: приём пищи не готовили. Для проверки меню считается заполненным, в расчётах — только отметка (ВГ 01.10.2026)';

insert into translations (key, ru, en, hi, context) values
('menu_fast_add', 'Пост', 'Fast', 'उपवास', 'Меню: кнопка в пустом приёме пищи — в этот день пост, не готовили'),
('menu_fast_title', 'Пост — не готовили', 'Fast — nothing cooked', 'उपवास — कुछ नहीं बनाया', 'Меню: отметка у приёма пищи'),
('menu_fast_cancel', 'Отменить', 'Undo', 'रद्द करें', 'Меню: снять отметку «Пост»')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;

-- Отметка «Пост» — такое же изменение приёма, как повар и порции: прошедший день закрыт
-- от правки тем же правилом (мигр. 566)
create or replace function public.kitchen_trg_past_menu_meal()
returns trigger language plpgsql security definer set search_path = public
as $function$
begin
  if tg_op = 'UPDATE' and (new.portions, new.cook_id, new.notes, new.date, new.meal_type, new.is_fast)
                          is not distinct from (old.portions, old.cook_id, old.notes, old.date, old.meal_type, old.is_fast) then
    return new;                                                            -- служебное (updated_at)
  end if;
  if old.date < kitchen_today() and auth.uid() is not null
     and not kitchen_has_permission(auth.uid(), 'edit_past_menu')
     and (old.created_at at time zone 'Asia/Kolkata')::date < kitchen_today()
     and not kitchen_past_menu_allowed(old.id, null) then
    raise exception 'past_menu_locked' using detail = 'Меню прошедшего дня закрыто: менять его можно только с правом «Правка прошлого меню».';
  end if;
  return coalesce(new, old);
end;
$function$;

-- ---------- тема «Меню» ----------
alter table public.tg_chat_links add column if not exists topic_menu integer;

create or replace function public.tg_set_topic(p_chat bigint, p_thread integer, p_kind text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_name text; v_col text;
BEGIN
  IF p_thread IS NULL THEN
    RETURN jsonb_build_object('ok', false,
      'error', 'Эту команду нужно писать внутри темы, а не в общем чате');
  END IF;

  SELECT department_name INTO v_name FROM tg_chat_links WHERE chat_id = p_chat AND is_active;
  IF v_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Чат не привязан к департаменту');
  END IF;

  IF p_kind = 'finance' THEN
    UPDATE tg_chat_links SET topic_finance = p_thread WHERE chat_id = p_chat;
  ELSIF p_kind = 'notify' THEN
    UPDATE tg_chat_links SET topic_notify = p_thread WHERE chat_id = p_chat;
  ELSIF p_kind = 'menu' THEN
    UPDATE tg_chat_links SET topic_menu = p_thread WHERE chat_id = p_chat;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'Не понял, какая это тема');
  END IF;

  RETURN jsonb_build_object('ok', true, 'department', v_name, 'kind', p_kind);
END;
$function$;

create or replace function public.tg_outbox_try(p_id bigint)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    v_row  tg_outbox%rowtype;
    v_token text;
    v_thread int;
    v_req bigint;
begin
    select * into v_row from tg_outbox where id = p_id and status = 'pending' for update;
    if not found then return; end if;

    select case v_row.kind when 'notify' then topic_notify when 'menu' then topic_menu else topic_finance end
      into v_thread from tg_chat_links where chat_id = v_row.chat_id and is_active;

    select decrypted_secret into v_token from vault.decrypted_secrets where name = 'telegram_bot_token';

    -- 15 секунд вместо стандартных пяти: обрывалось именно рукопожатие TLS
    select net.http_post(
        url := format('https://api.telegram.org/bot%s/sendMessage', v_token),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body := jsonb_build_object('chat_id', v_row.chat_id, 'text', v_row.text,
                                   'parse_mode', 'HTML', 'disable_web_page_preview', true)
                || case when v_row.reply_to is null then '{}'::jsonb
                        else jsonb_build_object('reply_to_message_id', v_row.reply_to) end
                || case when v_thread is null then '{}'::jsonb
                        else jsonb_build_object('message_thread_id', v_thread) end
                || case when v_row.reply_markup is null then '{}'::jsonb
                        else jsonb_build_object('reply_markup', v_row.reply_markup) end,
        timeout_milliseconds := 15000
    ) into v_req;

    update tg_outbox
       set attempts = attempts + 1, last_try_at = now(), net_request_id = v_req
     where id = p_id;
exception when others then
    update tg_outbox
       set attempts = attempts + 1, last_try_at = now(), last_error = SQLERRM
     where id = p_id;
end;
$function$;

-- ---------- текст предупреждения: NULL, если пропусков нет ----------
create or replace function public.tg_menu_gaps_text(p_today date default kitchen_today())
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
DECLARE
  v_start constant date := '2026-08-05';                                -- старт системы (отметки Бридж Кишора)
  v_loc uuid;
  v_tag text;
  r record;
  v_line text;
  v_now text := '';
  v_past text := '';
BEGIN
  SELECT id INTO v_loc FROM locations WHERE slug = 'main';

  -- тег Сундары Рупы прабху (глава кухни): ник из профиля, иначе по привязке Telegram
  SELECT nullif(ltrim(btrim(v.telegram), '@'), '') INTO v_tag
    FROM vaishnavas v WHERE v.id = '70e8f35c-f1a9-40fe-b510-93e6ad05a52e';
  v_tag := coalesce('@' || v_tag,
                    (SELECT format('<a href="tg://user?id=%s">Сундара Рупа прабху</a>', tg_user_id)
                       FROM tg_user_links WHERE vaishnava_id = '70e8f35c-f1a9-40fe-b510-93e6ad05a52e' LIMIT 1),
                    'Сундара Рупа прабху');

  FOR r IN
    WITH need AS (                                                       -- приёмы, в которые кто-то ест
      SELECT c.d, c.meal
        FROM eating_counts(v_start, p_today + 1) c
       WHERE c.meal IN ('breakfast', 'lunch')
         AND c.team + c.volunteers + c.vips + c.guests + c.groups + c.expected > 0
    ), gaps AS (
      SELECT n.d, n.meal FROM need n
       WHERE NOT EXISTS (
         SELECT 1 FROM menu_meals mm
          WHERE mm.location_id = v_loc AND mm.date = n.d AND mm.meal_type = n.meal
            AND (mm.is_fast
                 OR EXISTS (SELECT 1 FROM menu_dishes x WHERE x.meal_id = mm.id)
                 OR EXISTS (SELECT 1 FROM menu_external_items x WHERE x.meal_id = mm.id)))
    )
    SELECT d, bool_or(meal = 'breakfast') AS no_bf, bool_or(meal = 'lunch') AS no_ln
      FROM gaps GROUP BY d ORDER BY d
  LOOP
    v_line := format(E'\n• <a href="https://in.rupaseva.com/kitchen/menu.html#day/%s%s">%s</a> — %s',
      to_char(r.d, 'YYYY-MM-DD'),
      CASE WHEN r.no_bf AND r.no_ln THEN '' WHEN r.no_bf THEN '/breakfast' ELSE '/lunch' END,
      CASE r.d - p_today WHEN 0 THEN 'Сегодня, ' WHEN 1 THEN 'Завтра, ' ELSE '' END || to_char(r.d, 'DD.MM'),
      CASE WHEN r.no_bf AND r.no_ln THEN 'нет ни завтрака, ни обеда'
           WHEN r.no_bf THEN 'не заполнен завтрак' ELSE 'не заполнен обед' END);
    IF r.d >= p_today THEN v_now := v_now || v_line; ELSE v_past := v_past || v_line; END IF;
  END LOOP;

  IF v_now = '' AND v_past = '' THEN RETURN NULL; END IF;

  RETURN '⚠️ <b>Меню не заполнено</b>' || E'\n\n'
      || 'Харе Кришна! Примите, пожалуйста, мои поклоны.' || E'\n'
      || v_tag || ', пожалуйста, заполните меню — по нему считается вся кухня.'
      || CASE WHEN v_now <> '' THEN E'\n' || v_now ELSE '' END
      || CASE WHEN v_past <> '' THEN E'\n\nПрошлые дни:' || v_past ELSE '' END;
END;
$function$;

-- ---------- утренняя проверка: шлёт в тему «Меню», только если есть пропуски ----------
create or replace function public.tg_kitchen_menu_check()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE v_chat bigint; v_topic int; v_txt text; v_id bigint;
BEGIN
  SELECT l.chat_id, l.topic_menu INTO v_chat, v_topic
    FROM tg_chat_links l JOIN fin_departments d ON d.id = l.department_id
   WHERE l.is_active AND d.name = 'Кухня';
  -- до «/тема меню» молчим: в общий раздел и в «План на завтра» не пишем (решение ВГ)
  IF v_chat IS NULL OR v_topic IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'тема «Меню» в чате кухни не привязана');
  END IF;

  v_txt := tg_menu_gaps_text(kitchen_today());
  IF v_txt IS NULL THEN RETURN jsonb_build_object('ok', true, 'gaps', false); END IF;

  INSERT INTO tg_outbox (chat_id, text, reply_to, kind) VALUES (v_chat, v_txt, NULL, 'menu')
  RETURNING id INTO v_id;
  PERFORM tg_outbox_try(v_id);
  RETURN jsonb_build_object('ok', true, 'gaps', true, 'outbox_id', v_id);
END;
$function$;

revoke all on function public.tg_menu_gaps_text(date) from public, anon, authenticated;
revoke all on function public.tg_kitchen_menu_check() from public, anon, authenticated;

-- то же время, что «План на завтра»: 08:00 IST
select cron.schedule('kitchen-menu-check', '30 2 * * *', 'SELECT tg_kitchen_menu_check()');
