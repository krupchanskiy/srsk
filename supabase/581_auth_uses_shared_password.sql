-- Проверка: у текущего пользователя до сих пор общий пароль?
--
-- Нужна для окна-предупреждения «Смените, пожалуйста, пароль» в основном
-- приложении (js/auth-check.js). Сам пароль наружу не уходит — только да/нет,
-- и только про себя (auth.uid()).
--
-- Временная: удалить, когда общие пароли будут сброшены у всех.
--
-- Применено на prod 2026-09-29.

CREATE OR REPLACE FUNCTION public.auth_uses_shared_password()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM auth.users u
        WHERE u.id = auth.uid()
          AND COALESCE(u.encrypted_password, '') <> ''
          AND (u.encrypted_password = crypt('rupaseva', u.encrypted_password)
               OR u.encrypted_password = crypt('giriraj', u.encrypted_password))
    );
$function$;

REVOKE ALL ON FUNCTION public.auth_uses_shared_password() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auth_uses_shared_password() TO authenticated;
