-- Гигиена прав по итогам советника Supabase.
--
-- 1. Строка сводки считает заявки по всем департаментам — обычному
--    пользователю она ни к чему. Вызывает её только ночная сводка.
REVOKE ALL ON FUNCTION fin_tg_chat_drafts_line() FROM PUBLIC, anon, authenticated;

-- 2. Триггерные функции были доступны на вызов кому угодно. Напрямую они
--    всё равно падают («can only be called as triggers»), но и светиться
--    в REST им незачем. На работу самих триггеров это не влияет: они
--    исполняются от владельца таблицы.
REVOKE ALL ON FUNCTION tg_notify_dept_credit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_on_autopost_error() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_on_integrity_alert() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_on_negative_balance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_on_pending_payment() FROM PUBLIC, anon, authenticated;

-- 3. У экранирования не был зафиксирован search_path
ALTER FUNCTION tg_escape(text) SET search_path TO 'public';
