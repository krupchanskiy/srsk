-- У десяти функций search_path не зафиксирован: вызывающая роль может подменить его
-- и подсунуть свою таблицу вместо нашей. Для SECURITY DEFINER это путь к чужим правам.
do $$
declare r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('fin_fmt_money','fin_plural','fin_fmt_date_ru','fin_short_account_name',
                         'crm_auto_tasks','trg_ppo_recalc_balance','trg_ppo_touch_updated_at',
                         'trg_payment_recalc_balance','recalc_participant_balance',
                         'crm_assign_manager_if_missing')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  loop
    execute format('alter function public.%I(%s) set search_path to ''public''', r.proname, r.args);
  end loop;
end $$;
