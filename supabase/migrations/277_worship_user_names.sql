-- 277: имена авторов правок для отдела «Поклонения».
-- Лента «Что изменилось», черновики и очередь показывают, кто писал и кто
-- утверждал. vaishnavas отдаёт чужие карточки только сотрудникам, поэтому
-- у пуджари без этих прав вместо имён было бы «отдел». Функция отдаёт
-- только имя и только тем, кто видит модуль.
create or replace function worship_user_names(p_users uuid[])
returns table (user_id uuid, name text)
language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select v.user_id,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'без имени')
      from vaishnavas v
     where worship_can_view() and v.user_id = any(p_users) and not v.is_deleted
$$;
revoke all on function worship_user_names(uuid[]) from public, anon;
grant execute on function worship_user_names(uuid[]) to authenticated;
