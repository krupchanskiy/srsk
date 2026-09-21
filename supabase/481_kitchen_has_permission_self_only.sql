-- kitchen_has_permission (480) позволяла любому вошедшему проверять права
-- других пользователей. Теперь отвечает только про самого вызывающего:
-- все места вызова (политики RLS и функции цен) передают auth.uid().
create or replace function public.kitchen_has_permission(p_user uuid, p_code text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when p_user is null or p_user is distinct from auth.uid() then false
    when exists (select 1 from user_permissions up join permissions p on p.id = up.permission_id
                  where up.user_id = p_user and p.code = p_code)
      then (select up.is_granted from user_permissions up join permissions p on p.id = up.permission_id
             where up.user_id = p_user and p.code = p_code
             order by up.created_at desc limit 1)
    else exists (select 1 from user_roles ur
                   join role_permissions rp on rp.role_id = ur.role_id
                   join permissions p on p.id = rp.permission_id
                  where ur.user_id = p_user and ur.is_active and p.code = p_code)
  end;
$$;
