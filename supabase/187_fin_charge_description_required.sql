-- Финансовый модуль, фикс Этапа 3б: description начисления обязателен
-- (колонка NOT NULL по контракту DDL — RPC должен отдавать понятную
-- ошибку invalid_payload, а не голый not-null constraint)

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
  v_description text;
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

    v_description := NULLIF(trim(COALESCE(r->>'description', '')), '');
    IF v_description IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Описание начисления обязательно';
    END IF;

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
      v_description,
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
