-- =============================================================
-- Финмодуль, Этап 0 — gate-тесты (повторяемые, без следов в БД)
-- Запуск: каждый блок отдельным вызовом execute_sql / psql.
-- Блоки 1 и 2 ДОЛЖНЫ завершиться ошибкой permission denied —
-- это и есть успех теста.
-- =============================================================

-- ТЕСТ 1 (ожидается ошибка "permission denied"): anon не читает fin_-таблицы
-- BEGIN; SET LOCAL ROLE anon; SELECT count(*) FROM fin_categories; ROLLBACK;

-- ТЕСТ 2 (ожидается ошибка "permission denied"): authenticated не пишет
-- BEGIN; SET LOCAL ROLE authenticated; INSERT INTO fin_cost_centers (code, name) VALUES ('hack', 'Hack'); ROLLBACK;

-- ТЕСТ 3 (ожидается результат 'audit gate passed'): аудит работает,
-- причина копируется из транзакционного контекста, лог не аудитирует
-- себя и append-only. Вся проверка откатывается.
BEGIN;
SELECT set_config('app.change_reason', 'gate-test', true),
       set_config('app.request_id', gen_random_uuid()::text, true);
INSERT INTO fin_cost_centers (code, name) VALUES ('gate_test', 'Gate Test');
UPDATE fin_cost_centers SET name = 'Gate Test 2' WHERE code = 'gate_test';
DO $$
DECLARE
  v_id text;
  n int;
  r text;
BEGIN
  SELECT id::text INTO v_id FROM fin_cost_centers WHERE code = 'gate_test';

  SELECT count(*) INTO n FROM fin_audit_log WHERE entity = 'fin_cost_centers' AND entity_id = v_id;
  IF n <> 2 THEN RAISE EXCEPTION 'GATE FAIL: ожидалось 2 аудит-записи, получено %', n; END IF;

  SELECT reason INTO r FROM fin_audit_log
   WHERE entity = 'fin_cost_centers' AND entity_id = v_id AND action = 'update';
  IF r IS DISTINCT FROM 'gate-test' THEN RAISE EXCEPTION 'GATE FAIL: reason не скопирован (%)', r; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM fin_audit_log
     WHERE entity = 'fin_cost_centers' AND entity_id = v_id AND action = 'update'
       AND before_data->>'name' = 'Gate Test' AND after_data->>'name' = 'Gate Test 2'
  ) THEN RAISE EXCEPTION 'GATE FAIL: before/after некорректны'; END IF;

  IF EXISTS (SELECT 1 FROM fin_audit_log WHERE entity = 'fin_audit_log') THEN
    RAISE EXCEPTION 'GATE FAIL: аудит аудитирует сам себя';
  END IF;

  BEGIN
    UPDATE public.fin_audit_log SET reason = 'hack' WHERE entity_id = v_id;
    RAISE EXCEPTION 'GATE FAIL: лог оказался редактируемым';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;

  BEGIN
    DELETE FROM public.fin_audit_log WHERE entity_id = v_id;
    RAISE EXCEPTION 'GATE FAIL: лог оказался удаляемым';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;
END $$;
ROLLBACK;
SELECT 'audit gate passed' AS result;

-- ТЕСТ 4 (все значения должны быть true / ожидаемыми): утилиты и helpers
SELECT
  fin_private_hash('{"b":2,"a":1}'::jsonb) = fin_private_hash('{"a":1,"b":2}'::jsonb) AS hash_key_order_independent,
  fin_private_hash('{"a":1}'::jsonb) <> fin_private_hash('{"a":2}'::jsonb) AS hash_differs_on_content,
  fin_private_norm_money(1234.5) = '1234.50' AS norm_money_ok,
  (SELECT fin_is_admin(user_id) FROM superusers LIMIT 1) AS superuser_is_fin_admin,
  (SELECT count(*) FROM fin_currencies) = 4 AS currencies_seeded,
  (SELECT count(*) FROM permissions WHERE category = 'finance') = 3 AS fin_permissions_ok;
