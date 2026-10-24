-- 747: «Касса ДДС у ГХ» во всех четырёх валютах (ВГ 24.10). Пришло пожертвование в евро,
-- приняла Нитья-виласини — к ₹ и $ (мигр. 712) добавлены ₽ и €, чтобы были сразу.
-- Выполнено от имени ВГ (request.jwt.claims) через fin_create_account, как в 712.
select set_config('request.jwt.claims', json_build_object('sub','8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746','role','authenticated')::text, true);
do $$
declare gh uuid := (select id from fin_departments where code = 'guesthouse');
        nitya uuid := 'e1f8783e-ed28-4fb6-a9e0-59a24dbe91d7';
        r jsonb; rub uuid; eur uuid;
begin
  r := fin_create_account(jsonb_build_object('name', 'Касса ДДС у ГХ (₽)', 'kind', 'real', 'reconciliation_mode', 'cash_count',
         'currency_code', 'RUB', 'group_name', 'Касса', 'responsible_person_id', nitya));
  if not (r->>'ok')::boolean then raise exception 'account rub: %', r; end if;
  rub := (r->'result'->>'account_id')::uuid;
  r := fin_create_account(jsonb_build_object('name', 'Касса ДДС у ГХ (€)', 'kind', 'real', 'reconciliation_mode', 'cash_count',
         'currency_code', 'EUR', 'group_name', 'Касса', 'responsible_person_id', nitya));
  if not (r->>'ok')::boolean then raise exception 'account eur: %', r; end if;
  eur := (r->'result'->>'account_id')::uuid;
  update fin_accounts set cashbox_department_id = gh where id in (rub, eur);
end $$;
