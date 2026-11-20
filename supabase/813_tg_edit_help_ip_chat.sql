-- 813: памятка об исправлении — и в чат счетов ИП (просьба ВГ 20.11.2026), свой текст под 812.
CREATE OR REPLACE FUNCTION public.tg_edit_help_broadcast()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n int := 0; v_tag text;
BEGIN
  IF current_date > date '2026-12-19' THEN
    PERFORM cron.unschedule('tg-edit-help');
    RETURN 0;
  END IF;
  SELECT COALESCE('@' || t.username, 'Ванамали Гопала') INTO v_tag FROM tg_treasurer() t;
  v_tag := COALESCE(v_tag, 'Ванамали Гопала');
  FOR r IN
    SELECT l.chat_id FROM tg_chat_links l
     WHERE l.is_active AND l.department_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tg_account_chats a WHERE a.chat_id = l.chat_id)
  LOOP
    PERFORM tg_send_chat(r.chat_id,
      E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n'
      || E'🆕 Теперь трату можно исправить или удалить, пока она не проведена (на сообщении 👀):\n\n'
      || E'• Ошиблись в сумме или описании — просто исправьте своё сообщение (удерживайте его → «Изменить»).\n'
      || E'• Ошиблись в статье или счёте — нажмите «✏️ Изменить» под ответом бота.\n'
      || E'• Записали по ошибке — нажмите «🗑 Удалить» под ответом бота. Само сообщение не удаляйте.\n\n'
      || E'После 👍 трата уже проведена — если нужно что-то поправить, отметьте ' || tg_escape(v_tag)
      || E' и напишите, что и на что исправить.',
      NULL, 'finance');
    n := n + 1;
  END LOOP;

  -- Чат счетов ИП (812): приход и перевод проводятся сразу, расход ждёт во «Входящих»
  FOR r IN SELECT a.chat_id FROM tg_account_chats a WHERE a.is_active LOOP
    PERFORM tg_send_chat(r.chat_id,
      E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n'
      || E'🆕 Теперь операцию можно исправить, пока она не проведена:\n\n'
      || E'• Ошиблись в сумме, дате или описании — просто исправьте своё сообщение (удерживайте его → «Изменить»). Пока карточка не записана — и для прихода, и для перевода.\n'
      || E'• Расход уже во «Входящих» (на сообщении 👀) — под карточкой есть «✏️ Изменить» (вид, счёт, департамент, статья) и «🗑 Удалить». Само сообщение не удаляйте.\n\n'
      || E'После 👍 операция уже проведена — если нужно что-то поправить, отметьте ' || tg_escape(v_tag)
      || E' и напишите, что и на что исправить.',
      NULL, 'finance');
    n := n + 1;
  END LOOP;
  RETURN n;
END $function$;

REVOKE ALL ON FUNCTION tg_edit_help_broadcast() FROM PUBLIC, anon, authenticated;
