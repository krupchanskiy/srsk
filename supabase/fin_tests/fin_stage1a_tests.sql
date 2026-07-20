-- =============================================================
-- Финмодуль, Этап 1а — интеграционные тесты денежного ядра
-- Запуск: одним батчем (execute_sql / psql). Всё в транзакции
-- с ROLLBACK — следов в БД не остаётся.
-- Успех: последний SELECT возвращает 'stage1a integration passed'.
--
-- Покрытие:
--   T1  opening + остаток
--   T2  идемпотентный повтор (тот же UUID+hash -> та же операция)
--   T3  тот же UUID, другой payload -> idempotency_conflict
--   T4  второй opening другим UUID -> opening_already_exists (сц. 99)
--   T5  перевод касса->кафе, остатки обеих сторон
--   T6  replace_opening после обычной проводки -> отказ
--   T7  расход: cost center подставлен из default счёта (сц. 41)
--   T8  реальный счёт в минус -> insufficient_funds (сц. 27 sequential)
--   T9  custodial в минус -> успех + предупреждение (сц. 21)
--   T10 opening валютного счёта: amount_base по курсу
--   T11 FX-перевод: amount_base ног равен, курс входящей ноги выведен (сц. 9)
--   T12 расходный opening наличного реального счёта -> запрет
--   T13 округление группы: сумма частей = round(целое) (сц. 76)
--   T14 post-close: без причины отказ, с причиной ok + is_post_close +
--       not_required + report_dirty_at (сц. 13, 32, 93)
--   T15 нет курса -> exchange_rate_missing
--   T16 replace_opening счастливый путь (сц. 100)
--   T17 аудит фиксирует денежные вставки
--   T18 не-админ: forbidden на RPC, пустой view остатков
-- Плюс отдельный блок: триггеры неизменности (amount/DELETE/occurred_on).
--
-- TODO (этап 2): истинно конкурентные тесты (два соединения psql) —
-- гонка двух расходов на один остаток, гонка сверки.
-- =============================================================

BEGIN;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', (SELECT user_id::text FROM superusers LIMIT 1), 'role', 'authenticated')::text, true);

DO $body$
DECLARE
  v_admin uuid := (SELECT user_id FROM superusers LIMIT 1);
  v_retreat uuid := (SELECT id FROM retreats ORDER BY created_at LIMIT 1);
  res jsonb;
  v_kassa uuid; v_kafe uuid; v_usd uuid; v_kassa2 uuid; v_eur uuid;
  v_cc uuid; v_cat_out uuid; v_cat_in uuid;
  v_obj uuid;
  op_open uuid := gen_random_uuid();
  op_tr uuid := gen_random_uuid();
  op_exp uuid := gen_random_uuid();
  op_x uuid;
  v_bases numeric;
BEGIN
  INSERT INTO fin_cost_centers (code, name) VALUES ('test_cc', 'Тест ЦЗ') RETURNING id INTO v_cc;
  INSERT INTO fin_categories (code, name, direction, visible_to_departments) VALUES ('test_exp', 'Тест расход', 'out', true) RETURNING id INTO v_cat_out;
  INSERT INTO fin_categories (code, name, direction) VALUES ('test_inc', 'Тест приход', 'in') RETURNING id INTO v_cat_in;
  INSERT INTO fin_exchange_rates (effective_date, from_currency, rate, created_by) VALUES ('2026-01-01', 'USD', 83.5, v_admin);

  res := fin_create_account(jsonb_build_object('name','ТЕСТ Касса ₹','kind','real','reconciliation_mode','cash_count','currency_code','INR'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T0 create_account: %', res; END IF;
  v_kassa := (res#>>'{result,account_id}')::uuid;
  res := fin_create_account(jsonb_build_object('name','ТЕСТ Кафе ₹','kind','custodial','reconciliation_mode','cash_count','currency_code','INR','default_cost_center_id',v_cc));
  v_kafe := (res#>>'{result,account_id}')::uuid;
  res := fin_create_account(jsonb_build_object('name','ТЕСТ PayPal $','kind','real','reconciliation_mode','statement','currency_code','USD'));
  v_usd := (res#>>'{result,account_id}')::uuid;

  res := fin_ensure_accounting_object(v_retreat);
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T0 ensure_object: %', res; END IF;
  v_obj := (res#>>'{result,object_id}')::uuid;

  res := fin_create_opening(jsonb_build_object('request_id',op_open,'account_id',v_kassa,'direction','in','amount','347000.00','occurred_on','2026-07-01','comment','cutover'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T1 opening: %', res; END IF;
  IF fin_private_account_balance(v_kassa) <> 347000 THEN RAISE EXCEPTION 'T1 balance: %', fin_private_account_balance(v_kassa); END IF;

  res := fin_create_opening(jsonb_build_object('request_id',op_open,'account_id',v_kassa,'direction','in','amount','347000.00','occurred_on','2026-07-01','comment','cutover'));
  IF NOT (res->>'ok')::bool OR (res#>>'{result,operation_id}')::uuid <> op_open THEN RAISE EXCEPTION 'T2 retry: %', res; END IF;
  IF (SELECT count(*) FROM fin_operations WHERE id = op_open) <> 1 THEN RAISE EXCEPTION 'T2 dup'; END IF;

  res := fin_create_opening(jsonb_build_object('request_id',op_open,'account_id',v_kassa,'direction','in','amount','999.00','occurred_on','2026-07-01','comment','cutover'));
  IF (res#>>'{error,code}') <> 'idempotency_conflict' THEN RAISE EXCEPTION 'T3: %', res; END IF;

  res := fin_create_opening(jsonb_build_object('request_id',gen_random_uuid(),'account_id',v_kassa,'direction','in','amount','1000.00','occurred_on','2026-07-01'));
  IF (res#>>'{error,code}') <> 'opening_already_exists' THEN RAISE EXCEPTION 'T4: %', res; END IF;

  res := fin_create_transfer(jsonb_build_object('request_id',op_tr,'occurred_on','2026-07-02','source_account_id',v_kassa,'target_account_id',v_kafe,'source_amount','200000.00','comment','выдача'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T5 transfer: %', res; END IF;
  IF fin_private_account_balance(v_kassa) <> 147000 OR fin_private_account_balance(v_kafe) <> 200000 THEN RAISE EXCEPTION 'T5 balances'; END IF;

  res := fin_replace_opening(jsonb_build_object('request_id',gen_random_uuid(),'original_opening_operation_id',op_open,'new_direction','in','new_amount','337000.00','reason','ошибка'));
  IF (res#>>'{error,code}') <> 'opening_replacement_not_allowed' THEN RAISE EXCEPTION 'T6: %', res; END IF;

  res := fin_create_expense(jsonb_build_object('request_id',op_exp,'occurred_on','2026-07-03','comment','закупка',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',v_kafe,'amount','57000.00','category_id',v_cat_out,'payment_channel','cash'))));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T7 expense: %', res; END IF;
  IF fin_private_account_balance(v_kafe) <> 143000 THEN RAISE EXCEPTION 'T7 balance'; END IF;
  IF (SELECT cost_center_id FROM fin_postings WHERE operation_id = op_exp) IS DISTINCT FROM v_cc THEN RAISE EXCEPTION 'T7 default cost center'; END IF;

  res := fin_create_expense(jsonb_build_object('request_id',gen_random_uuid(),'occurred_on','2026-07-03',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',v_kassa,'amount','200000.00','category_id',v_cat_out))));
  IF (res#>>'{error,code}') <> 'insufficient_funds' THEN RAISE EXCEPTION 'T8: %', res; END IF;

  res := fin_create_expense(jsonb_build_object('request_id',gen_random_uuid(),'occurred_on','2026-07-03',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',v_kafe,'amount','150000.00','category_id',v_cat_out))));
  IF NOT (res->>'ok')::bool OR (res#>>'{warnings,0,code}') <> 'custodial_negative_balance' THEN RAISE EXCEPTION 'T9: %', res; END IF;
  IF fin_private_account_balance(v_kafe) <> -7000 THEN RAISE EXCEPTION 'T9 balance'; END IF;

  op_x := gen_random_uuid();
  res := fin_create_opening(jsonb_build_object('request_id',op_x,'account_id',v_usd,'direction','in','amount','1000.00','occurred_on','2026-07-01'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T10: %', res; END IF;
  IF (SELECT amount_base FROM fin_postings WHERE operation_id = op_x) <> 83500.00 THEN RAISE EXCEPTION 'T10 base'; END IF;

  op_x := gen_random_uuid();
  res := fin_create_transfer(jsonb_build_object('request_id',op_x,'occurred_on','2026-07-04','source_account_id',v_kassa,'target_account_id',v_usd,'source_amount','8350.00','target_amount','100.00','comment','обмен'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T11: %', res; END IF;
  IF (SELECT count(DISTINCT amount_base) FROM fin_postings WHERE operation_id = op_x) <> 1 THEN RAISE EXCEPTION 'T11 base mismatch'; END IF;
  IF (SELECT rate_used FROM fin_postings WHERE operation_id = op_x AND direction = 'in') <> 83.5 THEN RAISE EXCEPTION 'T11 rate'; END IF;

  res := fin_create_account(jsonb_build_object('name','ТЕСТ Касса 2','kind','real','reconciliation_mode','cash_count','currency_code','INR'));
  v_kassa2 := (res#>>'{result,account_id}')::uuid;
  res := fin_create_opening(jsonb_build_object('request_id',gen_random_uuid(),'account_id',v_kassa2,'direction','out','amount','5000.00','occurred_on','2026-07-01','comment','долг'));
  IF (res#>>'{error,code}') <> 'negative_cash_opening_forbidden' THEN RAISE EXCEPTION 'T12: %', res; END IF;

  op_x := gen_random_uuid();
  res := fin_create_expense(jsonb_build_object('request_id',op_x,'occurred_on','2026-07-04',
    'rows', jsonb_build_array(
      jsonb_build_object('id','00000000-0000-4000-8000-000000000001','account_id',v_usd,'amount','33.33','category_id',v_cat_out),
      jsonb_build_object('id','00000000-0000-4000-8000-000000000002','account_id',v_usd,'amount','66.67','category_id',v_cat_out))));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T13: %', res; END IF;
  SELECT SUM(amount_base) INTO v_bases FROM fin_postings WHERE operation_id = op_x;
  IF v_bases <> round(100.00 * 83.5, 2) THEN RAISE EXCEPTION 'T13 rounding: %', v_bases; END IF;

  INSERT INTO fin_object_closures (id, request_hash, object_id, version, is_initial, status, closed_by, totals_snapshot, snapshot_schema_version)
  VALUES (gen_random_uuid(), 'test', v_obj, 1, true, 'report_pending', v_admin, '{}'::jsonb, 1);
  res := fin_create_expense(jsonb_build_object('request_id',gen_random_uuid(),'occurred_on','2026-07-05',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',v_kassa,'amount','100.00','category_id',v_cat_out,'object_id',v_obj))));
  IF (res#>>'{error,code}') <> 'post_close_reason_required' THEN RAISE EXCEPTION 'T14a: %', res; END IF;
  op_x := gen_random_uuid();
  res := fin_create_expense(jsonb_build_object('request_id',op_x,'occurred_on','2026-07-05','reason','поздняя комиссия',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',v_kassa,'amount','100.00','category_id',v_cat_out,'object_id',v_obj))));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T14b: %', res; END IF;
  IF NOT (SELECT is_post_close FROM fin_postings WHERE operation_id = op_x) THEN RAISE EXCEPTION 'T14b is_post_close'; END IF;
  IF (SELECT approval FROM fin_operations WHERE id = op_x) <> 'not_required' THEN RAISE EXCEPTION 'T14b approval'; END IF;
  IF (SELECT report_dirty_at FROM fin_accounting_objects WHERE id = v_obj) IS NULL THEN RAISE EXCEPTION 'T14b dirty'; END IF;

  res := fin_create_account(jsonb_build_object('name','ТЕСТ Банк €','kind','real','reconciliation_mode','statement','currency_code','EUR'));
  v_eur := (res#>>'{result,account_id}')::uuid;
  res := fin_create_opening(jsonb_build_object('request_id',gen_random_uuid(),'account_id',v_eur,'direction','in','amount','500.00','occurred_on','2026-07-01'));
  IF (res#>>'{error,code}') <> 'exchange_rate_missing' THEN RAISE EXCEPTION 'T15: %', res; END IF;

  op_x := gen_random_uuid();
  res := fin_create_opening(jsonb_build_object('request_id',op_x,'account_id',v_kassa2,'direction','in','amount','347000.00','occurred_on','2026-07-01'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T16a: %', res; END IF;
  res := fin_replace_opening(jsonb_build_object('request_id',gen_random_uuid(),'original_opening_operation_id',op_x,'new_direction','in','new_amount','337000.00','reason','Ошибка в cutover-реестре'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'T16b: %', res; END IF;
  IF fin_private_account_balance(v_kassa2) <> 337000 THEN RAISE EXCEPTION 'T16 balance: %', fin_private_account_balance(v_kassa2); END IF;
  IF NOT (SELECT is_reversed FROM fin_operations WHERE id = op_x) THEN RAISE EXCEPTION 'T16 orig not reversed'; END IF;

  IF (SELECT count(*) FROM fin_audit_log WHERE entity = 'fin_postings') < 10 THEN RAISE EXCEPTION 'T17 audit'; END IF;

  RAISE NOTICE 'ADMIN TESTS OK';
END $body$;

SELECT set_config('request.jwt.claims', jsonb_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text, true);
DO $$
DECLARE res jsonb;
BEGIN
  res := fin_create_expense(jsonb_build_object('request_id',gen_random_uuid(),'occurred_on','2026-07-05',
    'rows', jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'account_id',gen_random_uuid(),'amount','1.00','category_id',gen_random_uuid()))));
  IF (res#>>'{error,code}') <> 'forbidden' THEN RAISE EXCEPTION 'T18a: %', res; END IF;
  res := fin_create_opening(jsonb_build_object('request_id',gen_random_uuid(),'account_id',gen_random_uuid(),'direction','in','amount','1.00','occurred_on','2026-07-01'));
  IF (res#>>'{error,code}') <> 'forbidden' THEN RAISE EXCEPTION 'T18b: %', res; END IF;
  IF (SELECT count(*) FROM fin_v_account_balances) <> 0 THEN RAISE EXCEPTION 'T18c: view отдаёт чужие счета'; END IF;
END $$;

ROLLBACK;
SELECT 'stage1a integration passed (T1-T18)' AS result;

-- =============================================================
-- Отдельный блок: защитные триггеры неизменности (тоже с откатом)
-- =============================================================
BEGIN;
SELECT set_config('request.jwt.claims',
  jsonb_build_object('sub', (SELECT user_id::text FROM superusers LIMIT 1), 'role', 'authenticated')::text, true);
DO $$
DECLARE
  res jsonb; v_acc uuid; op uuid := gen_random_uuid();
BEGIN
  res := fin_create_account(jsonb_build_object('name','ТЕСТ Immutable','kind','real','reconciliation_mode','cash_count','currency_code','INR'));
  v_acc := (res#>>'{result,account_id}')::uuid;
  res := fin_create_opening(jsonb_build_object('request_id',op,'account_id',v_acc,'direction','in','amount','1000.00','occurred_on','2026-07-01'));
  IF NOT (res->>'ok')::bool THEN RAISE EXCEPTION 'setup: %', res; END IF;
  BEGIN
    UPDATE fin_postings SET amount = 999 WHERE operation_id = op;
    RAISE EXCEPTION 'GUARD FAIL: amount editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%fin_postings_immutable%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM fin_postings WHERE operation_id = op;
    RAISE EXCEPTION 'GUARD FAIL: posting deletable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%fin_postings_immutable%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE fin_operations SET occurred_on = '2026-07-02' WHERE id = op;
    RAISE EXCEPTION 'GUARD FAIL: occurred_on editable';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%fin_operations_immutable%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'immutability guards passed' AS result;
