-- =============================================================
-- Финансовый модуль, Этап 5: согласование и правка аналитики
-- fin_set_approval    — state-idempotent + optimistic locking (Guide 11.13)
-- fin_update_posting_analytics — правка аналитики с expected hash (Guide 11.14)
-- Инвариант 4: согласование не влияет на деньги; disputed требует причины.
-- =============================================================

-- Канонический hash аналитики проводки (для optimistic locking правок)
CREATE OR REPLACE FUNCTION fin_private_analytics_hash(
  p_category uuid, p_cost_center uuid, p_object uuid,
  p_participant uuid, p_balance_kind fin_participant_balance_kind, p_contractor uuid
) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT fin_private_hash(jsonb_build_object(
    'category_id',    CASE WHEN p_category    IS NULL THEN NULL ELSE lower(p_category::text)    END,
    'cost_center_id', CASE WHEN p_cost_center IS NULL THEN NULL ELSE lower(p_cost_center::text) END,
    'object_id',      CASE WHEN p_object      IS NULL THEN NULL ELSE lower(p_object::text)      END,
    'participant_id', CASE WHEN p_participant IS NULL THEN NULL ELSE lower(p_participant::text) END,
    'participant_balance_kind', p_balance_kind,
    'contractor_id',  CASE WHEN p_contractor  IS NULL THEN NULL ELSE lower(p_contractor::text)  END
  ));
$$;

-- -------------------------------------------------------------
-- fin_set_approval — переходы pending/approved/disputed.
-- После initial closure объекта approval до-закрытийных операций
-- заморожен (ТЗ 4.15/сценарий 70). Post-close операции создаются
-- not_required и в цикл не входят.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_set_approval(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_op_id uuid;
  v_expected fin_approval;
  v_target fin_approval;
  v_reason text;
  v_op fin_operations%ROWTYPE;
  v_objs_pre uuid[];
  v_objs_now uuid[];
  v_attempt int := 0;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Согласование выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'operation_id', 'expected_approval', 'target_approval', 'reason', 'audit_request_id'
  ]);
  v_op_id := fin_private_get_uuid(payload, 'operation_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  BEGIN
    v_expected := (payload->>'expected_approval')::fin_approval;
    v_target := (payload->>'target_approval')::fin_approval;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'expected/target approval: pending | approved | disputed';
  END;
  IF v_target = 'not_required' OR v_expected = 'not_required' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'not_required не участвует в цикле согласования';
  END IF;
  IF v_target = 'disputed' AND v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Оспаривание требует причины (сценарий 50)';
  END IF;

  -- «прочитать → заблокировать → перепроверить»: объекты операции, затем операция
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 3 THEN
      RAISE EXCEPTION 'internal_error' USING DETAIL = 'Не удалось стабилизировать объекты операции';
    END IF;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_pre
    FROM fin_postings WHERE operation_id = v_op_id;

    IF v_objs_pre IS NOT NULL THEN
      PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_objs_pre) ORDER BY id FOR UPDATE;
    END IF;

    SELECT * INTO v_op FROM fin_operations WHERE id = v_op_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция не найдена';
    END IF;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_now
    FROM fin_postings WHERE operation_id = v_op_id;
    EXIT WHEN v_objs_now IS NOT DISTINCT FROM v_objs_pre;
  END LOOP;

  IF v_op.approval = 'not_required' THEN
    RAISE EXCEPTION 'approval_not_applicable'
      USING DETAIL = 'К этой операции цикл согласования не применяется';
  END IF;

  -- state-идемпотентность
  IF v_op.approval = v_target THEN
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('operation_id', v_op.id, 'approval', v_op.approval, 'noop', true),
      'warnings', '[]'::jsonb);
  END IF;

  IF v_op.approval <> v_expected THEN
    RAISE EXCEPTION 'approval_state_conflict'
      USING DETAIL = format('Статус уже «%s» — обновите форму', v_op.approval);
  END IF;

  -- заморозка после initial closure любого связанного объекта (до-закрытийная операция)
  IF v_objs_now IS NOT NULL AND EXISTS (
    SELECT 1 FROM fin_object_closures c WHERE c.object_id = ANY (v_objs_now) AND c.is_initial
  ) THEN
    RAISE EXCEPTION 'approval_frozen_after_closure'
      USING DETAIL = 'После закрытия объекта approval до-закрытийных операций не меняется (сценарий 70)';
  END IF;

  PERFORM set_config('app.change_reason', COALESCE(v_reason, ''), true);
  IF payload->>'audit_request_id' IS NOT NULL THEN
    PERFORM set_config('app.request_id', payload->>'audit_request_id', true);
  END IF;

  UPDATE fin_operations SET
    approval = v_target,
    reason = CASE WHEN v_target = 'disputed' THEN v_reason
                  WHEN v_op.approval = 'disputed' THEN NULL   -- вышли из спора — причина в аудите
                  ELSE reason END
  WHERE id = v_op.id;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('operation_id', v_op.id, 'approval', v_target),
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
-- fin_update_posting_analytics — правка аналитики проводки.
-- Инвариант 2: деньги неизменны, аналитика правится под optimistic
-- hash; refund/reversal-связанные строки неизменны; перенос объекта
-- блокирует оба объекта и пересчитывает is_post_close.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_update_posting_analytics(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_posting_id uuid;
  v_expected text;
  v_tgt jsonb;
  v_reason text;
  v_p fin_postings%ROWTYPE;
  v_op fin_operations%ROWTYPE;
  v_obj_pre uuid;
  v_new_obj uuid;
  v_lock_ids uuid[];
  v_attempt int := 0;
  v_cur_hash text;
  v_new_cat uuid; v_new_cc uuid; v_new_part uuid; v_new_con uuid;
  v_new_bk fin_participant_balance_kind;
  v_cat fin_categories%ROWTYPE;
  v_old_closed boolean := false;
  v_new_closed boolean := false;
  v_new_post_close boolean;
  v_net record;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Правка аналитики доступна только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'posting_id', 'expected_analytics_hash', 'target', 'reason', 'audit_request_id'
  ]);
  v_posting_id := fin_private_get_uuid(payload, 'posting_id', true);
  v_expected := NULLIF(trim(COALESCE(payload->>'expected_analytics_hash', '')), '');
  IF v_expected IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'expected_analytics_hash обязателен';
  END IF;
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  v_tgt := payload->'target';
  IF v_tgt IS NULL OR jsonb_typeof(v_tgt) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'target: объект с полями аналитики';
  END IF;
  PERFORM fin_private_assert_keys(v_tgt, ARRAY[
    'category_id', 'cost_center_id', 'object_id', 'participant_id', 'participant_balance_kind', 'contractor_id'
  ]);
  v_new_cat  := fin_private_get_uuid(v_tgt, 'category_id');
  v_new_cc   := fin_private_get_uuid(v_tgt, 'cost_center_id');
  v_new_obj  := fin_private_get_uuid(v_tgt, 'object_id');
  v_new_part := fin_private_get_uuid(v_tgt, 'participant_id');
  v_new_con  := fin_private_get_uuid(v_tgt, 'contractor_id');
  IF NULLIF(v_tgt->>'participant_balance_kind', '') IS NULL THEN
    v_new_bk := NULL;
  ELSE
    BEGIN
      v_new_bk := (v_tgt->>'participant_balance_kind')::fin_participant_balance_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный participant_balance_kind';
    END;
  END IF;

  -- «прочитать → заблокировать → перепроверить»: старый и новый объекты по UUID, затем проводка
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 3 THEN
      RAISE EXCEPTION 'internal_error' USING DETAIL = 'Не удалось стабилизировать объект проводки';
    END IF;

    SELECT object_id INTO v_obj_pre FROM fin_postings WHERE id = v_posting_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Проводка не найдена';
    END IF;

    SELECT array_agg(DISTINCT x) INTO v_lock_ids
    FROM unnest(ARRAY[v_obj_pre, v_new_obj]) x WHERE x IS NOT NULL;
    IF v_lock_ids IS NOT NULL THEN
      PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_lock_ids) ORDER BY id FOR UPDATE;
      IF (SELECT count(*) FROM fin_accounting_objects WHERE id = ANY (v_lock_ids)) <> array_length(v_lock_ids, 1) THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
      END IF;
    END IF;

    SELECT * INTO v_p FROM fin_postings WHERE id = v_posting_id FOR UPDATE;
    EXIT WHEN v_p.object_id IS NOT DISTINCT FROM v_obj_pre;
  END LOOP;

  SELECT * INTO v_op FROM fin_operations WHERE id = v_p.operation_id FOR UPDATE;

  -- технические проводки аналитику не несут (и не приобретают)
  IF v_op.type IN ('transfer', 'opening', 'reconciliation_adjustment') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Технические проводки не несут аналитику';
  END IF;
  -- проводка возврата полностью неизменна
  IF v_op.type = 'refund' THEN
    RAISE EXCEPTION 'posting_immutable' USING DETAIL = 'Аналитика проводки возврата неизменна';
  END IF;
  -- активное сторно: исходная и зеркальная неизменны
  IF v_op.type = 'reversal' OR v_op.is_reversed THEN
    RAISE EXCEPTION 'posting_immutable' USING DETAIL = 'Сторнированная операция и её зеркало неизменны';
  END IF;

  -- optimistic locking
  v_cur_hash := fin_private_analytics_hash(v_p.category_id, v_p.cost_center_id, v_p.object_id,
                                           v_p.participant_id, v_p.participant_balance_kind, v_p.contractor_id);
  IF v_cur_hash <> v_expected THEN
    RAISE EXCEPTION 'analytics_conflict'
      USING DETAIL = 'Аналитика уже изменена параллельно — обновите форму';
  END IF;

  -- state-идемпотентность
  IF fin_private_analytics_hash(v_new_cat, v_new_cc, v_new_obj, v_new_part, v_new_bk, v_new_con) = v_cur_hash THEN
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('posting_id', v_p.id, 'analytics_hash', v_cur_hash, 'noop', true),
      'warnings', '[]'::jsonb);
  END IF;

  -- платёж с активным возвратом: участник/блок/объект заблокированы
  IF v_op.type = 'payment' THEN
    SELECT * INTO v_net FROM fin_private_net_refunded(v_p.id);
    IF v_net.net_amount > 0 AND (
         v_new_part IS DISTINCT FROM v_p.participant_id
      OR v_new_bk IS DISTINCT FROM v_p.participant_balance_kind
      OR v_new_obj IS DISTINCT FROM v_p.object_id
    ) THEN
      RAISE EXCEPTION 'analytics_locked_by_refund'
        USING DETAIL = 'По платежу есть активный возврат — участник, блок и объект неизменны';
    END IF;
  END IF;

  -- закрытия
  IF v_p.object_id IS NOT NULL THEN
    v_old_closed := EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_p.object_id AND c.is_initial);
  END IF;
  IF v_new_obj IS NOT NULL THEN
    v_new_closed := EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_new_obj AND c.is_initial);
  END IF;
  IF v_old_closed AND NOT v_p.is_post_close THEN
    RAISE EXCEPTION 'posting_frozen_after_closure'
      USING DETAIL = 'Объект закрыт — аналитика до-закрытийных проводок неизменна';
  END IF;
  v_new_post_close := v_new_obj IS NOT NULL AND v_new_closed;
  IF (v_old_closed OR v_new_closed) AND v_reason IS NULL THEN
    RAISE EXCEPTION 'post_close_reason_required'
      USING DETAIL = 'Правка, затрагивающая закрытый объект, требует причины';
  END IF;

  -- валидация целевой аналитики (триггер validate срабатывает только на INSERT)
  IF v_new_cat IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья обязательна';
  END IF;
  SELECT * INTO v_cat FROM fin_categories WHERE id = v_new_cat AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья не найдена или архивирована';
  END IF;
  IF v_cat.direction::text <> v_p.direction::text THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Статья направления %s недопустима для %s-проводки', v_cat.direction, v_p.direction);
  END IF;
  IF v_new_cc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_cost_centers WHERE id = v_new_cc AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Cost center не найден или архивирован';
  END IF;
  IF v_new_con IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fin_contractors WHERE id = v_new_con AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Контрагент не найден или архивирован';
  END IF;
  IF v_new_part IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_new_part) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
  END IF;
  IF (v_new_part IS NULL) <> (v_new_bk IS NULL) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'participant_id и participant_balance_kind задаются вместе';
  END IF;
  IF v_op.type IN ('expense', 'income', 'donation') AND v_new_part IS NOT NULL AND v_new_bk <> 'none' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Для expense/income/donation с участником допустим только balance_kind = none';
  END IF;
  IF v_op.type = 'payment' AND (v_new_part IS NULL OR v_new_bk = 'none') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Строка платежа требует участника и блока';
  END IF;

  PERFORM set_config('app.change_reason', COALESCE(v_reason, ''), true);
  IF payload->>'audit_request_id' IS NOT NULL THEN
    PERFORM set_config('app.request_id', payload->>'audit_request_id', true);
  END IF;

  UPDATE fin_postings SET
    category_id = v_new_cat,
    cost_center_id = v_new_cc,
    object_id = v_new_obj,
    participant_id = v_new_part,
    participant_balance_kind = v_new_bk,
    contractor_id = v_new_con,
    is_post_close = v_new_post_close
  WHERE id = v_p.id;

  -- затронутые закрытые объекты требуют перевыпуска отчёта
  IF v_old_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_p.object_id;
  END IF;
  IF v_new_closed AND v_new_obj IS DISTINCT FROM v_p.object_id THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_new_obj;
  END IF;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object(
      'posting_id', v_p.id,
      'analytics_hash', fin_private_analytics_hash(v_new_cat, v_new_cc, v_new_obj, v_new_part, v_new_bk, v_new_con),
      'is_post_close', v_new_post_close),
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

-- analytics_hash в ленте счёта (для optimistic-правки из UI)
CREATE OR REPLACE VIEW fin_v_account_ledger AS
SELECT
  p.id AS posting_id,
  p.ledger_seq,
  p.operation_id,
  o.type,
  o.approval,
  o.is_reversed,
  o.occurred_on,
  o.created_at,
  o.comment,
  o.reason,
  (o.created_at::date > o.occurred_on) AS is_late,
  p.account_id,
  a.name AS account_name,
  p.currency_code,
  p.direction,
  p.amount,
  CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END AS signed_amount,
  p.amount_base,
  p.rate_used,
  p.category_id,
  cat.name AS category_name,
  p.cost_center_id,
  cc.name AS cost_center_name,
  p.object_id,
  obj.display_name AS object_name,
  p.participant_id,
  fin_private_person_name(p.participant_id) AS participant_name,
  p.contractor_id,
  con.name AS contractor_name,
  p.payment_channel,
  p.is_post_close,
  SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END)
    OVER (PARTITION BY p.account_id ORDER BY p.ledger_seq) AS running_balance,
  fin_private_analytics_hash(p.category_id, p.cost_center_id, p.object_id,
                             p.participant_id, p.participant_balance_kind, p.contractor_id) AS analytics_hash,
  p.participant_balance_kind
FROM fin_postings p
JOIN fin_operations o ON o.id = p.operation_id
JOIN fin_accounts a ON a.id = p.account_id
LEFT JOIN fin_categories cat ON cat.id = p.category_id
LEFT JOIN fin_cost_centers cc ON cc.id = p.cost_center_id
LEFT JOIN fin_accounting_objects obj ON obj.id = p.object_id
LEFT JOIN fin_contractors con ON con.id = p.contractor_id
WHERE fin_can_read_all()
   OR EXISTS (SELECT 1 FROM fin_account_access aa
              WHERE aa.account_id = p.account_id AND aa.user_id = auth.uid());

REVOKE ALL ON FUNCTION fin_private_analytics_hash(uuid, uuid, uuid, uuid, fin_participant_balance_kind, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_private_analytics_hash(uuid, uuid, uuid, uuid, fin_participant_balance_kind, uuid) TO authenticated; -- используется во view
REVOKE ALL ON FUNCTION fin_set_approval(jsonb)              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_update_posting_analytics(jsonb)  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_set_approval(jsonb)             TO authenticated;
GRANT EXECUTE ON FUNCTION fin_update_posting_analytics(jsonb) TO authenticated;
