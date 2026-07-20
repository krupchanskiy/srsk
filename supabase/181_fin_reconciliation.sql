-- =============================================================
-- Финансовый модуль, Этап 2: сверка и передача ответственности
-- perform_reconciliation (единственная публичная точка входа),
-- transfer_account_responsibility, номиналы, история сверок,
-- чекпоинт-поля в view остатков.
-- ТЗ v4.2.10: разделы 4.9, 5 (инварианты 5-6), UC-1, UC-2;
-- Guide: 11.15, 11.16.
-- =============================================================

-- -------------------------------------------------------------
-- Номиналы валют (ТЗ 4.9)
-- -------------------------------------------------------------
CREATE TABLE fin_denominations (
  currency_code text NOT NULL REFERENCES fin_currencies(code),
  value         numeric(14,2) NOT NULL CHECK (value > 0),
  PRIMARY KEY (currency_code, value)
);

INSERT INTO fin_denominations (currency_code, value) VALUES
  ('INR', 2000), ('INR', 500), ('INR', 200), ('INR', 100), ('INR', 50), ('INR', 20), ('INR', 10),
  ('RUB', 5000), ('RUB', 2000), ('RUB', 1000), ('RUB', 500), ('RUB', 200), ('RUB', 100), ('RUB', 50),
  ('USD', 100), ('USD', 50), ('USD', 20), ('USD', 10), ('USD', 5), ('USD', 1),
  ('EUR', 500), ('EUR', 200), ('EUR', 100), ('EUR', 50), ('EUR', 20), ('EUR', 10), ('EUR', 5);

ALTER TABLE fin_denominations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON fin_denominations FROM anon, authenticated;
SELECT fin_private_attach_audit('fin_denominations');

CREATE OR REPLACE VIEW fin_v_denominations AS
SELECT currency_code, value
FROM fin_denominations
WHERE fin_can_read_all()
ORDER BY currency_code, value DESC;

GRANT SELECT ON fin_v_denominations TO authenticated;

-- -------------------------------------------------------------
-- Нормализация counts (ТЗ 4.9, фиксированное правило):
-- точки сортируются по имени; номиналы по возрастанию; дубль точки —
-- отказ; нулевые количества удаляются; other_amount требует
-- other_comment; неизвестные поля — отказ. Возвращает канонический
-- jsonb и серверно вычисленный итог.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_normalize_counts(
  p_counts jsonb,
  p_currency text,
  OUT normalized jsonb,
  OUT total numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_point jsonb;
  v_points jsonb := '[]'::jsonb;
  v_names text[] := '{}';
  v_name text;
  v_denoms jsonb;
  v_key text;
  v_qty numeric;
  v_denom numeric;
  v_point_total numeric;
  v_other numeric;
  v_norm_denoms jsonb;
BEGIN
  total := 0;
  IF p_counts IS NULL OR jsonb_typeof(p_counts) <> 'array' OR jsonb_array_length(p_counts) = 0 THEN
    RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'counts: требуется непустой массив точек хранения';
  END IF;

  FOR v_point IN SELECT * FROM jsonb_array_elements(p_counts)
  LOOP
    PERFORM fin_private_assert_keys(v_point, ARRAY['location', 'denominations', 'other_amount', 'other_comment']);

    v_name := NULLIF(trim(COALESCE(v_point->>'location', '')), '');
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'Точка хранения без имени';
    END IF;
    IF v_name = ANY (v_names) THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload'
        USING DETAIL = format('Точка хранения «%s» указана дважды — это ошибка ввода', v_name);
    END IF;
    v_names := v_names || v_name;

    v_denoms := COALESCE(v_point->'denominations', '{}'::jsonb);
    IF jsonb_typeof(v_denoms) <> 'object' THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'denominations: ожидается объект {номинал: количество}';
    END IF;

    v_point_total := 0;
    v_norm_denoms := '{}'::jsonb;
    FOR v_key IN SELECT k FROM jsonb_object_keys(v_denoms) k ORDER BY k::numeric
    LOOP
      BEGIN
        v_denom := v_key::numeric;
        v_qty := (v_denoms->>v_key)::numeric;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = format('Некорректный номинал или количество: %s', v_key);
      END;
      IF v_qty < 0 OR v_qty <> trunc(v_qty) THEN
        RAISE EXCEPTION 'invalid_reconciliation_payload'
          USING DETAIL = format('Количество номинала %s должно быть целым неотрицательным', v_key);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM fin_denominations d WHERE d.currency_code = p_currency AND d.value = v_denom) THEN
        RAISE EXCEPTION 'invalid_reconciliation_payload'
          USING DETAIL = format('Номинал %s не разрешён для валюты %s', v_key, p_currency);
      END IF;
      IF v_qty > 0 THEN
        -- нулевые количества удаляются перед хешированием
        v_norm_denoms := v_norm_denoms || jsonb_build_object(v_denom::text, v_qty);
        v_point_total := v_point_total + v_denom * v_qty;
      END IF;
    END LOOP;

    v_other := NULL;
    IF NULLIF(v_point->>'other_amount', '') IS NOT NULL THEN
      v_other := (v_point->>'other_amount')::numeric;
      IF v_other < 0 THEN
        RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'other_amount не может быть отрицательным';
      END IF;
      IF v_other > 0 AND NULLIF(trim(COALESCE(v_point->>'other_comment', '')), '') IS NULL THEN
        RAISE EXCEPTION 'invalid_reconciliation_payload'
          USING DETAIL = format('Точка «%s»: сумма «прочее» требует комментария', v_name);
      END IF;
      v_point_total := v_point_total + v_other;
    END IF;

    v_points := v_points || jsonb_build_array(jsonb_build_object(
      'location', v_name,
      'denominations', v_norm_denoms,
      'other_amount', CASE WHEN COALESCE(v_other, 0) > 0 THEN fin_private_norm_money(v_other) ELSE NULL END,
      'other_comment', CASE WHEN COALESCE(v_other, 0) > 0 THEN trim(v_point->>'other_comment') ELSE NULL END
    ));

    total := total + v_point_total;
  END LOOP;

  -- точки сортируются по имени
  SELECT jsonb_agg(p ORDER BY p->>'location') INTO normalized
  FROM jsonb_array_elements(v_points) p;
  total := round(total, 2);
END;
$$;

-- -------------------------------------------------------------
-- perform_reconciliation — вся сверка одним атомарным вызовом
-- (инвариант 5): проверка stale, корректировка (внутренняя),
-- чекпоинт. Command-idempotent (идемпотентность — первым шагом,
-- раньше reconciliation_stale: сценарий 81).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_perform_reconciliation(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_account fin_accounts%ROWTYPE;
  v_opened_seq bigint;
  v_statement numeric;
  v_counts jsonb;
  v_norm jsonb;
  v_counted numeric;
  v_reason text;
  v_comment text;
  v_canonical jsonb;
  v_hash text;
  v_existing fin_reconciliations%ROWTYPE;
  v_current_seq bigint;
  v_system numeric;
  v_diff numeric;
  v_adj_op uuid;
  v_cutoff bigint;
  v_rate numeric;
  v_today date;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Сверку выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'account_id', 'opened_seq', 'statement_balance', 'counts', 'adjustment_reason', 'comment'
  ]);

  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_reason  := NULLIF(trim(COALESCE(payload->>'adjustment_reason', '')), '');
  v_comment := NULLIF(trim(COALESCE(payload->>'comment', '')), '');

  BEGIN
    v_opened_seq := COALESCE(payload->>'opened_seq', '')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'opened_seq: ожидается номер последней проводки на момент открытия формы';
  END;

  -- счёт читаем ДО канонизации (нужен режим сверки), блокировка позже
  SELECT * INTO v_account FROM fin_accounts WHERE id = fin_private_get_uuid(payload, 'account_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден';
  END IF;

  -- режим-специфичная валидация payload (сценарии 82, 91)
  IF v_account.reconciliation_mode = 'statement' THEN
    IF payload->'counts' IS NOT NULL AND jsonb_typeof(payload->'counts') <> 'null' THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload'
        USING DETAIL = 'Счёт сверяется по выписке — пересчёт купюр (counts) недопустим';
    END IF;
    -- ноль и минус по выписке валидны, поэтому парсим напрямую (не get_money)
    IF NULLIF(payload->>'statement_balance', '') IS NULL THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'Требуется остаток по выписке (statement_balance)';
    END IF;
    BEGIN
      v_statement := round((payload->>'statement_balance')::numeric, 2);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload' USING DETAIL = 'statement_balance: некорректная сумма';
    END;
    v_counted := v_statement;
    v_norm := NULL;
  ELSE
    IF NULLIF(payload->>'statement_balance', '') IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_reconciliation_payload'
        USING DETAIL = 'Наличный счёт сверяется пересчётом купюр — остаток по выписке недопустим';
    END IF;
    SELECT n.normalized, n.total INTO v_norm, v_counted
    FROM fin_private_normalize_counts(payload->'counts', v_account.currency_code) n;
  END IF;

  -- канонизация: серверно вычисленный counted_balance, нормализованные counts
  v_canonical := jsonb_build_object(
    'command', 'perform_reconciliation',
    'account_id', lower(v_account.id::text),
    'opened_seq', v_opened_seq,
    'counted_balance', fin_private_norm_money(v_counted),
    'counts', v_norm,
    'adjustment_reason', v_reason,
    'comment', v_comment
  );
  v_hash := fin_private_hash(v_canonical);

  -- идемпотентность — первым шагом, раньше stale-проверки (сценарий 81)
  SELECT * INTO v_existing FROM fin_reconciliations WHERE id = v_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING DETAIL = 'Тот же request_id уже использован с другим содержимым сверки';
    END IF;
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
      'reconciliation_id', v_existing.id,
      'cutoff_ledger_seq', v_existing.cutoff_ledger_seq,
      'system_balance', v_existing.system_balance,
      'counted_balance', v_existing.counted_balance,
      'original_difference', v_existing.original_difference,
      'difference', v_existing.difference,
      'adjustment_operation_id', v_existing.adjustment_operation_id
    ), 'warnings', '[]'::jsonb);
  END IF;

  -- блокировка счёта и защита от гонки (ТЗ 4.9)
  SELECT * INTO v_account FROM fin_accounts WHERE id = v_account.id FOR UPDATE;
  SELECT COALESCE(MAX(ledger_seq), 0) INTO v_current_seq FROM fin_postings WHERE account_id = v_account.id;
  IF v_current_seq <> v_opened_seq THEN
    RAISE EXCEPTION 'reconciliation_stale'
      USING DETAIL = format('Пока форма была открыта, по счёту прошли операции (№%s → №%s) — обновите форму и пересчитайте', v_opened_seq, v_current_seq);
  END IF;

  v_system := fin_private_account_balance(v_account.id);
  v_diff := round(v_counted - v_system, 2);
  v_cutoff := v_opened_seq;
  v_adj_op := NULL;

  IF v_diff <> 0 THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'reconciliation_reason_required'
        USING DETAIL = format('Расхождение %s не устранено — укажите причину корректировки', v_diff);
    END IF;

    -- внутренняя корректировка (не отдельная клиентская команда)
    v_today := (now() AT TIME ZONE 'Asia/Kolkata')::date;
    v_rate := fin_private_get_rate(v_account.currency_code, NULL, v_today);
    v_adj_op := fin_private_child_uuid(v_request_id, 'adjustment');

    INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, reason, comment, created_by)
    VALUES (v_adj_op, v_hash, 'reconciliation_adjustment', v_today, 'not_required', v_reason, v_comment, v_actor);

    INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)
    VALUES (fin_private_child_uuid(v_adj_op, 'posting'), v_adj_op, v_account.id,
            CASE WHEN v_diff > 0 THEN 'in'::fin_direction ELSE 'out'::fin_direction END,
            abs(v_diff), v_account.currency_code, round(abs(v_diff) * v_rate, 2), v_rate);

    SELECT MAX(ledger_seq) INTO v_cutoff FROM fin_postings WHERE account_id = v_account.id;
  END IF;

  INSERT INTO fin_reconciliations (
    id, request_hash, account_id, performed_by,
    system_balance, counted_balance, original_difference, difference,
    cutoff_ledger_seq, adjustment_operation_id, counts, comment, is_checkpoint
  ) VALUES (
    v_request_id, v_hash, v_account.id, v_actor,
    fin_private_account_balance(v_account.id, v_cutoff), v_counted,
    CASE WHEN v_diff <> 0 THEN v_diff ELSE NULL END, 0,
    v_cutoff, v_adj_op, v_norm, v_comment, true
  );

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'reconciliation_id', v_request_id,
    'cutoff_ledger_seq', v_cutoff,
    'system_balance', fin_private_account_balance(v_account.id, v_cutoff),
    'counted_balance', v_counted,
    'original_difference', CASE WHEN v_diff <> 0 THEN v_diff ELSE NULL END,
    'difference', 0,
    'adjustment_operation_id', v_adj_op
  ), 'warnings', '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- -------------------------------------------------------------
-- Передача ответственности за счёт (ТЗ UC-2 п.5, сценарий 96):
-- проверяются И последний чекпоинт, И текущий MAX(ledger_seq).
-- State-idempotent.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_transfer_account_responsibility(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_account fin_accounts%ROWTYPE;
  v_expected bigint;
  v_new uuid;
  v_reason text;
  v_checkpoint bigint;
  v_current bigint;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Передачу ответственности выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['account_id', 'expected_seq', 'new_responsible_person_id', 'reason']);
  v_new := fin_private_get_uuid(payload, 'new_responsible_person_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина передачи ответственности обязательна';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_new) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Новый ответственный не найден в справочнике людей';
  END IF;
  BEGIN
    v_expected := COALESCE(payload->>'expected_seq', '')::bigint;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'expected_seq: ожидается номер проводки последнего чекпоинта';
  END;

  SELECT * INTO v_account FROM fin_accounts
  WHERE id = fin_private_get_uuid(payload, 'account_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден';
  END IF;

  SELECT cutoff_ledger_seq INTO v_checkpoint
  FROM fin_reconciliations WHERE account_id = v_account.id
  ORDER BY performed_at DESC, cutoff_ledger_seq DESC LIMIT 1;
  SELECT COALESCE(MAX(ledger_seq), 0) INTO v_current FROM fin_postings WHERE account_id = v_account.id;

  -- state-идемпотентность: уже передано этому человеку при том же seq
  IF v_account.responsible_person_id = v_new AND v_current = v_expected THEN
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
      'account_id', v_account.id, 'responsible_person_id', v_new, 'noop', true), 'warnings', '[]'::jsonb);
  END IF;

  IF v_checkpoint IS NULL OR v_checkpoint <> v_expected OR v_current <> v_expected THEN
    RAISE EXCEPTION 'account_changed_since_reconciliation'
      USING DETAIL = format('Передача возможна только по свежей сверке: чекпоинт №%s, текущая проводка №%s, ожидалось №%s — сверьте счёт заново',
                            COALESCE(v_checkpoint::text, '—'), v_current, v_expected);
  END IF;

  -- причина — в аудит-лог через транзакционный контекст (ТЗ 4.10)
  PERFORM set_config('app.change_reason', v_reason, true);
  PERFORM set_config('app.request_id', v_account.id::text, true);

  UPDATE fin_accounts SET responsible_person_id = v_new WHERE id = v_account.id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'account_id', v_account.id,
    'old_responsible_person_id', v_account.responsible_person_id,
    'responsible_person_id', v_new,
    'checkpoint_seq', v_checkpoint
  ), 'warnings', '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- -------------------------------------------------------------
-- fin_update_account: смена ответственного у счёта с проводками —
-- только через fin_transfer_account_responsibility
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_update_account(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account fin_accounts%ROWTYPE;
  v_name text;
  v_new_resp uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['account_id','name','group_name','responsible_person_id','default_cost_center_id','is_active']);

  SELECT * INTO v_account FROM fin_accounts
  WHERE id = fin_private_get_uuid(payload, 'account_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден';
  END IF;

  IF payload ? 'responsible_person_id' THEN
    v_new_resp := fin_private_get_uuid(payload, 'responsible_person_id');
    IF v_new_resp IS DISTINCT FROM v_account.responsible_person_id
       AND EXISTS (SELECT 1 FROM fin_postings WHERE account_id = v_account.id) THEN
      RAISE EXCEPTION 'use_responsibility_transfer'
        USING DETAIL = 'По счёту уже есть операции — смена ответственного только через передачу ответственности (со свежей сверкой)';
    END IF;
  END IF;

  IF (payload->>'is_active')::boolean IS FALSE AND v_account.is_active THEN
    IF fin_private_account_balance(v_account.id) <> 0 THEN
      RAISE EXCEPTION 'account_balance_not_zero'
        USING DETAIL = 'Деактивация возможна только при нулевом остатке — переведите остаток';
    END IF;
  END IF;

  v_name := NULLIF(trim(COALESCE(payload->>'name', '')), '');
  IF v_name IS NOT NULL AND v_name <> v_account.name
     AND EXISTS (SELECT 1 FROM fin_accounts WHERE name = v_name AND is_active AND id <> v_account.id) THEN
    RAISE EXCEPTION 'account_name_taken' USING DETAIL = 'Активный счёт с таким именем уже существует';
  END IF;

  UPDATE fin_accounts SET
    name = COALESCE(v_name, name),
    group_name = CASE WHEN payload ? 'group_name' THEN NULLIF(trim(COALESCE(payload->>'group_name', '')), '') ELSE group_name END,
    responsible_person_id = CASE WHEN payload ? 'responsible_person_id' THEN fin_private_get_uuid(payload, 'responsible_person_id') ELSE responsible_person_id END,
    default_cost_center_id = CASE WHEN payload ? 'default_cost_center_id' THEN fin_private_get_uuid(payload, 'default_cost_center_id') ELSE default_cost_center_id END,
    is_active = COALESCE((payload->>'is_active')::boolean, is_active)
  WHERE id = v_account.id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('account_id', v_account.id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- -------------------------------------------------------------
-- Чекпоинт-поля в view остатков (Guide 7.2)
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_account_balances AS
SELECT
  a.id AS account_id,
  a.name,
  a.kind,
  a.reconciliation_mode,
  a.currency_code,
  a.group_name,
  a.responsible_person_id,
  a.default_cost_center_id,
  a.is_active,
  COALESCE(s.balance, 0)::numeric(14,2) AS balance,
  s.last_ledger_seq,
  (COALESCE(s.balance, 0) < 0) AS is_negative,
  r.cutoff_ledger_seq AS last_checkpoint_seq,
  r.performed_at AS last_checkpoint_at,
  (SELECT count(*) FROM fin_postings p
    WHERE p.account_id = a.id AND p.ledger_seq > COALESCE(r.cutoff_ledger_seq, 0)) AS unreconciled_count
FROM fin_accounts a
LEFT JOIN (
  SELECT account_id,
         SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) AS balance,
         MAX(ledger_seq) AS last_ledger_seq
  FROM fin_postings
  GROUP BY account_id
) s ON s.account_id = a.id
LEFT JOIN LATERAL (
  SELECT cutoff_ledger_seq, performed_at
  FROM fin_reconciliations rr
  WHERE rr.account_id = a.id
  ORDER BY rr.performed_at DESC, rr.cutoff_ledger_seq DESC
  LIMIT 1
) r ON true
WHERE fin_can_read_all()
   OR EXISTS (
        SELECT 1 FROM fin_account_access aa
        WHERE aa.account_id = a.id AND aa.user_id = auth.uid()
      );

-- -------------------------------------------------------------
-- История сверок
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_reconciliations AS
SELECT
  r.id,
  r.account_id,
  a.name AS account_name,
  r.performed_at,
  r.performed_by,
  fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = r.performed_by LIMIT 1)) AS performed_by_name,
  r.system_balance,
  r.counted_balance,
  r.original_difference,
  r.difference,
  r.cutoff_ledger_seq,
  r.adjustment_operation_id,
  r.counts,
  r.comment,
  r.is_checkpoint
FROM fin_reconciliations r
JOIN fin_accounts a ON a.id = r.account_id
WHERE fin_can_read_all();

GRANT SELECT ON fin_v_reconciliations TO authenticated;

-- -------------------------------------------------------------
-- Права
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION fin_private_normalize_counts(jsonb, text)        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_perform_reconciliation(jsonb)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_transfer_account_responsibility(jsonb)       FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_perform_reconciliation(jsonb)             TO authenticated;
GRANT EXECUTE ON FUNCTION fin_transfer_account_responsibility(jsonb)    TO authenticated;
