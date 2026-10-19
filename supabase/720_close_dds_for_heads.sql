-- 720: ДДС закрыт всем, кроме финансистов (ВГ 19.10: «доступ к ДДС ограничить всем, кроме тех,
-- кто имеет отношение к ДДС: я, Ачинтья Кришна и Нитья-виласини»).
-- Раньше fin_account_user выдавался сам главе любого департамента и ответственному за любой счёт.
-- Теперь авто-выдачи нет: главы видят свои счета на странице департамента («Подотчёт», «Выручка»,
-- «Аналитика») через fin_dept_viewer (мигр. 704). Сервер на запись авто-право никогда
-- не учитывал (fin_is_account_user — только явная выдача), это правка видимости страниц.
-- Личные счета Ашиша и Олега Карпова теперь видят только финансисты (решение ВГ: ДДС — только трём).

create or replace function public.get_user_permissions(p_user_id uuid)
 returns table(permission_code text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
BEGIN
    IF auth.uid() IS NULL OR auth.uid() != p_user_id THEN RETURN; END IF;
    RETURN QUERY
        SELECT DISTINCT p.code::text FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = p_user_id AND ur.is_active = true
        UNION
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = true
        UNION
        -- глава и люди из списка «Кто видит департамент» (мигр. 704)
        SELECT 'fin_dept_viewer'::text
        WHERE EXISTS (SELECT 1 FROM fin_user_department_ids(p_user_id) x
                        JOIN fin_departments d ON d.id = x WHERE d.for_people)
        EXCEPT
        SELECT p.code::text FROM user_permissions up JOIN permissions p ON p.id = up.permission_id WHERE up.user_id = p_user_id AND up.is_granted = false;
END;
$function$;
