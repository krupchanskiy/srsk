-- =============================================================
-- Финмодуль: 193 отзывал EXECUTE у anon, но не сработал — привилегия
-- шла через дефолтный грант PUBLIC (все функции создаются с EXECUTE
-- для PUBLIC), а anon — член PUBLIC. Отзываем у PUBLIC и явно грантим
-- authenticated (её требуют SECURITY DEFINER views и внутренние вызовы
-- RPC). После этого anon (только PUBLIC-член, не authenticated) теряет
-- доступ, authenticated сохраняет.
-- =============================================================

REVOKE EXECUTE ON FUNCTION fin_actor()               FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fin_actor_contact_id()    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fin_can_read_all(uuid)    FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fin_is_account_user(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fin_is_admin(uuid)        FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fin_is_observer(uuid)     FROM PUBLIC;

GRANT EXECUTE ON FUNCTION fin_actor()               TO authenticated;
GRANT EXECUTE ON FUNCTION fin_actor_contact_id()    TO authenticated;
GRANT EXECUTE ON FUNCTION fin_can_read_all(uuid)    TO authenticated;
GRANT EXECUTE ON FUNCTION fin_is_account_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_is_admin(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION fin_is_observer(uuid)     TO authenticated;
