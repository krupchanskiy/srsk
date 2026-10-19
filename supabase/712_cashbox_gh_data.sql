-- 712: данные «Кассы ДДС у ГХ» (ВГ 19.10). Выполнено от имени ВГ (request.jwt.claims),
-- через fin_create_account / fin_create_transfer; уведомления в чат подавлены.
-- 1. Счета «Касса ДДС у ГХ (₹)» и «($)», держатель Нитья-виласини, хранятся у Гест-хауса.
-- 2. Прошлые операции временной кассы на счетах Гест-хауса помечены is_transit (43 проводки):
--    приходы (выручка кафе/магазина, мурти, прасад, оплаты гостей, пожертвование) и их сторно,
--    размен кафе туда-обратно, «500 000 в сейфе на всякий пожарный».
-- 3. Остаток временной кассы перенесён переводом: 864 700 ₹ и 450 $ (сверено: на «Гест-хаус (₹)»
--    остаётся 15 004 ₹ — деньги на хозяйство, на «Гест-хаус ($)» — 0).
select set_config('request.jwt.claims', json_build_object('sub','8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746','role','authenticated')::text, true);
select set_config('tg.suppress_chat_notify', '1', true);
do $$
declare gh uuid := (select id from fin_departments where code = 'guesthouse');
        nitya uuid := 'e1f8783e-ed28-4fb6-a9e0-59a24dbe91d7';
        gh_inr uuid := (select id from fin_accounts where name = 'Гест-хаус (₹)');
        gh_usd uuid := (select id from fin_accounts where name = 'Гест-хаус ($)');
        r jsonb; inr uuid; usd uuid; n int;
begin
  r := fin_create_account(jsonb_build_object('name', 'Касса ДДС у ГХ (₹)', 'kind', 'real', 'reconciliation_mode', 'cash_count',
         'currency_code', 'INR', 'group_name', 'Касса', 'responsible_person_id', nitya));
  if not (r->>'ok')::boolean then raise exception 'account inr: %', r; end if;
  inr := (r->'result'->>'account_id')::uuid;
  r := fin_create_account(jsonb_build_object('name', 'Касса ДДС у ГХ ($)', 'kind', 'real', 'reconciliation_mode', 'cash_count',
         'currency_code', 'USD', 'group_name', 'Касса', 'responsible_person_id', nitya));
  if not (r->>'ok')::boolean then raise exception 'account usd: %', r; end if;
  usd := (r->'result'->>'account_id')::uuid;
  update fin_accounts set cashbox_department_id = gh where id in (inr, usd);

  update fin_postings p set is_transit = true
   where p.id in (
     select p.id from fin_postings p
       join fin_accounts a on a.id = p.account_id
       join fin_operations o on o.id = p.operation_id
       left join fin_categories c on c.id = p.category_id
      where a.department_id = gh
        and (o.type in ('income', 'payment', 'donation')
             or (o.type = 'reversal' and c.direction = 'in')
             or exists (select 1 from fin_postings p2 join fin_accounts a2 on a2.id = p2.account_id
                         where p2.operation_id = o.id and p2.account_id <> p.account_id and a2.name like 'Кафе%')
             or o.comment like '%в сейфе на всякий пожарный%'));
  get diagnostics n = row_count;
  if n <> 43 then raise exception 'ожидалось 43 проводки временной кассы, найдено %', n; end if;

  r := fin_create_transfer(jsonb_build_object('request_id', 'a7c1d0e2-0712-4c19-9a00-000000000001', 'occurred_on', '2026-10-19',
         'source_account_id', gh_inr, 'target_account_id', inr, 'source_amount', 864700, 'target_amount', 864700,
         'comment', 'Перенос временной кассы ДДС со счёта Гест-хауса (накоплено до 19.10)'));
  if not (r->>'ok')::boolean then raise exception 'transfer inr: %', r; end if;
  update fin_postings set is_transit = true where operation_id = (r->'result'->>'operation_id')::uuid and account_id = gh_inr;

  r := fin_create_transfer(jsonb_build_object('request_id', 'a7c1d0e2-0712-4c19-9a00-000000000002', 'occurred_on', '2026-10-19',
         'source_account_id', gh_usd, 'target_account_id', usd, 'source_amount', 450, 'target_amount', 450,
         'comment', 'Перенос временной кассы ДДС со счёта Гест-хауса (накоплено до 19.10)'));
  if not (r->>'ok')::boolean then raise exception 'transfer usd: %', r; end if;
  update fin_postings set is_transit = true where operation_id = (r->'result'->>'operation_id')::uuid and account_id = gh_usd;
end $$;
select set_config('tg.suppress_chat_notify', '', true);
