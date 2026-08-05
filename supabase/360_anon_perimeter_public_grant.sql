-- Право вызова было выдано роли PUBLIC (все роли разом), поэтому отзыв у anon его не снимал.
-- Выдаём явно тем, кому нужно (приложение и Edge Functions), и снимаем у PUBLIC.
-- Триггерным функциям EXECUTE не нужен: права проверяются при создании триггера, не при срабатывании.
do $$
declare
  v_белый text[] := array[
    'register_guest', 'check_email_exists', 'create_guest_account',
    'has_permission', 'is_superuser', 'is_staff', 'get_own_vaishnava_ids', 'own_vaishnava_id',
    'is_plant_user', 'current_user_has_upload_permission', 'fin_is_admin', 'fin_can_read_all',
    'crm_can_edit_retreat_prices'
  ];
  r record;
  v_счёт int := 0;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and has_function_privilege('anon', p.oid, 'execute')
       and not (p.proname = any(v_белый))
  loop
    execute format('grant execute on function public.%I(%s) to authenticated, service_role',
                   r.proname, r.args);
    execute format('revoke execute on function public.%I(%s) from public, anon',
                   r.proname, r.args);
    v_счёт := v_счёт + 1;
  end loop;
  raise notice 'Закрыто от анонима: % функций', v_счёт;
end $$;
