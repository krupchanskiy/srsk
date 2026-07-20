-- =============================================================
-- Финансовый модуль, Этап 1а: RPC счетов и начальных остатков
-- fin_create_account, fin_ensure_accounting_object,
-- fin_create_opening, fin_replace_opening
-- Контракт ответа: {ok, result, warnings} | {ok:false, error:{code,message}}
-- =============================================================

-- Соглашение об ошибках: машинный code кладётся в SQLERRM (RAISE '%', code),
-- человекочитаемое сообщение — в DETAIL; EXCEPTION-блок каждой RPC
-- превращает это в {ok:false, error:{code, message}}.

-- -------------------------------------------------------------
-- fin_create_account — только администратор
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_account(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_id uuid;
  v_kind fin_account_kind;
  v_mode fin_reconciliation_mode;
  v_currency text;
  v_name text;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Создание счетов доступно только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'name', 'kind', 'reconciliation_mode', 'currency_code',
    'group_name', 'responsible_person_id', 'default_cost_center_id'
  ]);

  v_name := NULLIF(trim(payload->>'name'), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Поле name обязательно';
  END IF;

  BEGIN
    v_kind := (payload->>'kind')::fin_account_kind;
    v_mode := (payload->>'reconciliation_mode')::fin_reconciliation_mode;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный kind или reconciliation_mode';
  END;

  v_currency := payload->>'currency_code';
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = v_currency AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Неизвестная или неактивная валюта';
  END IF;

  IF EXISTS (SELECT 1 FROM fin_accounts WHERE name = v_name AND is_active) THEN
    RAISE EXCEPTION 'account_name_taken' USING DETAIL = 'Активный счёт с таким именем уже существует';
  END IF;

  IF payload->>'responsible_person_id' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = fin_private_get_uuid(payload, 'responsible_person_id')) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ответственный не найден в справочнике людей';
  END IF;

  IF payload->>'default_cost_center_id' IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM fin_cost_centers WHERE id = fin_private_get_uuid(payload, 'default_cost_center_id') AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Cost center не найден или архивирован';
  END IF;

  INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name,
                            responsible_person_id, default_cost_center_id, created_by)
  VALUES (v_name, v_kind, v_mode, v_currency, NULLIF(trim(payload->>'group_name'), ''),
          fin_private_get_uuid(payload, 'responsible_person_id'),
          fin_private_get_uuid(payload, 'default_cost_center_id'),
          v_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('account_id', v_id), 'warnings', '[]'::jsonb);
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
-- fin_ensure_accounting_object — объект учёта для ретрита
-- (создаёт при отсутствии, возвращает id)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_ensure_accounting_object(p_retreat_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_name text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;

  SELECT id INTO v_id FROM fin_accounting_objects WHERE retreat_id = p_retreat_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('object_id', v_id, 'created', false));
  END IF;

  SELECT COALESCE(name_ru, name_en, 'Ретрит ' || p_retreat_id::text) INTO v_name
  FROM retreats WHERE id = p_retreat_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ретрит не найден';
  END IF;

  INSERT INTO fin_accounting_objects (type, retreat_id, display_name)
  VALUES ('retreat', p_retreat_id, v_name)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('object_id', v_id, 'created', true));
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
-- fin_create_opening — начальный остаток счёта. Command-idempotent.
-- Всегда (включая cutover): нет активного opening, нет вообще
-- никаких проводок, нет чекпоинта (ТЗ UC-2, сценарий 99).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_opening(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_account fin_accounts%ROWTYPE;
  v_direction fin_direction;
  v_amount numeric;
  v_on date;
  v_comment text;
  v_canonical jsonb;
  v_hash text;
  v_existing jsonb;
  v_rate numeric;
  v_posting_id uuid;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Opening создаёт только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'account_id', 'direction', 'amount', 'occurred_on', 'comment'
  ]);

  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_amount     := fin_private_get_money(payload, 'amount', true);
  v_on         := fin_private_get_date(payload, 'occurred_on', true);
  v_comment    := NULLIF(trim(COALESCE(payload->>'comment', '')), '');

  BEGIN
    v_direction := (payload->>'direction')::fin_direction;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'direction должен быть in или out';
  END;

  -- канонизация и hash (сервером, клиент hash не передаёт)
  v_canonical := jsonb_build_object(
    'command', 'create_opening',
    'account_id', lower((payload->>'account_id')),
    'direction', v_direction,
    'amount', fin_private_norm_money(v_amount),
    'occurred_on', v_on,
    'comment', v_comment
  );
  v_hash := fin_private_hash(v_canonical);

  -- идемпотентность — первым шагом, раньше любых предусловий
  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  -- блокировка счёта
  SELECT * INTO v_account FROM fin_accounts
  WHERE id = fin_private_get_uuid(payload, 'account_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден';
  END IF;
  IF NOT v_account.is_active THEN
    RAISE EXCEPTION 'account_inactive' USING DETAIL = 'Счёт деактивирован';
  END IF;

  -- нет активного opening (проверка обязательна независимо от cutover-режима)
  IF EXISTS (
    SELECT 1 FROM fin_postings po
    JOIN fin_operations op ON op.id = po.operation_id
    WHERE po.account_id = v_account.id AND op.type = 'opening' AND NOT op.is_reversed
  ) THEN
    RAISE EXCEPTION 'opening_already_exists' USING DETAIL = 'На счёте уже есть активный opening';
  END IF;

  -- нет вообще никаких проводок и нет чекпоинта
  IF EXISTS (SELECT 1 FROM fin_postings WHERE account_id = v_account.id) THEN
    RAISE EXCEPTION 'account_has_activity' USING DETAIL = 'На счёте уже есть проводки — используйте сверку с корректировкой';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_reconciliations WHERE account_id = v_account.id) THEN
    RAISE EXCEPTION 'account_has_activity' USING DETAIL = 'По счёту уже есть сверка — используйте сверку с корректировкой';
  END IF;

  -- расходный opening: только документированный отрицательный старт
  IF v_direction = 'out' THEN
    IF v_account.kind = 'real' AND v_account.reconciliation_mode = 'cash_count' THEN
      RAISE EXCEPTION 'negative_cash_opening_forbidden'
        USING DETAIL = 'Отрицательный стартовый остаток запрещён для наличного реального счёта';
    END IF;
    IF v_comment IS NULL THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'Расходный opening требует комментария с документальным основанием';
    END IF;
  END IF;

  v_rate := fin_private_get_rate(v_account.currency_code, NULL, v_on);
  v_posting_id := fin_private_child_uuid(v_request_id, 'posting');

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, created_by, comment)
  VALUES (v_request_id, v_hash, 'opening', v_on, 'not_required', v_actor, v_comment);

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)
  VALUES (v_posting_id, v_request_id, v_account.id, v_direction, v_amount, v_account.currency_code,
          round(v_amount * v_rate, 2), v_rate);

  RETURN jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id),
    'warnings', '[]'::jsonb);
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
-- fin_replace_opening — исправление ошибочного opening ДО первого
-- чекпоинта и до обычной деятельности: полный reversal + новый opening
-- одной транзакцией. Command-idempotent (id нового opening = request_id,
-- id reversal детерминирован от него).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_replace_opening(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_orig fin_operations%ROWTYPE;
  v_orig_posting fin_postings%ROWTYPE;
  v_account fin_accounts%ROWTYPE;
  v_direction fin_direction;
  v_amount numeric;
  v_reason text;
  v_canonical jsonb;
  v_hash text;
  v_existing jsonb;
  v_rate numeric;
  v_reversal_id uuid;
  v_active_openings int;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Замена opening доступна только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'original_opening_operation_id', 'new_direction', 'new_amount', 'reason'
  ]);

  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_amount     := fin_private_get_money(payload, 'new_amount', true);
  v_reason     := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина замены opening обязательна';
  END IF;

  BEGIN
    v_direction := (payload->>'new_direction')::fin_direction;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'new_direction должен быть in или out';
  END;

  v_canonical := jsonb_build_object(
    'command', 'replace_opening',
    'original_opening_operation_id', lower(payload->>'original_opening_operation_id'),
    'new_direction', v_direction,
    'new_amount', fin_private_norm_money(v_amount),
    'reason', v_reason
  );
  v_hash := fin_private_hash(v_canonical);

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true,
      'result', v_existing || jsonb_build_object('reversal_operation_id', fin_private_child_uuid(v_request_id, 'reversal')),
      'warnings', '[]'::jsonb);
  END IF;

  SELECT * INTO v_orig FROM fin_operations
  WHERE id = fin_private_get_uuid(payload, 'original_opening_operation_id', true)
  FOR UPDATE;
  IF NOT FOUND OR v_orig.type <> 'opening' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Исходная операция не найдена или не является opening';
  END IF;
  IF v_orig.is_reversed THEN
    RAISE EXCEPTION 'operation_already_reversed' USING DETAIL = 'Исходный opening уже сторнирован';
  END IF;

  SELECT * INTO v_orig_posting FROM fin_postings WHERE operation_id = v_orig.id;

  SELECT * INTO v_account FROM fin_accounts WHERE id = v_orig_posting.account_id FOR UPDATE;

  -- нет чекпоинта
  IF EXISTS (SELECT 1 FROM fin_reconciliations WHERE account_id = v_account.id) THEN
    RAISE EXCEPTION 'opening_replacement_not_allowed'
      USING DETAIL = 'По счёту уже есть чекпоинт — исправление только через сверку с корректировкой';
  END IF;

  -- кроме opening/reversal(opening) на счёте ничего нет
  IF EXISTS (
    SELECT 1 FROM fin_postings po
    JOIN fin_operations op ON op.id = po.operation_id
    LEFT JOIN fin_operations orig ON orig.id = op.original_operation_id
    WHERE po.account_id = v_account.id
      AND NOT (op.type = 'opening' OR (op.type = 'reversal' AND orig.type = 'opening'))
  ) THEN
    RAISE EXCEPTION 'opening_replacement_not_allowed'
      USING DETAIL = 'На счёте уже есть обычные проводки — исправление только через сверку с корректировкой';
  END IF;

  -- правила нового opening (как в create_opening)
  IF v_direction = 'out' AND v_account.kind = 'real' AND v_account.reconciliation_mode = 'cash_count' THEN
    RAISE EXCEPTION 'negative_cash_opening_forbidden'
      USING DETAIL = 'Отрицательный стартовый остаток запрещён для наличного реального счёта';
  END IF;

  v_rate := fin_private_get_rate(v_account.currency_code, NULL, v_orig.occurred_on);
  v_reversal_id := fin_private_child_uuid(v_request_id, 'reversal');

  -- 1) полное сторно ошибочного opening (occurred_on исходной — ошибка ввода)
  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, original_operation_id, reason, created_by)
  VALUES (v_reversal_id, v_hash, 'reversal', v_orig.occurred_on, 'not_required', v_orig.id, v_reason, v_actor);

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)
  VALUES (fin_private_child_uuid(v_reversal_id, 'posting'), v_reversal_id, v_account.id,
          CASE v_orig_posting.direction WHEN 'in' THEN 'out'::fin_direction ELSE 'in'::fin_direction END,
          v_orig_posting.amount, v_orig_posting.currency_code, v_orig_posting.amount_base, v_orig_posting.rate_used);

  UPDATE fin_operations SET is_reversed = true WHERE id = v_orig.id;

  -- 2) новый opening
  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, created_by, comment)
  VALUES (v_request_id, v_hash, 'opening', v_orig.occurred_on, 'not_required', v_actor, v_reason);

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)
  VALUES (fin_private_child_uuid(v_request_id, 'posting'), v_request_id, v_account.id,
          v_direction, v_amount, v_account.currency_code, round(v_amount * v_rate, 2), v_rate);

  -- инвариант: активный opening ровно один
  SELECT count(*) INTO v_active_openings
  FROM fin_postings po
  JOIN fin_operations op ON op.id = po.operation_id
  WHERE po.account_id = v_account.id AND op.type = 'opening' AND NOT op.is_reversed;
  IF v_active_openings <> 1 THEN
    RAISE EXCEPTION 'internal_invariant_violation'
      USING DETAIL = format('После замены активных opening: %s (ожидался ровно 1)', v_active_openings);
  END IF;

  RETURN jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id)
      || jsonb_build_object('reversal_operation_id', v_reversal_id),
    'warnings', '[]'::jsonb);
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
-- Права
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION fin_create_account(jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_ensure_accounting_object(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_opening(jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_replace_opening(jsonb)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_account(jsonb)          TO authenticated;
GRANT EXECUTE ON FUNCTION fin_ensure_accounting_object(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_opening(jsonb)          TO authenticated;
GRANT EXECUTE ON FUNCTION fin_replace_opening(jsonb)         TO authenticated;
