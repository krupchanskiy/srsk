-- 300: кто в отделе «Поклонения» — тот видит «Поклонение»
-- (Коти Чандра Нитай-прия и Джагадишвари Мадхави не видели раздел, 08.11.2026).
--
-- Старший добавлял человека в отдел, но право worship_view выдаётся отдельно —
-- ролью или вручную. Из 19 человек отдела 11 раздел не видели вовсе, а у
-- гостевой учётки без роли не помогало и одно право: вход отправлял её в
-- гостевой портал.
--
-- Теперь состав отдела сам даёт просмотр «Поклонения» и пускает в основное
-- приложение (только в этот раздел — других прав это не добавляет). Человек
-- в резерве или убранный из отдела доступ теряет. Явный запрет worship_view
-- в правах человека по-прежнему сильнее.

create or replace function worship_is_member(p_user_id uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
    select p_user_id is not null and exists (
        select 1 from worship_people p
          join vaishnavas v on v.id = p.vaishnava_id
         where v.user_id = p_user_id and not v.is_deleted
           and p.is_active and p.removed_at is null)
$$;
revoke all on function worship_is_member(uuid) from public, anon, authenticated;

-- права для интерфейса: + worship_view участнику отдела
do $$
declare d text; якорь text := '        EXCEPT';
begin
    d := pg_get_functiondef('public.get_user_permissions(uuid)'::regprocedure);
    if (length(d) - length(replace(d, якорь, ''))) / length(якорь) <> 1 then
        raise exception 'get_user_permissions: место для правила не найдено';
    end if;
    execute replace(d, якорь,
'        UNION
        -- участник отдела «Поклонения» видит раздел (мигр. 300)
        SELECT ''worship_view''::text WHERE public.worship_is_member(p_user_id)
' || якорь);
end $$;

-- данные раздела (все политики «Поклонения» идут через эту функцию)
create or replace function worship_can_view()
returns boolean language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select abk_current_user_has_permission('worship_view')
        or (worship_is_member(auth.uid())
            and not exists (select 1 from user_permissions up join permissions p on p.id = up.permission_id
                             where up.user_id = auth.uid() and p.code = 'worship_view' and not up.is_granted))
$$;

-- вход в основное приложение (иначе гостевую учётку уводит в портал)
create or replace function has_main_backoffice_access()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
    select public.abk_has_general_staff_access(auth.uid()) or public.worship_is_member(auth.uid())
$$;
