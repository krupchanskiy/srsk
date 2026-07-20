-- =============================================================
-- Финансовый модуль, Этап 3а: начисления и платежи участников
-- fin_create_charge (батч, command-idempotent на уровне строки),
-- fin_cancel_charge (state-idempotent), fin_create_payment
-- (мультивалютный/групповой). ТЗ 4.4, UC-4..UC-6, матрица 10.13.
-- =============================================================

-- Системные статьи (RPC находит по code; создание — идемпотентно)
INSERT INTO fin_categories (code, name, direction) VALUES
  ('participant_payment', 'Оплата от участника', 'in'),
  ('participant_refund',  'Возврат участнику',  'out')
ON CONFLICT (code) DO NOTHING;

-- Блокировка учётного объекта ретрита (если объект существует).
-- Возвращает object_id (nullable) и признак закрытости.
CREATE OR REPLACE FUNCTION fin_private_lock_retreat_object(
  p_retreat_id uuid,
  OUT object_id uuid,
  OUT is_closed boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  SELECT id INTO object_id FROM fin_accounting_objects
  WHERE retreat_id = p_retreat_id
  FOR UPDATE;
  is_closed := object_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM fin_object_closures c WHERE c.object_id = fin_private_lock_retreat_object.object_id AND c.is_initial
  );
END;
$$;

-- -------------------------------------------------------------
-- fin_create_charge — пачка начислений одной транзакцией.
-- Сервер вычисляет amount = ROUND(quantity × unit_price, 2).
-- Повтор пачки возвращает те же строки (id+hash каждой строки).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_charge(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_rows jsonb;
  r jsonb;
  v_id uuid;
  v_participant uuid;
  v_retreat uuid;
  v_kind fin_charge_kind;
  v_qty numeric;
  v_price numeric;
  v_amount numeric;
  v_discount numeric;
  v_hash text;
  v_existing fin_charges%ROWTYPE;
  v_lock record;
  v_creation_reason text;
  v_results jsonb := '[]'::jsonb;
  v_retreats uuid[] := '{}';
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Начисления создаёт только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['rows']);
  v_rows := payload->'rows';
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив начислений';
  END IF;

  -- блокировка объектов затронутых ретритов (отсортированно, до записи)
  SELECT array_agg(DISTINCT (x->>'retreat_id')::uuid) INTO v_retreats
  FROM jsonb_array_elements(v_rows) x;
  PERFORM 1 FROM fin_accounting_objects WHERE retreat_id = ANY (v_retreats) ORDER BY id FOR UPDATE;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY[
      'id', 'participant_id', 'retreat_id', 'kind', 'description',
      'quantity', 'unit_price', 'discount_amount', 'discount_reason', 'creation_reason'
    ]);
    v_id := fin_private_get_uuid(r, 'id', true);
    v_participant := fin_private_get_uuid(r, 'participant_id', true);
    v_retreat := fin_private_get_uuid(r, 'retreat_id', true);

    BEGIN
      v_kind := (r->>'kind')::fin_charge_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'kind: org_fee | accommodation | meals | extra';
    END;

    BEGIN
      v_qty := (r->>'quantity')::numeric;
      v_price := round((r->>'unit_price')::numeric, 2);
      v_discount := round(COALESCE(NULLIF(r->>'discount_amount', ''), '0')::numeric, 2);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректные quantity/unit_price/discount_amount';
    END;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'quantity должно быть > 0';
    END IF;
    IF v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'unit_price должно быть >= 0';
    END IF;

    -- сервер вычисляет сумму — клиентскому amount не доверяем (ТЗ 4.4)
    v_amount := round(v_qty * v_price, 2);
    IF v_discount < 0 OR v_discount > v_amount THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Скидка должна быть в пределах 0..amount';
    END IF;
    IF v_discount > 0 AND NULLIF(trim(COALESCE(r->>'discount_reason', '')), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Скидка требует причины';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_participant) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM retreats WHERE id = v_retreat) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ретрит не найден';
    END IF;

    v_hash := fin_private_hash(jsonb_build_object(
      'command', 'create_charge',
      'participant_id', lower(v_participant::text),
      'retreat_id', lower(v_retreat::text),
      'kind', v_kind,
      'description', trim(COALESCE(r->>'description', '')),
      'quantity', v_qty::text,
      'unit_price', fin_private_norm_money(v_price),
      'discount_amount', fin_private_norm_money(v_discount),
      'discount_reason', NULLIF(trim(COALESCE(r->>'discount_reason', '')), '')
    ));

    -- идемпотентность строки
    SELECT * INTO v_existing FROM fin_charges WHERE id = v_id;
    IF FOUND THEN
      IF v_existing.request_hash <> v_hash THEN
        RAISE EXCEPTION 'idempotency_conflict'
          USING DETAIL = 'Тот же id начисления уже использован с другим содержимым';
      END IF;
      v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id, 'existed', true));
      CONTINUE;
    END IF;

    -- post-close: только админ (мы и так админ) + причина + dirty
    SELECT * INTO v_lock FROM fin_private_lock_retreat_object(v_retreat);
    v_creation_reason := NULLIF(trim(COALESCE(r->>'creation_reason', '')), '');
    IF v_lock.is_closed THEN
      IF v_creation_reason IS NULL THEN
        RAISE EXCEPTION 'post_close_reason_required'
          USING DETAIL = 'Начисление по закрытому ретриту требует причины';
      END IF;
      UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_lock.object_id;
    END IF;

    INSERT INTO fin_charges (
      id, request_hash, participant_id, retreat_id, kind, description,
      quantity, unit_price, amount, discount_amount, discount_reason,
      creation_reason, created_by
    ) VALUES (
      v_id, v_hash, v_participant, v_retreat, v_kind,
      NULLIF(trim(COALESCE(r->>'description', '')), ''),
      v_qty, v_price, v_amount, v_discount,
      NULLIF(trim(COALESCE(r->>'discount_reason', '')), ''),
      v_creation_reason, v_actor
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id, 'amount', v_amount, 'net_amount', v_amount - v_discount));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('rows', v_results), 'warnings', '[]'::jsonb);
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
-- fin_cancel_charge — отмена флагом (state-idempotent)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_cancel_charge(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_charge fin_charges%ROWTYPE;
  v_reason text;
  v_lock record;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Отмена начислений доступна только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['charge_id', 'reason']);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина отмены обязательна';
  END IF;

  SELECT * INTO v_charge FROM fin_charges
  WHERE id = fin_private_get_uuid(payload, 'charge_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Начисление не найдено';
  END IF;

  -- state-идемпотентность
  IF v_charge.is_cancelled THEN
    IF v_charge.cancelled_reason = v_reason THEN
      RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('charge_id', v_charge.id, 'noop', true), 'warnings', '[]'::jsonb);
    END IF;
    RAISE EXCEPTION 'charge_already_cancelled_conflict'
      USING DETAIL = format('Начисление уже отменено с другой причиной: «%s»', v_charge.cancelled_reason);
  END IF;

  SELECT * INTO v_lock FROM fin_private_lock_retreat_object(v_charge.retreat_id);
  PERFORM set_config('app.change_reason', v_reason, true);

  UPDATE fin_charges SET
    is_cancelled = true,
    cancelled_reason = v_reason,
    cancelled_at = now(),
    cancelled_by = v_actor
  WHERE id = v_charge.id;

  IF v_lock.is_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_lock.object_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('charge_id', v_charge.id), 'warnings', '[]'::jsonb);
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
-- fin_create_payment — платёж участника(ов): мультивалютный
-- (строки на разных счетах) и групповой (по строке на участника).
-- Статья задаётся сервером (participant_payment). Command-idempotent.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_payment(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_on date;
  v_comment text;
  v_reason text;
  v_payer uuid;
  v_rows jsonb;
  v_canonical_rows jsonb := '[]'::jsonb;
  v_hash text;
  v_existing jsonb;
  r jsonb;
  v_category uuid;
  v_accounts uuid[];
  v_objects uuid[];
  v_closed_objects uuid[];
  v_acc fin_accounts%ROWTYPE;
  v_obj uuid;
  v_kind fin_participant_balance_kind;
  v_rate numeric;
  v_bases numeric[];
  v_rates numeric[];
  i int;
  n int;
  v_group_key text;
  v_group_total numeric;
  v_group_assigned numeric;
  v_group_last int;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Платёж участника проводит только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'occurred_on', 'payer_contact_id', 'comment', 'reason', 'rows']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_on := fin_private_get_date(payload, 'occurred_on', true);
  v_comment := NULLIF(trim(COALESCE(payload->>'comment', '')), '');
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  v_payer := fin_private_get_uuid(payload, 'payer_contact_id', true);
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_payer) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Плательщик не найден';
  END IF;

  SELECT id INTO v_category FROM fin_categories WHERE code = 'participant_payment';

  v_rows := payload->'rows';
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив строк платежа';
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'participant_balance_kind', 'payment_channel']);
    BEGIN
      v_kind := (r->>'participant_balance_kind')::fin_participant_balance_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'participant_balance_kind: org_fee | accommodation | meals | extra | general';
    END;
    IF v_kind = 'none' THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'Пожертвование оформляется отдельной операцией, не строкой платежа';
    END IF;
    IF NULLIF(r->>'payment_channel', '') IS NOT NULL THEN
      BEGIN
        PERFORM (r->>'payment_channel')::fin_payment_channel;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный payment_channel';
      END;
    END IF;
    v_canonical_rows := v_canonical_rows || jsonb_build_array(jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'participant_balance_kind', v_kind,
      'payment_channel', NULLIF(r->>'payment_channel', '')
    ));
  END LOOP;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_payment',
    'occurred_on', v_on,
    'payer_contact_id', lower(v_payer::text),
    'comment', v_comment,
    'reason', v_reason,
    'rows', v_canonical_rows
  ));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  SELECT array_agg(DISTINCT (x->>'object_id')::uuid),
         array_agg(DISTINCT (x->>'account_id')::uuid)
    INTO v_objects, v_accounts
  FROM jsonb_array_elements(v_canonical_rows) AS x;

  -- шаг 1: объекты
  PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_objects) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM fin_accounting_objects WHERE id = ANY (v_objects)) <> array_length(v_objects, 1) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;
  SELECT array_agg(DISTINCT c.object_id) INTO v_closed_objects
  FROM fin_object_closures c WHERE c.object_id = ANY (v_objects) AND c.is_initial;
  IF v_closed_objects IS NOT NULL AND v_reason IS NULL THEN
    RAISE EXCEPTION 'post_close_reason_required'
      USING DETAIL = 'Платёж по закрытому ретриту требует причины';
  END IF;

  -- шаг 3: счета
  PERFORM 1 FROM fin_accounts WHERE id = ANY (v_accounts) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM fin_accounts WHERE id = ANY (v_accounts) AND is_active) <> array_length(v_accounts, 1) THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден или деактивирован';
  END IF;

  -- участники существуют
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_canonical_rows) x
    LEFT JOIN vaishnavas v ON v.id = (x->>'participant_id')::uuid
    WHERE v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
  END IF;

  -- курсы и base (группа = валюта+курс, последняя строка добирает остаток)
  n := jsonb_array_length(v_canonical_rows);
  v_bases := array_fill(NULL::numeric, ARRAY[n]);
  v_rates := array_fill(NULL::numeric, ARRAY[n]);
  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_rate := fin_private_get_rate(v_acc.currency_code, (r->>'object_id')::uuid, v_on);
    v_rates[i + 1] := v_rate;
    v_bases[i + 1] := round(((r->>'amount')::numeric) * v_rate, 2);
  END LOOP;

  FOR v_group_key, v_group_total, v_group_assigned, v_group_last IN
    SELECT g.key, round(SUM(g.amount * g.rate), 2), SUM(g.base_rounded), MAX(g.idx)
    FROM (
      SELECT (SELECT currency_code FROM fin_accounts a WHERE a.id = (o.x->>'account_id')::uuid) || ':' || v_rates[o.ord]::text AS key,
             (o.x->>'amount')::numeric AS amount,
             v_rates[o.ord] AS rate,
             v_bases[o.ord] AS base_rounded,
             o.ord AS idx
      FROM jsonb_array_elements(v_canonical_rows) WITH ORDINALITY AS o(x, ord)
    ) g
    GROUP BY g.key HAVING count(*) > 1
  LOOP
    IF v_group_total <> v_group_assigned THEN
      v_bases[v_group_last] := v_bases[v_group_last] + (v_group_total - v_group_assigned);
    END IF;
  END LOOP;

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, payer_contact_id, reason, comment, created_by)
  VALUES (v_request_id, v_hash, 'payment', v_on, 'not_required', v_payer, v_reason, v_comment, v_actor);

  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_obj := (r->>'object_id')::uuid;
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, object_id,
      is_post_close, participant_id, participant_balance_kind, payment_channel
    ) VALUES (
      (r->>'id')::uuid, v_request_id, v_acc.id, 'in',
      (r->>'amount')::numeric, v_acc.currency_code,
      v_bases[i + 1], v_rates[i + 1], v_category, v_obj,
      (v_closed_objects IS NOT NULL AND v_obj = ANY (v_closed_objects)),
      (r->>'participant_id')::uuid,
      (r->>'participant_balance_kind')::fin_participant_balance_kind,
      CASE WHEN r->>'payment_channel' IS NULL THEN NULL ELSE (r->>'payment_channel')::fin_payment_channel END
    );
  END LOOP;

  IF v_closed_objects IS NOT NULL THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = ANY (v_closed_objects);
  END IF;

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

REVOKE ALL ON FUNCTION fin_private_lock_retreat_object(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_create_charge(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_cancel_charge(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_payment(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_charge(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION fin_cancel_charge(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_payment(jsonb) TO authenticated;
