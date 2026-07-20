-- =============================================================
-- Финансовый модуль, Этап 3а: возврат и сторно
-- fin_create_refund (инвариант 6: блокировка исходной проводки,
-- net_refunded с учётом сторнированных возвратов, base-пропорция,
-- последний возврат добирает точный остаток), fin_create_reversal
-- (полное зеркало, запрет при активном refund, протокол
-- «прочитать → заблокировать → перепроверить»). ТЗ UC-7, UC-11.
-- =============================================================

-- net_refunded и net_refunded_base исходной проводки (под её блокировкой):
-- Σ всех refund − Σ refund, которые сами сторнированы (ТЗ раздел 7)
CREATE OR REPLACE FUNCTION fin_private_net_refunded(
  p_posting_id uuid,
  OUT net_amount numeric,
  OUT net_base numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(p.amount), 0) - COALESCE(SUM(p.amount) FILTER (WHERE o.is_reversed), 0),
    COALESCE(SUM(p.amount_base), 0) - COALESCE(SUM(p.amount_base) FILTER (WHERE o.is_reversed), 0)
  FROM fin_postings p
  JOIN fin_operations o ON o.id = p.operation_id
  WHERE p.refund_of_posting_id = p_posting_id AND o.type = 'refund';
$$;

-- -------------------------------------------------------------
-- fin_create_refund
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_refund(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_amount numeric;
  v_on date;
  v_reason text;
  v_recipient uuid;
  v_source_account uuid;
  v_hash text;
  v_existing jsonb;
  v_orig fin_postings%ROWTYPE;
  v_orig_op fin_operations%ROWTYPE;
  v_obj_pre uuid;
  v_obj_now uuid;
  v_is_closed boolean := false;
  v_account fin_accounts%ROWTYPE;
  v_net record;
  v_available numeric;
  v_base numeric;
  v_balance numeric;
  v_warnings jsonb := '[]'::jsonb;
  v_category uuid;
  v_attempt int := 0;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Возврат проводит только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'refund_of_posting_id', 'source_account_id', 'amount',
    'occurred_on', 'refund_recipient_contact_id', 'reason'
  ]);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_amount := fin_private_get_money(payload, 'amount', true);
  v_on := fin_private_get_date(payload, 'occurred_on', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  v_recipient := fin_private_get_uuid(payload, 'refund_recipient_contact_id');
  v_source_account := fin_private_get_uuid(payload, 'source_account_id');

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_refund',
    'refund_of_posting_id', lower(payload->>'refund_of_posting_id'),
    'source_account_id', CASE WHEN v_source_account IS NULL THEN NULL ELSE lower(v_source_account::text) END,
    'amount', fin_private_norm_money(v_amount),
    'occurred_on', v_on,
    'refund_recipient_contact_id', CASE WHEN v_recipient IS NULL THEN NULL ELSE lower(v_recipient::text) END,
    'reason', v_reason
  ));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  -- протокол «прочитать → заблокировать → перепроверить» (инвариант 6)
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 3 THEN
      RAISE EXCEPTION 'internal_error' USING DETAIL = 'Не удалось стабилизировать объект исходной проводки';
    END IF;

    SELECT object_id INTO v_obj_pre FROM fin_postings
    WHERE id = fin_private_get_uuid(payload, 'refund_of_posting_id', true);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'refund_source_invalid' USING DETAIL = 'Исходная проводка не найдена';
    END IF;

    IF v_obj_pre IS NOT NULL THEN
      PERFORM 1 FROM fin_accounting_objects WHERE id = v_obj_pre FOR UPDATE;
    END IF;

    SELECT * INTO v_orig FROM fin_postings
    WHERE id = fin_private_get_uuid(payload, 'refund_of_posting_id', true)
    FOR UPDATE;

    v_obj_now := v_orig.object_id;
    EXIT WHEN v_obj_now IS NOT DISTINCT FROM v_obj_pre;
    -- объект переехал между чтением и блокировкой — повторяем с новым
  END LOOP;

  SELECT * INTO v_orig_op FROM fin_operations WHERE id = v_orig.operation_id FOR UPDATE;
  IF v_orig_op.type <> 'payment' THEN
    RAISE EXCEPTION 'refund_source_invalid' USING DETAIL = 'Возврат возможен только с платёжной проводки';
  END IF;
  IF v_orig_op.is_reversed THEN
    RAISE EXCEPTION 'refund_source_invalid' USING DETAIL = 'Исходный платёж сторнирован — возвращать нечего';
  END IF;

  IF v_obj_now IS NOT NULL THEN
    v_is_closed := EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_obj_now AND c.is_initial);
    IF v_is_closed AND v_reason IS NULL THEN
      RAISE EXCEPTION 'post_close_reason_required' USING DETAIL = 'Возврат по закрытому ретриту требует причины';
    END IF;
  END IF;

  -- лимит под блокировкой исходной проводки
  SELECT * INTO v_net FROM fin_private_net_refunded(v_orig.id);
  v_available := v_orig.amount - v_net.net_amount;
  IF v_amount > v_available THEN
    RAISE EXCEPTION 'refund_amount_exceeds_available'
      USING DETAIL = format('Доступно к возврату %s из %s (уже возвращено %s)', v_available, v_orig.amount, v_net.net_amount);
  END IF;

  -- счёт возврата: по умолчанию — счёт исходной проводки; другой — та же валюта и причина
  v_source_account := COALESCE(v_source_account, v_orig.account_id);
  SELECT * INTO v_account FROM fin_accounts WHERE id = v_source_account FOR UPDATE;
  IF NOT FOUND OR NOT v_account.is_active THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт возврата не найден или деактивирован';
  END IF;
  IF v_account.currency_code <> v_orig.currency_code THEN
    RAISE EXCEPTION 'account_currency_mismatch' USING DETAIL = 'Возврат возможен только в валюте исходного платежа';
  END IF;
  IF v_account.id <> v_orig.account_id AND v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Возврат с другого счёта требует причины';
  END IF;

  -- получатель: по умолчанию плательщик исходной операции; другой — причина
  IF v_recipient IS NULL THEN
    v_recipient := v_orig_op.payer_contact_id;
  ELSIF v_recipient IS DISTINCT FROM v_orig_op.payer_contact_id AND v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Получатель, отличный от плательщика, требует причины';
  END IF;

  -- политика минуса: реальный счёт не уходит в минус обычным возвратом
  v_balance := fin_private_account_balance(v_account.id);
  IF v_balance - v_amount < 0 THEN
    IF v_account.kind = 'real' THEN
      RAISE EXCEPTION 'insufficient_funds'
        USING DETAIL = format('Счёт «%s»: остаток %s, возврат %s', v_account.name, v_balance, v_amount);
    ELSE
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'custodial_negative_balance',
        'message', format('Счёт «%s» уйдёт в минус', v_account.name)));
    END IF;
  END IF;

  -- base: последний возврат добирает точный остаток (ТЗ 10.9)
  IF v_amount = v_available THEN
    v_base := v_orig.amount_base - v_net.net_base;
  ELSE
    v_base := round(v_orig.amount_base * (v_amount / v_orig.amount), 2);
  END IF;

  SELECT id INTO v_category FROM fin_categories WHERE code = 'participant_refund';

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, payer_contact_id,
                              refund_recipient_contact_id, reason, created_by)
  VALUES (v_request_id, v_hash, 'refund', v_on, 'not_required', v_orig_op.payer_contact_id,
          v_recipient, v_reason, v_actor);

  INSERT INTO fin_postings (
    id, operation_id, account_id, direction, amount, currency_code,
    amount_base, rate_used, category_id, object_id, is_post_close,
    participant_id, participant_balance_kind, refund_of_posting_id
  ) VALUES (
    fin_private_child_uuid(v_request_id, 'posting'), v_request_id, v_account.id, 'out',
    v_amount, v_orig.currency_code, v_base, v_orig.rate_used,
    v_category, v_obj_now, v_is_closed,
    v_orig.participant_id, v_orig.participant_balance_kind, v_orig.id
  );

  IF v_is_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_obj_now;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id)
      || jsonb_build_object('available_after', v_available - v_amount),
    'warnings', v_warnings);
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
-- fin_create_reversal — полное зеркало всех проводок операции
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_reversal(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_policy text;
  v_on date;
  v_reason text;
  v_hash text;
  v_existing jsonb;
  v_source fin_operations%ROWTYPE;
  v_objs_pre uuid[];
  v_objs_now uuid[];
  v_closed uuid[];
  v_accounts uuid[];
  v_net record;
  v_total_refunded numeric := 0;
  v_warnings jsonb := '[]'::jsonb;
  p fin_postings%ROWTYPE;
  v_attempt int := 0;
  v_acc fin_accounts%ROWTYPE;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Сторно проводит только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'original_operation_id', 'occurred_on_policy', 'occurred_on', 'reason']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина сторно обязательна';
  END IF;
  v_policy := COALESCE(NULLIF(payload->>'occurred_on_policy', ''), 'same_as_original');
  IF v_policy NOT IN ('same_as_original', 'actual_reverse_date') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'occurred_on_policy: same_as_original | actual_reverse_date';
  END IF;
  IF v_policy = 'actual_reverse_date' THEN
    v_on := fin_private_get_date(payload, 'occurred_on', true);
  END IF;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_reversal',
    'original_operation_id', lower(payload->>'original_operation_id'),
    'occurred_on_policy', v_policy,
    'occurred_on', v_on,
    'reason', v_reason
  ));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  -- «прочитать → заблокировать → перепроверить» для набора объектов
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 3 THEN
      RAISE EXCEPTION 'internal_error' USING DETAIL = 'Не удалось стабилизировать объекты исходной операции';
    END IF;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_pre
    FROM fin_postings WHERE operation_id = fin_private_get_uuid(payload, 'original_operation_id', true);

    IF v_objs_pre IS NOT NULL THEN
      PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_objs_pre) ORDER BY id FOR UPDATE;
    END IF;

    SELECT * INTO v_source FROM fin_operations
    WHERE id = fin_private_get_uuid(payload, 'original_operation_id', true)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Исходная операция не найдена';
    END IF;
    PERFORM 1 FROM fin_postings WHERE operation_id = v_source.id FOR UPDATE;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_now
    FROM fin_postings WHERE operation_id = v_source.id;
    EXIT WHEN v_objs_now IS NOT DISTINCT FROM v_objs_pre;
  END LOOP;

  IF v_source.type = 'reversal' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Сторно сторно запрещено — повторно введите исходную операцию';
  END IF;
  IF v_source.is_reversed THEN
    RAISE EXCEPTION 'operation_already_reversed' USING DETAIL = 'Операция уже сторнирована';
  END IF;

  -- платёж с активным возвратом сторнировать нельзя (инвариант 6)
  IF v_source.type = 'payment' THEN
    FOR p IN SELECT * FROM fin_postings WHERE operation_id = v_source.id
    LOOP
      SELECT * INTO v_net FROM fin_private_net_refunded(p.id);
      v_total_refunded := v_total_refunded + v_net.net_amount;
    END LOOP;
    IF v_total_refunded > 0 THEN
      RAISE EXCEPTION 'reversal_not_allowed_after_refund'
        USING DETAIL = format('По платежу уже возвращено %s — доступен только дополнительный возврат остатка', v_total_refunded);
    END IF;
  END IF;

  IF v_policy = 'same_as_original' THEN
    v_on := v_source.occurred_on;
  END IF;

  -- закрытые объекты -> post-close пометка и dirty
  SELECT array_agg(DISTINCT c.object_id) INTO v_closed
  FROM fin_object_closures c WHERE c.object_id = ANY (COALESCE(v_objs_now, '{}')) AND c.is_initial;

  -- счета (шаг 3)
  SELECT array_agg(DISTINCT account_id) INTO v_accounts FROM fin_postings WHERE operation_id = v_source.id;
  PERFORM 1 FROM fin_accounts WHERE id = ANY (v_accounts) ORDER BY id FOR UPDATE;

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, original_operation_id, reason, created_by)
  VALUES (v_request_id, v_hash, 'reversal', v_on, 'not_required', v_source.id, v_reason, v_actor);

  -- полное зеркало: направление меняется, деньги и аналитика наследуются
  FOR p IN SELECT * FROM fin_postings WHERE operation_id = v_source.id ORDER BY ledger_seq
  LOOP
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, cost_center_id, object_id,
      is_post_close, participant_id, participant_balance_kind,
      contractor_id, payment_channel
    ) VALUES (
      fin_private_child_uuid(v_request_id, p.id::text), v_request_id, p.account_id,
      CASE p.direction WHEN 'in' THEN 'out'::fin_direction ELSE 'in'::fin_direction END,
      p.amount, p.currency_code, p.amount_base, p.rate_used,
      p.category_id, p.cost_center_id, p.object_id,
      (p.object_id IS NOT NULL AND v_closed IS NOT NULL AND p.object_id = ANY (v_closed)),
      p.participant_id, p.participant_balance_kind,
      p.contractor_id, p.payment_channel
    );
  END LOOP;

  UPDATE fin_operations SET is_reversed = true WHERE id = v_source.id;

  IF v_closed IS NOT NULL THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = ANY (v_closed);
  END IF;

  -- реальный счёт может уйти в минус (chargeback) — предупреждение, не запрет
  FOR v_acc IN SELECT * FROM fin_accounts WHERE id = ANY (v_accounts)
  LOOP
    IF v_acc.kind = 'real' AND fin_private_account_balance(v_acc.id) < 0 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'real_negative_balance',
        'message', format('Реальный счёт «%s» ушёл в минус — требуется внеплановая сверка', v_acc.name)));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id),
    'warnings', v_warnings);
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

REVOKE ALL ON FUNCTION fin_private_net_refunded(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_create_refund(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_reversal(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_refund(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_reversal(jsonb) TO authenticated;
