-- «Завести счёт» в карточке департамента падало с «Нет соединения с сервером».
-- Причина не в сети: все fin_*-функции принимают единственный аргумент payload jsonb,
-- а fin_add_department_account была сделана с двумя именованными (p_department, p_currency).
-- Обёртка FinUtils.rpc заворачивает аргументы в payload, PostgREST не находил такую
-- функцию и отвечал ошибкой, которую фронт показывал как обрыв связи.
-- Приводим к общему соглашению.

drop function if exists public.fin_add_department_account(uuid, text);

create or replace function public.fin_add_department_account(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_department uuid;
  v_currency text;
  v_acc uuid;
  v_name text;
begin
  if not fin_is_admin() then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'forbidden', 'message', 'Только администратор финансов'));
  end if;

  v_department := nullif(payload->>'p_department', '')::uuid;
  v_currency   := nullif(payload->>'p_currency', '');

  if v_department is null or v_currency is null then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Укажите департамент и валюту'));
  end if;

  if not exists (select 1 from fin_departments where id = v_department) then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Департамент не найден'));
  end if;

  if not exists (select 1 from fin_currencies where code = v_currency and is_active) then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'invalid_payload', 'message', 'Валюта не найдена'));
  end if;

  v_acc := fin_dept_account(v_department, v_currency);
  select name into v_name from fin_accounts where id = v_acc;

  return jsonb_build_object('ok', true,
    'result', jsonb_build_object('account_id', v_acc, 'name', v_name));
end;
$function$;

revoke all on function public.fin_add_department_account(jsonb) from public, anon;
grant execute on function public.fin_add_department_account(jsonb) to authenticated, service_role;
