-- =============================================================
-- Финансовый модуль, Этап 1б: views для экранов + CRUD-RPC справочников
-- Видимость: админ/наблюдатель — всё; пользователь счетов — свои счета
-- (его собственные экраны — этап 5). Прямой DML по-прежнему запрещён.
-- =============================================================

-- Имя человека (единое правило проекта: spiritual_name -> first+last)
CREATE OR REPLACE FUNCTION fin_private_person_name(p_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(NULLIF(v.spiritual_name, ''), NULLIF(trim(concat_ws(' ', v.first_name, v.last_name)), ''))
  FROM vaishnavas v WHERE v.id = p_id;
$$;

-- -------------------------------------------------------------
-- Сводная лента операций (админ/наблюдатель)
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_operations AS
SELECT
  o.id AS operation_id,
  o.type,
  o.occurred_on,
  o.approval,
  o.is_reversed,
  o.original_operation_id,
  o.payer_contact_id,
  fin_private_person_name(o.payer_contact_id) AS payer_name,
  o.reason,
  o.comment,
  o.created_by,
  o.created_at,
  (o.created_at::date > o.occurred_on) AS is_late,
  agg.has_post_close,
  agg.accounts_count,
  agg.max_ledger_seq,
  agg.amounts_by_currency
FROM fin_operations o
JOIN LATERAL (
  SELECT bool_or(p.is_post_close) AS has_post_close,
         count(DISTINCT p.account_id) AS accounts_count,
         max(p.ledger_seq) AS max_ledger_seq,
         (SELECT jsonb_object_agg(x.currency_code, x.total)
          FROM (SELECT pp.currency_code,
                       SUM(CASE pp.direction WHEN 'in' THEN pp.amount ELSE -pp.amount END) AS total
                FROM fin_postings pp WHERE pp.operation_id = o.id
                GROUP BY pp.currency_code) x) AS amounts_by_currency
  FROM fin_postings p WHERE p.operation_id = o.id
) agg ON true
WHERE fin_can_read_all();

-- -------------------------------------------------------------
-- Лента счёта (одна строка на проводку, running balance по ledger_seq)
-- -------------------------------------------------------------
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
    OVER (PARTITION BY p.account_id ORDER BY p.ledger_seq) AS running_balance
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

-- -------------------------------------------------------------
-- Справочники для форм
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_categories AS
SELECT id, code, name, direction, visible_to_departments, is_active
FROM fin_categories
WHERE fin_can_read_all() OR (visible_to_departments AND fin_is_account_user());

CREATE OR REPLACE VIEW fin_v_cost_centers AS
SELECT id, code, name, is_active
FROM fin_cost_centers
WHERE fin_can_read_all() OR fin_is_account_user();

CREATE OR REPLACE VIEW fin_v_contractors AS
SELECT id, name, type, contact_id, contact_info, note, is_active
FROM fin_contractors
WHERE fin_can_read_all();

CREATE OR REPLACE VIEW fin_v_currencies AS
SELECT code, symbol, name, is_active
FROM fin_currencies
WHERE fin_can_read_all() OR fin_is_account_user();

CREATE OR REPLACE VIEW fin_v_exchange_rates AS
SELECT r.id, r.object_id, obj.display_name AS object_name, r.effective_date,
       r.from_currency, r.rate, r.created_at
FROM fin_exchange_rates r
LEFT JOIN fin_accounting_objects obj ON obj.id = r.object_id
WHERE fin_can_read_all();

CREATE OR REPLACE VIEW fin_v_accounting_objects AS
SELECT o.id, o.type, o.retreat_id, o.display_name, o.report_dirty_at, o.created_at
FROM fin_accounting_objects o
WHERE fin_can_read_all() OR fin_is_account_user();

-- Доступ к счетам (для экрана «Доступ»)
CREATE OR REPLACE VIEW fin_v_account_access AS
SELECT aa.user_id, aa.account_id, a.name AS account_name,
       (SELECT fin_private_person_name(v.id) FROM vaishnavas v WHERE v.user_id = aa.user_id) AS user_name
FROM fin_account_access aa
JOIN fin_accounts a ON a.id = aa.account_id
WHERE fin_can_read_all();

GRANT SELECT ON fin_v_operations, fin_v_account_ledger, fin_v_categories,
  fin_v_cost_centers, fin_v_contractors, fin_v_currencies,
  fin_v_exchange_rates, fin_v_accounting_objects, fin_v_account_access
TO authenticated;

-- -------------------------------------------------------------
-- CRUD-RPC справочников (только администратор; всё с аудитом)
-- -------------------------------------------------------------

-- Статьи
CREATE OR REPLACE FUNCTION fin_save_category(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id','code','name','direction','visible_to_departments','is_active']);
  v_id := fin_private_get_uuid(payload, 'id');
  IF NULLIF(trim(payload->>'code'), '') IS NULL OR NULLIF(trim(payload->>'name'), '') IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'code и name обязательны';
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO fin_categories (code, name, direction, visible_to_departments, is_active)
    VALUES (trim(payload->>'code'), trim(payload->>'name'),
            (payload->>'direction')::fin_direction,
            COALESCE((payload->>'visible_to_departments')::boolean, false),
            COALESCE((payload->>'is_active')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    -- direction после создания не меняется: от него зависят проведённые проводки
    UPDATE fin_categories SET
      code = COALESCE(NULLIF(trim(payload->>'code'), ''), code),
      name = COALESCE(NULLIF(trim(payload->>'name'), ''), name),
      visible_to_departments = COALESCE((payload->>'visible_to_departments')::boolean, visible_to_departments),
      is_active = COALESCE((payload->>'is_active')::boolean, is_active)
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья не найдена'; END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'code_taken', 'message', 'Код уже используется'));
WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- Cost centers
CREATE OR REPLACE FUNCTION fin_save_cost_center(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id','code','name','is_active']);
  v_id := fin_private_get_uuid(payload, 'id');
  IF v_id IS NULL THEN
    IF NULLIF(trim(payload->>'code'), '') IS NULL OR NULLIF(trim(payload->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'code и name обязательны';
    END IF;
    INSERT INTO fin_cost_centers (code, name, is_active)
    VALUES (trim(payload->>'code'), trim(payload->>'name'), COALESCE((payload->>'is_active')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE fin_cost_centers SET
      code = COALESCE(NULLIF(trim(payload->>'code'), ''), code),
      name = COALESCE(NULLIF(trim(payload->>'name'), ''), name),
      is_active = COALESCE((payload->>'is_active')::boolean, is_active)
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Cost center не найден'; END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'code_taken', 'message', 'Код уже используется'));
WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- Контрагенты
CREATE OR REPLACE FUNCTION fin_save_contractor(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id','name','type','contact_id','contact_info','note','is_active']);
  v_id := fin_private_get_uuid(payload, 'id');
  IF v_id IS NULL THEN
    IF NULLIF(trim(payload->>'name'), '') IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'name обязателен';
    END IF;
    INSERT INTO fin_contractors (name, type, contact_id, contact_info, note, is_active)
    VALUES (trim(payload->>'name'), (payload->>'type')::fin_contractor_type,
            fin_private_get_uuid(payload, 'contact_id'),
            NULLIF(trim(COALESCE(payload->>'contact_info', '')), ''),
            NULLIF(trim(COALESCE(payload->>'note', '')), ''),
            COALESCE((payload->>'is_active')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    UPDATE fin_contractors SET
      name = COALESCE(NULLIF(trim(payload->>'name'), ''), name),
      type = COALESCE((NULLIF(payload->>'type',''))::fin_contractor_type, type),
      contact_id = CASE WHEN payload ? 'contact_id' THEN fin_private_get_uuid(payload, 'contact_id') ELSE contact_id END,
      contact_info = CASE WHEN payload ? 'contact_info' THEN NULLIF(trim(COALESCE(payload->>'contact_info', '')), '') ELSE contact_info END,
      note = CASE WHEN payload ? 'note' THEN NULLIF(trim(COALESCE(payload->>'note', '')), '') ELSE note END,
      is_active = COALESCE((payload->>'is_active')::boolean, is_active)
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Контрагент не найден'; END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- Курс валюты (insert; повтор на ту же дату/валюту/объект обновляет курс — с аудитом)
CREATE OR REPLACE FUNCTION fin_save_exchange_rate(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_rate numeric;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['object_id','effective_date','from_currency','rate']);
  v_rate := (payload->>'rate')::numeric;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Курс должен быть > 0';
  END IF;
  IF payload->>'from_currency' = 'INR' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Курс INR всегда 1 — не задаётся';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = payload->>'from_currency' AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Неизвестная валюта';
  END IF;

  INSERT INTO fin_exchange_rates (object_id, effective_date, from_currency, rate, created_by)
  VALUES (fin_private_get_uuid(payload, 'object_id'),
          fin_private_get_date(payload, 'effective_date', true),
          payload->>'from_currency', round(v_rate, 6), fin_actor())
  ON CONFLICT (object_id, effective_date, from_currency)
  DO UPDATE SET rate = EXCLUDED.rate, created_by = EXCLUDED.created_by, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- Правка счёта: имя/группа/ответственный/default cost center/активность.
-- kind, валюта, reconciliation_mode не меняются (ключи не принимаются).
-- Деактивация — только при нулевом остатке.
CREATE OR REPLACE FUNCTION fin_update_account(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_account fin_accounts%ROWTYPE;
  v_name text;
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
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- Назначение доступа: полная замена набора счетов пользователя
CREATE OR REPLACE FUNCTION fin_set_account_access(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_ids uuid[];
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['user_id','account_ids']);
  v_user := fin_private_get_uuid(payload, 'user_id', true);
  SELECT array_agg(x::uuid) INTO v_ids FROM jsonb_array_elements_text(COALESCE(payload->'account_ids', '[]'::jsonb)) x;

  IF v_ids IS NOT NULL AND (SELECT count(*) FROM fin_accounts WHERE id = ANY (v_ids)) <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Неизвестный счёт в списке';
  END IF;

  DELETE FROM fin_account_access WHERE user_id = v_user
    AND (v_ids IS NULL OR account_id <> ALL (v_ids));
  IF v_ids IS NOT NULL THEN
    INSERT INTO fin_account_access (user_id, account_id)
    SELECT v_user, unnest(v_ids)
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('user_id', v_user, 'count', COALESCE(array_length(v_ids, 1), 0)));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- fin_private_person_name вызывается ИЗ views: функции внутри view
-- исполняются с правами вызывающего, поэтому authenticated нужен EXECUTE
REVOKE ALL ON FUNCTION fin_private_person_name(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_private_person_name(uuid) TO authenticated;
REVOKE ALL ON FUNCTION fin_save_category(jsonb)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_save_cost_center(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_save_contractor(jsonb)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_save_exchange_rate(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_update_account(jsonb)     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_set_account_access(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_save_category(jsonb)      TO authenticated;
GRANT EXECUTE ON FUNCTION fin_save_cost_center(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION fin_save_contractor(jsonb)    TO authenticated;
GRANT EXECUTE ON FUNCTION fin_save_exchange_rate(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_update_account(jsonb)     TO authenticated;
GRANT EXECUTE ON FUNCTION fin_set_account_access(jsonb) TO authenticated;
