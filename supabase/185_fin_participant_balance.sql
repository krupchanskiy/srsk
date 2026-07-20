-- =============================================================
-- Финансовый модуль, Этап 3а: баланс участника, opening-позиции,
-- портальная RPC. Формула строго в рамках (participant_id, retreat_id),
-- general-кредит по порядку org_fee → accommodation → meals → extra →
-- general_debt (ТЗ раздел 7). Подробная и быстрая формулы обязаны
-- совпадать — обе возвращаются для integrity-теста.
-- =============================================================

-- -------------------------------------------------------------
-- Внутренний расчёт баланса
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_participant_balance(p_participant uuid, p_retreat uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_blocks text[] := ARRAY['org_fee', 'accommodation', 'meals', 'extra'];
  k text;
  v_charges numeric[] := ARRAY[0, 0, 0, 0];
  v_open_debt numeric[] := ARRAY[0, 0, 0, 0];
  v_open_credit numeric[] := ARRAY[0, 0, 0, 0];
  v_signed numeric[] := ARRAY[0, 0, 0, 0];
  v_block_debt numeric[] := ARRAY[0, 0, 0, 0];
  v_general_debt numeric := 0;
  v_general_credit numeric := 0;
  v_general_signed numeric := 0;
  v_remaining numeric;
  v_apply numeric;
  v_total_debt numeric := 0;
  v_total_advance numeric := 0;
  v_quick numeric;
  v_sum_charges numeric := 0;
  v_sum_open_debt numeric := 0;
  v_sum_open_credit numeric := 0;
  v_sum_signed numeric := 0;
  i int;
  rec record;
  v_result jsonb := '{}'::jsonb;
BEGIN
  -- начисления по блокам
  FOR rec IN
    SELECT kind::text AS k, SUM(amount - discount_amount) AS s
    FROM fin_charges
    WHERE participant_id = p_participant AND retreat_id = p_retreat AND NOT is_cancelled
    GROUP BY kind
  LOOP
    i := array_position(v_blocks, rec.k);
    IF i IS NOT NULL THEN v_charges[i] := rec.s; END IF;
    v_sum_charges := v_sum_charges + rec.s;
  END LOOP;

  -- opening-позиции
  FOR rec IN
    SELECT balance_kind::text AS bk, kind::text AS k, SUM(amount) AS s
    FROM fin_participant_opening_balances
    WHERE participant_id = p_participant AND retreat_id = p_retreat
    GROUP BY balance_kind, kind
  LOOP
    IF rec.bk = 'general' THEN
      IF rec.k = 'debt' THEN v_general_debt := v_general_debt + rec.s;
      ELSE v_general_credit := v_general_credit + rec.s; END IF;
    ELSE
      i := array_position(v_blocks, rec.bk);
      IF i IS NOT NULL THEN
        IF rec.k = 'debt' THEN v_open_debt[i] := v_open_debt[i] + rec.s;
        ELSE v_open_credit[i] := v_open_credit[i] + rec.s; END IF;
      END IF;
    END IF;
    IF rec.k = 'debt' THEN v_sum_open_debt := v_sum_open_debt + rec.s;
    ELSE v_sum_open_credit := v_sum_open_credit + rec.s; END IF;
  END LOOP;

  -- signed base-платежи по блокам (payment in +, refund/reversal(payment) out −,
  -- reversal(refund) in + — зеркала уже несут унаследованный balance_kind)
  FOR rec IN
    SELECT p.participant_balance_kind::text AS bk,
           SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS s
    FROM fin_postings p
    JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE p.participant_id = p_participant
      AND o.retreat_id = p_retreat
      AND p.participant_balance_kind IS NOT NULL
      AND p.participant_balance_kind <> 'none'
    GROUP BY p.participant_balance_kind
  LOOP
    IF rec.bk = 'general' THEN
      v_general_signed := rec.s;
    ELSE
      i := array_position(v_blocks, rec.bk);
      IF i IS NOT NULL THEN v_signed[i] := rec.s; END IF;
    END IF;
    v_sum_signed := v_sum_signed + rec.s;
  END LOOP;

  -- долги по блокам до general
  FOR i IN 1 .. 4 LOOP
    v_block_debt[i] := v_charges[i] + v_open_debt[i] - v_open_credit[i] - v_signed[i];
  END LOOP;

  -- general применяем по порядку, не создавая аванс там, где долга нет
  v_remaining := v_general_credit + v_general_signed;
  FOR i IN 1 .. 4 LOOP
    v_apply := LEAST(v_remaining, GREATEST(v_block_debt[i], 0));
    v_block_debt[i] := v_block_debt[i] - v_apply;
    v_remaining := v_remaining - v_apply;
  END LOOP;
  v_apply := LEAST(v_remaining, GREATEST(v_general_debt, 0));
  v_general_debt := v_general_debt - v_apply;
  v_remaining := v_remaining - v_apply;

  -- итоги: положительные остатки — долг, отрицательные блоки и остаток general — аванс
  FOR i IN 1 .. 4 LOOP
    v_total_debt := v_total_debt + GREATEST(v_block_debt[i], 0);
    v_total_advance := v_total_advance + GREATEST(-v_block_debt[i], 0);
  END LOOP;
  v_total_debt := v_total_debt + GREATEST(v_general_debt, 0);
  v_total_advance := v_total_advance + v_remaining;

  -- быстрая контрольная формула (обязана совпасть с подробной)
  v_quick := v_sum_charges + v_sum_open_debt - v_sum_open_credit - v_sum_signed;

  FOR i IN 1 .. 4 LOOP
    v_result := v_result || jsonb_build_object(v_blocks[i], jsonb_build_object(
      'charged', v_charges[i] + v_open_debt[i],
      'paid', v_signed[i] + v_open_credit[i],
      'balance', v_block_debt[i]
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'blocks', v_result,
    'general_debt', GREATEST(v_general_debt, 0),
    'general_advance', v_remaining,
    'total_debt', v_total_debt,
    'total_advance', v_total_advance,
    'net', v_total_debt - v_total_advance,
    'quick_net', v_quick
  );
END;
$$;

-- Публичная обёртка для бэк-офиса
CREATE OR REPLACE FUNCTION fin_get_participant_balance(p_participant uuid, p_retreat uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;
  RETURN fin_private_participant_balance(p_participant, p_retreat);
END;
$$;

-- -------------------------------------------------------------
-- Участники ретрита с финансовыми данными (для таблицы бэк-офиса)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_list_retreat_participants(p_retreat uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'participant_id', ids.pid,
      'name', fin_private_person_name(ids.pid),
      'balance', fin_private_participant_balance(ids.pid, p_retreat)
    ) ORDER BY fin_private_person_name(ids.pid)
  ), '[]'::jsonb) INTO v_result
  FROM (
    SELECT DISTINCT participant_id AS pid FROM fin_charges WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT participant_id FROM fin_participant_opening_balances WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT p.participant_id FROM fin_postings p
    JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE o.retreat_id = p_retreat AND p.participant_id IS NOT NULL
  ) ids;

  RETURN jsonb_build_object('ok', true, 'result', v_result);
END;
$$;

-- -------------------------------------------------------------
-- Платежи участника (для карточки и портала). Portal-safe набор
-- полей отдаёт портальная RPC; здесь — админ/наблюдатель.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_participant_payments(p_participant uuid, p_retreat uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'occurred_on') DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'posting_id', p.id,
      'operation_id', p.operation_id,
      'occurred_on', o.occurred_on,
      'type', o.type,
      'amount', p.amount,
      'currency_code', p.currency_code,
      'amount_base', p.amount_base,
      'payment_channel', p.payment_channel,
      'balance_kind', p.participant_balance_kind,
      'is_reversed', o.is_reversed,
      'status', CASE
        WHEN o.is_reversed THEN 'reversed'
        WHEN o.type = 'payment' AND n.net_amount >= p.amount THEN 'refunded_fully'
        WHEN o.type = 'payment' AND n.net_amount > 0 THEN 'refunded_partially'
        ELSE 'active'
      END,
      'available_to_refund', CASE WHEN o.type = 'payment' AND NOT o.is_reversed THEN p.amount - n.net_amount ELSE 0 END
    ) AS x
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounting_objects ao ON ao.id = p.object_id
    LEFT JOIN LATERAL fin_private_net_refunded(p.id) n ON o.type = 'payment'
    WHERE p.participant_id = p_participant
      AND ao.retreat_id = p_retreat
      AND p.participant_balance_kind IS NOT NULL
  ) t
$$;

CREATE OR REPLACE FUNCTION fin_get_participant_payments(p_participant uuid, p_retreat uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;
  RETURN fin_private_participant_payments(p_participant, p_retreat);
END;
$$;

-- -------------------------------------------------------------
-- Портальная RPC: участник видит ТОЛЬКО себя, viewer определяется
-- по auth.uid() → vaishnavas.user_id (клиент contact не передаёт).
-- Не возвращает: счета, авторов, комментарии администраторов.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION portal_fin_get_my_finances() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_viewer uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_viewer FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1;
  IF v_viewer IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'retreat_id', r.id,
      'retreat_name', COALESCE(r.name_ru, r.name_en),
      'start_date', r.start_date,
      'balance', fin_private_participant_balance(v_viewer, r.id),
      'charges', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'kind', c.kind, 'description', c.description,
          'amount', c.amount, 'discount_amount', c.discount_amount,
          'net_amount', c.amount - c.discount_amount,
          'is_cancelled', c.is_cancelled
        ) ORDER BY c.created_at), '[]'::jsonb)
        FROM fin_charges c
        WHERE c.participant_id = v_viewer AND c.retreat_id = r.id
      ),
      'payments', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'occurred_on', x->>'occurred_on',
          'type', x->>'type',
          'amount', x->'amount',
          'currency_code', x->>'currency_code',
          'amount_base', x->'amount_base',
          'payment_channel', x->>'payment_channel',
          'balance_kind', x->>'balance_kind',
          'status', x->>'status'
        )), '[]'::jsonb)
        FROM jsonb_array_elements(fin_private_participant_payments(v_viewer, r.id)) x
      )
    ) ORDER BY r.start_date DESC
  ), '[]'::jsonb) INTO v_result
  FROM retreats r
  WHERE EXISTS (SELECT 1 FROM fin_charges c WHERE c.retreat_id = r.id AND c.participant_id = v_viewer)
     OR EXISTS (SELECT 1 FROM fin_participant_opening_balances b WHERE b.retreat_id = r.id AND b.participant_id = v_viewer)
     OR EXISTS (SELECT 1 FROM fin_postings p JOIN fin_accounting_objects o ON o.id = p.object_id
                WHERE o.retreat_id = r.id AND p.participant_id = v_viewer AND p.participant_balance_kind IS NOT NULL);

  RETURN jsonb_build_object('ok', true, 'result', v_result);
END;
$$;

-- -------------------------------------------------------------
-- Cutover: пакетная загрузка opening-позиций (идемпотентная по
-- (batch, document, row) + payload hash; конфликт валит всю пачку)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_load_opening_balances(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_batch uuid;
  v_doc text;
  r jsonb;
  v_row_hash text;
  v_existing fin_participant_opening_balances%ROWTYPE;
  v_inserted int := 0;
  v_skipped int := 0;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Загрузка реестра доступна только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['cutover_batch_id', 'source_document', 'rows']);
  v_batch := fin_private_get_uuid(payload, 'cutover_batch_id', true);
  v_doc := NULLIF(trim(COALESCE(payload->>'source_document', '')), '');
  IF v_doc IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'source_document обязателен';
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(payload->'rows') AS x(val) ORDER BY x.val->>'source_row_id'
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['source_row_id', 'participant_id', 'retreat_id', 'amount', 'kind', 'balance_kind', 'comment']);
    v_row_hash := fin_private_hash(jsonb_build_object(
      'participant_id', lower(r->>'participant_id'),
      'retreat_id', lower(r->>'retreat_id'),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'kind', r->>'kind',
      'balance_kind', r->>'balance_kind',
      'comment', NULLIF(trim(COALESCE(r->>'comment', '')), '')
    ));

    SELECT * INTO v_existing FROM fin_participant_opening_balances
    WHERE cutover_batch_id = v_batch AND source_document = v_doc AND source_row_id = r->>'source_row_id';
    IF FOUND THEN
      IF v_existing.source_payload_hash = v_row_hash THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'cutover_row_conflict'
        USING DETAIL = format('Строка %s уже загружена с другими данными — пачка отклонена целиком', r->>'source_row_id');
    END IF;

    INSERT INTO fin_participant_opening_balances (
      participant_id, retreat_id, amount, kind, balance_kind,
      source_document, cutover_batch_id, source_row_id, source_payload_hash,
      comment, created_by
    ) VALUES (
      fin_private_get_uuid(r, 'participant_id', true),
      fin_private_get_uuid(r, 'retreat_id', true),
      fin_private_get_money(r, 'amount', true),
      (r->>'kind')::fin_opening_position_kind,
      (r->>'balance_kind')::fin_participant_balance_kind,
      v_doc, v_batch, r->>'source_row_id', v_row_hash,
      NULLIF(trim(COALESCE(r->>'comment', '')), ''), v_actor
    );
    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('inserted', v_inserted, 'skipped', v_skipped), 'warnings', '[]'::jsonb);
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
-- Коррекция opening-позиции (единственный способ исправления после X)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_opening_correction(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_orig fin_participant_opening_balances%ROWTYPE;
  v_amount numeric;
  v_kind fin_opening_position_kind;
  v_bk fin_participant_balance_kind;
  v_reason text;
  v_hash text;
  v_existing fin_participant_opening_balances%ROWTYPE;
  v_lock record;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Коррекция opening-позиции доступна только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'corrects_opening_balance_id', 'amount', 'kind', 'balance_kind', 'correction_reason'
  ]);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_amount := fin_private_get_money(payload, 'amount', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'correction_reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина коррекции обязательна';
  END IF;
  BEGIN
    v_kind := (payload->>'kind')::fin_opening_position_kind;
    v_bk := (payload->>'balance_kind')::fin_participant_balance_kind;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректные kind/balance_kind';
  END;
  IF v_bk = 'none' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'balance_kind не может быть none';
  END IF;

  SELECT * INTO v_orig FROM fin_participant_opening_balances
  WHERE id = fin_private_get_uuid(payload, 'corrects_opening_balance_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Исправляемая строка не найдена';
  END IF;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_opening_correction',
    'corrects_opening_balance_id', lower(v_orig.id::text),
    'amount', fin_private_norm_money(v_amount),
    'kind', v_kind,
    'balance_kind', v_bk,
    'correction_reason', v_reason
  ));

  SELECT * INTO v_existing FROM fin_participant_opening_balances WHERE id = v_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING DETAIL = 'Тот же request_id уже использован с другим содержимым коррекции';
    END IF;
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_existing.id), 'warnings', '[]'::jsonb);
  END IF;

  -- object lock + dirty закрытого ретрита (ТЗ 4.14)
  SELECT * INTO v_lock FROM fin_private_lock_retreat_object(v_orig.retreat_id);

  INSERT INTO fin_participant_opening_balances (
    id, participant_id, retreat_id, amount, kind, balance_kind,
    source_document, corrects_opening_balance_id, request_hash,
    correction_reason, created_by
  ) VALUES (
    v_request_id, v_orig.participant_id, v_orig.retreat_id, v_amount, v_kind, v_bk,
    'opening_correction', v_orig.id, v_hash, v_reason, v_actor
  );

  IF v_lock.is_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_lock.object_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_request_id), 'warnings', '[]'::jsonb);
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

-- Начисления участника (для карточки)
CREATE OR REPLACE VIEW fin_v_charges AS
SELECT c.id, c.participant_id, fin_private_person_name(c.participant_id) AS participant_name,
       c.retreat_id, c.kind, c.description, c.quantity, c.unit_price,
       c.amount, c.discount_amount, (c.amount - c.discount_amount) AS net_amount,
       c.discount_reason, c.is_cancelled, c.cancelled_reason, c.creation_reason, c.created_at
FROM fin_charges c
WHERE fin_can_read_all();

GRANT SELECT ON fin_v_charges TO authenticated;

REVOKE ALL ON FUNCTION fin_private_participant_balance(uuid, uuid)  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_private_participant_payments(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_get_participant_balance(uuid, uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_list_retreat_participants(uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_get_participant_payments(uuid, uuid)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION portal_fin_get_my_finances()              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_load_opening_balances(jsonb)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_opening_correction(jsonb)      FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_get_participant_balance(uuid, uuid)  TO authenticated;
GRANT EXECUTE ON FUNCTION fin_list_retreat_participants(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION fin_get_participant_payments(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION portal_fin_get_my_finances()             TO authenticated;
GRANT EXECUTE ON FUNCTION fin_load_opening_balances(jsonb)         TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_opening_correction(jsonb)     TO authenticated;
