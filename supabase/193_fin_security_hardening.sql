-- =============================================================
-- Финмодуль: hardening по итогам security-advisors (аудит Этапа 5)
-- 1) auth-хелперы не должны быть исполнимы ролью anon (мелкая утечка
--    booleans про произвольные uuid через PostgREST rpc). authenticated
--    оставляем — его требуют SECURITY DEFINER views.
-- 2) пришпилить search_path всем оставшимся fin_-функциям без него
--    (стандарт модуля: SECURITY DEFINER/триггеры с фиксированным
--    search_path; здесь это не-SD геттеры/гварды/hash — риск низкий,
--    но чистим предупреждение и закрываем поверхность на будущее).
-- =============================================================

-- 1) anon не вызывает финмодуль вовсе — отзываем на всякий
REVOKE EXECUTE ON FUNCTION fin_actor()                     FROM anon;
REVOKE EXECUTE ON FUNCTION fin_actor_contact_id()          FROM anon;
REVOKE EXECUTE ON FUNCTION fin_can_read_all(uuid)          FROM anon;
REVOKE EXECUTE ON FUNCTION fin_is_account_user(uuid)       FROM anon;
REVOKE EXECUTE ON FUNCTION fin_is_admin(uuid)              FROM anon;
REVOKE EXECUTE ON FUNCTION fin_is_observer(uuid)           FROM anon;

-- 2) search_path
ALTER FUNCTION fin_private_hash(jsonb)                      SET search_path = public;
ALTER FUNCTION fin_private_norm_money(numeric)             SET search_path = public;
ALTER FUNCTION fin_private_assert_keys(jsonb, text[])      SET search_path = public;
ALTER FUNCTION fin_private_get_uuid(jsonb, text, boolean)  SET search_path = public;
ALTER FUNCTION fin_private_get_money(jsonb, text, boolean) SET search_path = public;
ALTER FUNCTION fin_private_get_date(jsonb, text, boolean)  SET search_path = public;
ALTER FUNCTION fin_private_child_uuid(uuid, text)          SET search_path = public;
ALTER FUNCTION fin_postings_guard()                        SET search_path = public;
ALTER FUNCTION fin_operations_guard()                      SET search_path = public;
ALTER FUNCTION fin_audit_log_immutable()                   SET search_path = public;
