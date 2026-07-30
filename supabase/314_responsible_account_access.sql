-- Глава департамента видит свой счёт — и теряет доступ автоматически.
--
-- Решение ВГ (30.07.2026): «Всем главам департаментов, если человек из списков
-- департамента пропадает, то доступ к счету он теряет автоматом».
--
-- Поэтому доступ НЕ выдаём руками через fin_account_access: он выводится из того,
-- кто сейчас записан ответственным за счёт или за департамент. Сняли человека с
-- департамента — в ту же секунду он перестаёт видеть счёт, чеки и проводки.
-- Ничего не нужно помнить и отзывать.

-- 1) Видимость счёта: к админу/наблюдателю и явной выдаче добавляем ответственного
create or replace function fin_can_see_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM fin_accounts a
    WHERE a.id = p_account_id
      AND (
        (NOT a.is_restricted AND fin_can_read_all(auth.uid()))
        OR EXISTS (SELECT 1 FROM fin_account_access aa
                   WHERE aa.account_id = a.id AND aa.user_id = auth.uid())
        -- ответственный за сам счёт либо за департамент, которому счёт принадлежит
        OR EXISTS (SELECT 1 FROM vaishnavas v
                    WHERE v.user_id = auth.uid()
                      AND (v.id = a.responsible_person_id
                        OR EXISTS (SELECT 1 FROM fin_departments d
                                    WHERE d.id = a.department_id
                                      AND d.responsible_person_id = v.id)))
      )
  );
$function$;

-- 2) Право «пользователь счетов» тоже становится производным: попадает в набор
--    прав, пока человек — ответственный. Явный отзыв (is_granted = false)
--    по-прежнему сильнее, потому что EXCEPT применяется последним.
create or replace function get_user_permissions(p_user_id uuid)
returns table(permission_code text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN RETURN; END IF;
    RETURN QUERY
        SELECT DISTINCT p.code::text FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = p_user_id AND ur.is_active = true
        UNION
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = true
        UNION
        SELECT 'fin_account_user'::text
        WHERE EXISTS (
          SELECT 1 FROM vaishnavas v
          WHERE v.user_id = p_user_id
            AND (EXISTS (SELECT 1 FROM fin_departments d WHERE d.responsible_person_id = v.id)
              OR EXISTS (SELECT 1 FROM fin_accounts a WHERE a.responsible_person_id = v.id AND a.is_active))
        )
        EXCEPT
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = false;
END;
$function$;
