-- Финансовые данные принимаются только из финансовой темы.
--
-- ТЗ Адриана (02.08.2026), п. 4–5: «есть темы → фильтрация по финансовым темам,
-- нет тем → фильтрация по назначению чата». Если трата написана не в той теме,
-- заявка не заводится, а бот объясняет, куда писать.
--
-- Если тема в чате-форуме ещё не привязана, работаем как раньше и подсказываем
-- настроить: молча ронять заявки хуже, чем принять их с напоминанием.

create or replace function tg_finance_topic_check(p_chat bigint, p_thread int)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_forum boolean;
  v_topic int;
  v_dept text;
BEGIN
  SELECT k.is_forum, l.topic_finance, l.department_name
    INTO v_forum, v_topic, v_dept
    FROM tg_chat_links l
    LEFT JOIN tg_known_chats k ON k.chat_id = l.chat_id
   WHERE l.chat_id = p_chat AND l.is_active;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', true);   -- чат не наш, решает вызывающий
  END IF;

  -- В обычной группе тем нет: весь чат и есть финансовый источник
  IF NOT COALESCE(v_forum, false) THEN
    RETURN jsonb_build_object('allowed', true);
  END IF;

  -- Форум, но финансовая тема не назначена — принимаем и просим настроить
  IF v_topic IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'hint',
      'Кстати, здесь включены темы. Откройте финансовую тему и напишите в ней «/тема финансы» — тогда траты будут собираться в одном месте.');
  END IF;

  IF p_thread IS DISTINCT FROM v_topic THEN
    RETURN jsonb_build_object('allowed', false, 'topic', v_topic, 'department', v_dept);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$function$;

grant execute on function tg_finance_topic_check(bigint, int) to anon, authenticated, service_role;
