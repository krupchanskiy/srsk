-- =============================================================
-- Финансовый модуль, Этап 6: закрытия и отчёты
-- fin_private_build_snapshot — пересчёт totals_snapshot (schema v1)
-- fin_create_closure   — initial closure под блокировкой (UC-12)
-- fin_reissue_closure  — версия N+1 при report_dirty_at (ТЗ 4.15)
-- fin_finalize_closure — связывание готового PDF (state-idempotent)
-- fin_get_retreat_report / fin_get_summary_report — экраны 9.6/9.7
-- =============================================================

-- -------------------------------------------------------------
-- Снимок итогов объекта. Вызывается ТОЛЬКО под блокировкой объекта
-- (create_closure / reissue_closure) либо для живого отчёта (без
-- фиксации). Имена статей снапшотятся текстом на момент расчёта.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_build_snapshot(p_object uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_obj fin_accounting_objects%ROWTYPE;
  v_parts jsonb := '[]'::jsonb;
  v_p record;
  v_bal jsonb;
  v_cnt int := 0;
  v_charged numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := 0;
  v_advance numeric := 0;
  v_debtors jsonb := '[]'::jsonb;
  v_income jsonb;
  v_expense jsonb;
  v_income_base numeric;
  v_expense_base numeric;
BEGIN
  SELECT * INTO v_obj FROM fin_accounting_objects WHERE id = p_object;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;

  -- участники (для ретритных объектов)
  IF v_obj.retreat_id IS NOT NULL THEN
    FOR v_p IN
      SELECT DISTINCT ids.pid FROM (
        SELECT participant_id AS pid FROM fin_charges WHERE retreat_id = v_obj.retreat_id
        UNION
        SELECT participant_id FROM fin_participant_opening_balances WHERE retreat_id = v_obj.retreat_id
        UNION
        SELECT p.participant_id FROM fin_postings p
        WHERE p.object_id = p_object AND p.participant_id IS NOT NULL
          AND p.participant_balance_kind IS NOT NULL AND p.participant_balance_kind <> 'none'
      ) ids
    LOOP
      v_bal := fin_private_participant_balance(v_p.pid, v_obj.retreat_id);
      v_cnt := v_cnt + 1;
      v_debt := v_debt + (v_bal->>'total_debt')::numeric;
      v_advance := v_advance + (v_bal->>'total_advance')::numeric;
      -- charged/paid суммарно по блокам
      SELECT v_charged + COALESCE(SUM((v_bal->'blocks'->k->>'charged')::numeric), 0),
             v_paid    + COALESCE(SUM((v_bal->'blocks'->k->>'paid')::numeric), 0)
        INTO v_charged, v_paid
      FROM unnest(ARRAY['org_fee','accommodation','meals','extra']) k;
      IF (v_bal->>'net')::numeric > 0 THEN
        v_debtors := v_debtors || jsonb_build_array(jsonb_build_object(
          'participant_id', v_p.pid,
          'name', fin_private_person_name(v_p.pid),
          'debt', (v_bal->>'net')::numeric));
      END IF;
    END LOOP;
  END IF;

  -- приходы/расходы по статьям (signed: сторно гасит исходную; имена
  -- зафиксированы текстом на момент расчёта)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_income, v_income_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'in'
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'category_id', x.category_id, 'name', x.name,
           'base_total', x.base_total, 'by_currency', x.by_currency)
           ORDER BY x.base_total DESC), '[]'::jsonb),
         COALESCE(SUM(x.base_total), 0)
    INTO v_expense, v_expense_base
  FROM (
    SELECT s.category_id, s.name,
           SUM(s.base_signed) AS base_total,
           jsonb_object_agg(s.currency_code, s.amt_signed) AS by_currency
    FROM (
      SELECT p.category_id, c.name, p.currency_code,
             SUM(CASE p.direction WHEN 'out' THEN p.amount ELSE -p.amount END) AS amt_signed,
             SUM(CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END) AS base_signed
      FROM fin_postings p
      JOIN fin_categories c ON c.id = p.category_id
      WHERE p.object_id = p_object AND c.direction = 'out'
      GROUP BY p.category_id, c.name, p.currency_code
    ) s GROUP BY s.category_id, s.name
  ) x;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'object', jsonb_build_object('id', v_obj.id, 'display_name', v_obj.display_name, 'retreat_id', v_obj.retreat_id),
    'generated_at', now(),
    'participants', jsonb_build_object(
      'count', v_cnt, 'charged', v_charged, 'paid', v_paid,
      'debt_total', v_debt, 'advance_total', v_advance, 'debtors', v_debtors),
    'income_by_category', v_income,
    'expense_by_category', v_expense,
    'totals', jsonb_build_object(
      'income_base', v_income_base,
      'expense_base', v_expense_base,
      'net_base', v_income_base - v_expense_base),
    'cost_per_participant', NULL   -- открытый вопрос 2 ТЗ — не блокирует закрытие
  );
END;
$$;

-- -------------------------------------------------------------
-- fin_create_closure — initial closure (UC-12). Command-idempotent:
-- id строки = request_id. Под блокировкой объекта повторно проверяет
-- отсутствие pending/disputed (сторнированные операции — решённые).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_closure(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_object uuid;
  v_hash text;
  v_existing fin_object_closures%ROWTYPE;
  v_unresolved int;
  v_snapshot jsonb;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Закрытие выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'object_id']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_object := fin_private_get_uuid(payload, 'object_id', true);

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_closure', 'object_id', lower(v_object::text)));

  -- идемпотентность ПЕРВОЙ (Guide 8: до любых предусловий)
  SELECT * INTO v_existing FROM fin_object_closures WHERE id = v_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING DETAIL = 'Тот же request_id уже использован с другим содержимым';
    END IF;
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('closure_id', v_existing.id, 'version', v_existing.version, 'existed', true),
      'warnings', '[]'::jsonb);
  END IF;

  -- блокировка объекта
  PERFORM 1 FROM fin_accounting_objects WHERE id = v_object FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;

  IF EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_object AND c.is_initial) THEN
    RAISE EXCEPTION 'object_already_closed' USING DETAIL = 'Объект уже финансово закрыт';
  END IF;

  -- повторная проверка ПОД блокировкой (сценарии 24, 48, 57)
  SELECT count(DISTINCT o.id) INTO v_unresolved
  FROM fin_operations o
  WHERE o.approval IN ('pending', 'disputed')
    AND NOT o.is_reversed
    AND EXISTS (SELECT 1 FROM fin_postings p WHERE p.operation_id = o.id AND p.object_id = v_object);
  IF v_unresolved > 0 THEN
    RAISE EXCEPTION 'closure_has_unresolved'
      USING DETAIL = format('По объекту %s нерешённых операций (pending/disputed) — решите каждую перед закрытием', v_unresolved);
  END IF;

  v_snapshot := fin_private_build_snapshot(v_object);

  INSERT INTO fin_object_closures (
    id, request_hash, object_id, version, is_initial, status,
    closed_by, totals_snapshot, snapshot_schema_version
  ) VALUES (
    v_request_id, v_hash, v_object, 1, true, 'report_pending',
    v_actor, v_snapshot, 1
  );

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('closure_id', v_request_id, 'version', 1, 'snapshot', v_snapshot),
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
-- fin_reissue_closure — версия N+1 при report_dirty_at (ТЗ 4.15).
-- Идемпотентность → report_not_dirty → пересчёт → dirty := NULL.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_reissue_closure(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_object uuid;
  v_reason text;
  v_hash text;
  v_existing fin_object_closures%ROWTYPE;
  v_obj fin_accounting_objects%ROWTYPE;
  v_next int;
  v_snapshot jsonb;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Перевыпуск выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'object_id', 'reason']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_object := fin_private_get_uuid(payload, 'object_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина перевыпуска обязательна';
  END IF;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'reissue_closure', 'object_id', lower(v_object::text), 'reason', v_reason));

  -- идемпотентность ПЕРВОЙ — иначе retry после сетевого сбоя упал бы
  -- на report_not_dirty: первый вызов уже обнулил флаг (ТЗ раздел 5)
  SELECT * INTO v_existing FROM fin_object_closures WHERE id = v_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING DETAIL = 'Тот же request_id уже использован с другим содержимым';
    END IF;
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('closure_id', v_existing.id, 'version', v_existing.version, 'existed', true),
      'warnings', '[]'::jsonb);
  END IF;

  SELECT * INTO v_obj FROM fin_accounting_objects WHERE id = v_object FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_object AND c.is_initial) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Объект ещё не закрыт — перевыпускать нечего';
  END IF;
  IF v_obj.report_dirty_at IS NULL THEN
    RAISE EXCEPTION 'report_not_dirty'
      USING DETAIL = 'Отчёт актуален — перевыпуск не требуется (защита от двойного нажатия)';
  END IF;

  SELECT COALESCE(MAX(version), 0) + 1 INTO v_next FROM fin_object_closures WHERE object_id = v_object;
  v_snapshot := fin_private_build_snapshot(v_object);

  PERFORM set_config('app.change_reason', v_reason, true);

  INSERT INTO fin_object_closures (
    id, request_hash, object_id, version, is_initial, status,
    closed_by, totals_snapshot, snapshot_schema_version, reason
  ) VALUES (
    v_request_id, v_hash, v_object, v_next, false, 'report_pending',
    v_actor, v_snapshot, 1, v_reason
  );

  UPDATE fin_accounting_objects SET report_dirty_at = NULL WHERE id = v_object;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('closure_id', v_request_id, 'version', v_next, 'snapshot', v_snapshot),
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
-- fin_finalize_closure — связать загруженный PDF (state-idempotent).
-- Не генерирует PDF: файл уже в Storage и привязан вложением уровня
-- объекта; здесь только проверки и переход в finalized.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_finalize_closure(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_closure fin_object_closures%ROWTYPE;
  v_att_id uuid;
  v_att fin_attachments%ROWTYPE;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Финализация выполняется только администратором финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['closure_id', 'attachment_id']);
  v_att_id := fin_private_get_uuid(payload, 'attachment_id', true);

  SELECT * INTO v_closure FROM fin_object_closures
  WHERE id = fin_private_get_uuid(payload, 'closure_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Версия закрытия не найдена';
  END IF;

  -- state-идемпотентность
  IF v_closure.status = 'finalized' THEN
    IF v_closure.attachment_id = v_att_id THEN
      RETURN jsonb_build_object('ok', true,
        'result', jsonb_build_object('closure_id', v_closure.id, 'noop', true),
        'warnings', '[]'::jsonb);
    END IF;
    RAISE EXCEPTION 'finalize_conflict'
      USING DETAIL = 'Версия уже финализирована другим файлом';
  END IF;

  SELECT * INTO v_att FROM fin_attachments WHERE id = v_att_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Вложение не найдено';
  END IF;
  IF v_att.parent_type <> 'accounting_object' OR v_att.parent_id <> v_closure.object_id THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Вложение принадлежит другому объекту';
  END IF;
  IF v_att.mime_type <> 'application/pdf' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Отчёт закрытия — только PDF';
  END IF;
  IF EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.attachment_id = v_att_id AND c.id <> v_closure.id) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Этот PDF уже связан с другой версией закрытия';
  END IF;

  UPDATE fin_object_closures SET
    status = 'finalized',
    attachment_id = v_att_id,
    finalized_at = now(),
    finalized_by = v_actor
  WHERE id = v_closure.id;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('closure_id', v_closure.id, 'version', v_closure.version, 'status', 'finalized'),
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
-- Отчёты для экранов
-- -------------------------------------------------------------

-- 9.6 «Аналитика — по ретриту»: живой отчёт + статус закрытия и версии
CREATE OR REPLACE FUNCTION fin_get_retreat_report(p_retreat uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_object fin_accounting_objects%ROWTYPE;
  v_report jsonb;
  v_versions jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT * INTO v_object FROM fin_accounting_objects WHERE retreat_id = p_retreat;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('exists', false));
  END IF;

  v_report := fin_private_build_snapshot(v_object.id);

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'closure_id', c.id, 'version', c.version, 'is_initial', c.is_initial,
    'status', c.status, 'closed_at', c.closed_at,
    'closed_by_name', fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = c.closed_by LIMIT 1)),
    'finalized_at', c.finalized_at, 'reason', c.reason,
    'attachment_path', (SELECT a.storage_path FROM fin_attachments a WHERE a.id = c.attachment_id),
    'attachment_name', (SELECT a.file_name FROM fin_attachments a WHERE a.id = c.attachment_id)
  ) ORDER BY c.version DESC), '[]'::jsonb) INTO v_versions
  FROM fin_object_closures c WHERE c.object_id = v_object.id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'exists', true,
    'object_id', v_object.id,
    'is_closed', EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = v_object.id AND c.is_initial),
    'report_dirty_at', v_object.report_dirty_at,
    'report', v_report,
    'versions', v_versions
  ));
END;
$$;

-- 9.7 «Аналитика — общая»: период → статьи, месяцы, объекты (signed base)
CREATE OR REPLACE FUNCTION fin_get_summary_report(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_by_category jsonb;
  v_by_month jsonb;
  v_by_object jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name', x.name, 'direction', x.direction, 'base_total', x.base_total) ORDER BY x.direction, x.base_total DESC), '[]'::jsonb)
  INTO v_by_category
  FROM (
    SELECT c.name, c.direction::text AS direction,
           SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END)
             * CASE c.direction WHEN 'out' THEN -1 ELSE 1 END AS base_total
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_categories c ON c.id = p.category_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
    GROUP BY c.name, c.direction
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'month', x.m, 'income_base', x.inc, 'expense_base', x.exp) ORDER BY x.m), '[]'::jsonb)
  INTO v_by_month
  FROM (
    SELECT to_char(date_trunc('month', o.occurred_on), 'YYYY-MM') AS m,
           SUM(CASE WHEN p.direction = 'in'  THEN p.amount_base ELSE 0 END) AS inc,
           SUM(CASE WHEN p.direction = 'out' THEN p.amount_base ELSE 0 END) AS exp
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
      AND p.category_id IS NOT NULL          -- технические движения не входят
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'object_id', x.oid, 'name', x.nm, 'income_base', x.inc, 'expense_base', x.exp) ORDER BY x.inc DESC), '[]'::jsonb)
  INTO v_by_object
  FROM (
    SELECT p.object_id AS oid,
           COALESCE(obj.display_name, '— без объекта —') AS nm,
           SUM(CASE WHEN p.direction = 'in'  THEN p.amount_base ELSE 0 END) AS inc,
           SUM(CASE WHEN p.direction = 'out' THEN p.amount_base ELSE 0 END) AS exp
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    LEFT JOIN fin_accounting_objects obj ON obj.id = p.object_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
      AND p.category_id IS NOT NULL
    GROUP BY 1, 2
  ) x;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'from', p_from, 'to', p_to,
    'by_category', v_by_category,
    'by_month', v_by_month,
    'by_object', v_by_object
  ));
END;
$$;

-- -------------------------------------------------------------
-- Права
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION fin_private_build_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_create_closure(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_reissue_closure(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_finalize_closure(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_get_retreat_report(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_get_summary_report(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_closure(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION fin_reissue_closure(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION fin_finalize_closure(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_get_retreat_report(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_get_summary_report(date, date) TO authenticated;
