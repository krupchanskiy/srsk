-- Регрессия миграции 466: DROP+CREATE tg_department_balance (менялся возвращаемый
-- тип) сбросил REVOKE из 279_tg_dept_balance_and_full_notify.sql — функция стала
-- выполнима анонимом через публичный REST API. Вызывается только ботом (service-role).
REVOKE ALL ON FUNCTION public.tg_department_balance(bigint) FROM PUBLIC, anon, authenticated;
