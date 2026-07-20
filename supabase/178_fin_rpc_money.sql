-- =============================================================
-- Финансовый модуль, Этап 1а: денежные RPC
-- fin_create_transfer, fin_create_expense, fin_create_income,
-- fin_create_donation (последние три — общий конвейер
-- fin_private_create_flow).
-- Порядок блокировок (инвариант 6): объекты -> счета (ORDER BY id) ->
-- проверки -> ledger_seq -> запись. Идемпотентность — первым шагом.
-- =============================================================

-- -------------------------------------------------------------
-- fin_create_transfer — перевод между счетами (включая обмен валют
-- и выдачу под отчёт). Command-idempotent.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_transfer(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_is_admin boolean;
  v_request_id uuid;
  v_source fin_accounts%ROWTYPE;
  v_target fin_accounts%ROWTYPE;
  v_source_id uuid;
  v_target_id uuid;
  v_source_amount numeric;
  v_target_amount numeric;
  v_on date;
  v_comment text;
  v_canonical jsonb;
  v_hash text;
  v_existing jsonb;
  v_source_rate numeric;
  v_target_rate numeric;
  v_source_base numeric;
  v_balance numeric;
  v_approval fin_approval;
  v_warnings jsonb := '[]'::jsonb;
  v_detail text;
  r record;
BEGIN
  v_actor := fin_actor();
  v_is_admin := fin_is_admin(v_actor);
  IF NOT v_is_admin AND NOT fin_is_account_user(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Нет прав на переводы';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'occurred_on', 'source_account_id', 'target_account_id',
    'source_amount', 'target_amount', 'comment'
  ]);

  v_request_id    := fin_private_get_uuid(payload, 'request_id', true);
  v_source_id     := fin_private_get_uuid(payload, 'source_account_id', true);
  v_target_id     := fin_private_get_uuid(payload, 'target_account_id', true);
  v_source_amount := fin_private_get_money(payload, 'source_amount', true);
  v_target_amount := fin_private_get_money(payload, 'target_amount', false);
  v_on            := fin_private_get_date(payload, 'occurred_on', true);
  v_comment       := NULLIF(trim(COALESCE(payload->>'comment', '')), '');

  IF v_source_id = v_target_id THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Счёт-источник и счёт-получатель должны различаться';
  END IF;

  v_canonical := jsonb_build_object(
    'command', 'create_transfer',
    'occurred_on', v_on,
    'source_account_id', lower(v_source_id::text),
    'target_account_id', lower(v_target_id::text),
    'source_amount', fin_private_norm_money(v_source_amount),
    'target_amount', CASE WHEN v_target_amount IS NULL THEN NULL ELSE fin_private_norm_money(v_target_amount) END,
    'comment', v_comment
  );
  v_hash := fin_private_hash(v_canonical);

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  -- блокировка обоих счетов в порядке id (защита от deadlock встречных переводов)
  FOR r IN
    SELECT * FROM fin_accounts WHERE id IN (v_source_id, v_target_id) ORDER BY id FOR UPDATE
  LOOP
    IF r.id = v_source_id THEN v_source := r; ELSE v_target := r; END IF;
  END LOOP;

  IF v_source.id IS NULL THEN RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт-источник не найден'; END IF;
  IF v_target.id IS NULL THEN RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт-получатель не найден'; END IF;
  IF NOT v_source.is_active OR NOT v_target.is_active THEN
    RAISE EXCEPTION 'account_inactive' USING DETAIL = 'Один из счетов деактивирован';
  END IF;

  -- права пользователя счетов: source из своего набора, target — подотчётный
  IF NOT v_is_admin THEN
    IF NOT EXISTS (SELECT 1 FROM fin_account_access WHERE user_id = v_actor AND account_id = v_source.id) THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Счёт-источник не входит в ваш набор счетов';
    END IF;
    IF v_target.kind <> 'custodial' THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Пользователь счетов переводит только на подотчётные счета';
    END IF;
  END IF;

  -- валютная математика
  IF v_source.currency_code = v_target.currency_code THEN
    IF v_target_amount IS NOT NULL AND v_target_amount <> v_source_amount THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'При одной валюте суммы сторон должны совпадать';
    END IF;
    v_target_amount := v_source_amount;
    v_source_rate := fin_private_get_rate(v_source.currency_code, NULL, v_on);
    v_target_rate := v_source_rate;
    v_source_base := round(v_source_amount * v_source_rate, 2);
  ELSE
    IF v_target_amount IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'При разных валютах обязательна сумма получения';
    END IF;
    v_source_rate := fin_private_get_rate(v_source.currency_code, NULL, v_on);
    v_source_base := round(v_source_amount * v_source_rate, 2);
    v_target_rate := round(v_source_base / v_target_amount, 6);
    IF v_target_rate <= 0 THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректное соотношение сумм перевода';
    END IF;
  END IF;

  -- политика минуса: реальный источник в минус не уходит; подотчётный — предупреждение
  v_balance := fin_private_account_balance(v_source.id);
  IF v_balance - v_source_amount < 0 THEN
    IF v_source.kind = 'real' THEN
      RAISE EXCEPTION 'insufficient_funds'
        USING DETAIL = format('Остаток %s, требуется %s', v_balance, v_source_amount);
    ELSE
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'custodial_negative_balance',
        'message', format('Подотчётный счёт уйдёт в минус: %s', v_balance - v_source_amount)));
    END IF;
  END IF;

  v_approval := CASE WHEN v_is_admin THEN 'not_required'::fin_approval ELSE 'pending'::fin_approval END;

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, created_by, comment)
  VALUES (v_request_id, v_hash, 'transfer', v_on, v_approval, v_actor, v_comment);

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)
  VALUES
    (fin_private_child_uuid(v_request_id, 'out'), v_request_id, v_source.id, 'out',
     v_source_amount, v_source.currency_code, v_source_base, v_source_rate),
    (fin_private_child_uuid(v_request_id, 'in'), v_request_id, v_target.id, 'in',
     v_target_amount, v_target.currency_code, v_source_base, v_target_rate);

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

-- -------------------------------------------------------------
-- Общий конвейер expense / income / donation.
-- Строки независимы (каждая со своим клиентским UUID); в рамках
-- группы (валюта, курс) последняя строка добирает округлительный
-- остаток base (ТЗ 10.9, сценарий 76).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_private_create_flow(p_type fin_operation_type, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_is_admin boolean;
  v_request_id uuid;
  v_on date;
  v_comment text;
  v_reason text;
  v_payer uuid;
  v_rows jsonb;
  v_canonical_rows jsonb := '[]'::jsonb;
  v_canonical jsonb;
  v_hash text;
  v_existing jsonb;
  v_direction fin_direction;
  v_approval fin_approval;
  v_warnings jsonb := '[]'::jsonb;
  v_any_post_close boolean := false;
  v_detail text;
  r jsonb;
  v_row_ids uuid[];
  v_accounts uuid[];
  v_objects uuid[];
  v_closed_objects uuid[];  -- NULL, пока не найден ни один закрытый объект
  v_acc fin_accounts%ROWTYPE;
  v_obj uuid;
  v_cat record;
  v_rate numeric;
  v_participant uuid;
  v_balance numeric;
  v_out_total numeric;
  i int;
  n int;
  v_group_key text;
  v_group_total_base numeric;
  v_group_assigned numeric;
  v_group_last int;
  v_bases numeric[];
  v_rates numeric[];
BEGIN
  v_actor := fin_actor();
  v_is_admin := fin_is_admin(v_actor);
  v_direction := CASE WHEN p_type = 'expense' THEN 'out'::fin_direction ELSE 'in'::fin_direction END;

  IF p_type = 'expense' THEN
    IF NOT v_is_admin AND NOT fin_is_account_user(v_actor) THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Нет прав на внесение трат';
    END IF;
  ELSE
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Доступно только администратору финансов';
    END IF;
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'occurred_on', 'comment', 'reason', 'payer_contact_id', 'rows'
  ]);
  IF p_type <> 'donation' AND payload->>'payer_contact_id' IS NOT NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'payer_contact_id допустим только для donation';
  END IF;

  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_on         := fin_private_get_date(payload, 'occurred_on', true);
  v_comment    := NULLIF(trim(COALESCE(payload->>'comment', '')), '');
  v_reason     := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  v_payer      := fin_private_get_uuid(payload, 'payer_contact_id', false);

  IF v_payer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_payer) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Жертвователь не найден в справочнике людей';
  END IF;

  v_rows := payload->'rows';
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив строк';
  END IF;

  -- канонизация строк: сортировка по клиентскому row UUID (Guide 8.2)
  FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY[
      'id', 'account_id', 'amount', 'category_id', 'cost_center_id',
      'object_id', 'participant_id', 'contractor_id', 'payment_channel'
    ]);
    IF NULLIF(r->>'payment_channel', '') IS NOT NULL THEN
      BEGIN
        PERFORM (r->>'payment_channel')::fin_payment_channel;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный payment_channel';
      END;
    END IF;
    -- типизированная канонизация: '' -> NULL, uuid -> lowercase, деньги -> 2 знака
    v_canonical_rows := v_canonical_rows || jsonb_build_array(jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'category_id', lower(fin_private_get_uuid(r, 'category_id', true)::text),
      'cost_center_id', lower(fin_private_get_uuid(r, 'cost_center_id')::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id')::text),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id')::text),
      'contractor_id', lower(fin_private_get_uuid(r, 'contractor_id')::text),
      'payment_channel', NULLIF(r->>'payment_channel', '')
    ));
  END LOOP;

  v_canonical := jsonb_build_object(
    'command', 'create_' || p_type::text,
    'occurred_on', v_on,
    'comment', v_comment,
    'reason', v_reason,
    'payer_contact_id', CASE WHEN v_payer IS NULL THEN NULL ELSE lower(v_payer::text) END,
    'rows', v_canonical_rows
  );
  v_hash := fin_private_hash(v_canonical);

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  -- наборы объектов и счетов
  SELECT array_agg(DISTINCT (x->>'object_id')::uuid) FILTER (WHERE x->>'object_id' IS NOT NULL),
         array_agg(DISTINCT (x->>'account_id')::uuid),
         array_agg((x->>'id')::uuid)
    INTO v_objects, v_accounts, v_row_ids
  FROM jsonb_array_elements(v_canonical_rows) AS x;

  IF (SELECT count(DISTINCT u) FROM unnest(v_row_ids) u) <> array_length(v_row_ids, 1) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Дублирующиеся id строк';
  END IF;

  -- шаг 1: блокировка учётных объектов (по id, отсортированно)
  IF v_objects IS NOT NULL THEN
    PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_objects) ORDER BY id FOR UPDATE;
    IF (SELECT count(*) FROM fin_accounting_objects WHERE id = ANY (v_objects)) <> array_length(v_objects, 1) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
    END IF;
    SELECT array_agg(DISTINCT c.object_id) INTO v_closed_objects
    FROM fin_object_closures c WHERE c.object_id = ANY (v_objects) AND c.is_initial;
  END IF;

  -- post-close: пользователь счетов — отказ; администратор — причина обязательна
  IF v_closed_objects IS NOT NULL THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION 'object_closed'
        USING DETAIL = 'Объект учёта финансово закрыт — операцию может провести только администратор';
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'post_close_reason_required'
        USING DETAIL = 'Операция по закрытому объекту требует причины';
    END IF;
    v_any_post_close := true;
  END IF;

  -- шаг 3: блокировка счетов (ORDER BY id)
  PERFORM 1 FROM fin_accounts WHERE id = ANY (v_accounts) ORDER BY id FOR UPDATE;

  -- проверки счетов и прав
  FOR v_acc IN SELECT * FROM fin_accounts WHERE id = ANY (v_accounts)
  LOOP
    IF NOT v_acc.is_active THEN
      RAISE EXCEPTION 'account_inactive' USING DETAIL = format('Счёт «%s» деактивирован', v_acc.name);
    END IF;
    IF p_type = 'expense' AND NOT v_is_admin
       AND NOT EXISTS (SELECT 1 FROM fin_account_access WHERE user_id = v_actor AND account_id = v_acc.id) THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = format('Счёт «%s» не входит в ваш набор счетов', v_acc.name);
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM fin_accounts WHERE id = ANY (v_accounts)) <> array_length(v_accounts, 1) THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден';
  END IF;

  -- политика минуса для расходов (по каждому счёту суммарно)
  IF p_type = 'expense' THEN
    FOR v_acc IN SELECT * FROM fin_accounts WHERE id = ANY (v_accounts)
    LOOP
      SELECT COALESCE(SUM((x->>'amount')::numeric), 0) INTO v_out_total
      FROM jsonb_array_elements(v_canonical_rows) AS x
      WHERE (x->>'account_id')::uuid = v_acc.id;
      v_balance := fin_private_account_balance(v_acc.id);
      IF v_balance - v_out_total < 0 THEN
        IF v_acc.kind = 'real' THEN
          RAISE EXCEPTION 'insufficient_funds'
            USING DETAIL = format('Счёт «%s»: остаток %s, требуется %s', v_acc.name, v_balance, v_out_total);
        ELSE
          v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
            'code', 'custodial_negative_balance',
            'message', format('Счёт «%s» уйдёт в минус: %s', v_acc.name, v_balance - v_out_total)));
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- проверки строк + расчёт курса/базы
  n := jsonb_array_length(v_canonical_rows);
  v_bases := array_fill(NULL::numeric, ARRAY[n]);
  v_rates := array_fill(NULL::numeric, ARRAY[n]);

  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_obj := (r->>'object_id')::uuid;
    v_participant := (r->>'participant_id')::uuid;

    SELECT c.id, c.direction, c.is_active, c.visible_to_departments
      INTO v_cat
    FROM fin_categories c WHERE c.id = (r->>'category_id')::uuid;
    IF v_cat.id IS NULL OR NOT v_cat.is_active THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья не найдена или архивирована';
    END IF;
    IF v_cat.direction <> v_direction THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Статья направления %s недопустима для %s', v_cat.direction, p_type);
    END IF;
    IF p_type = 'expense' AND NOT v_is_admin AND NOT v_cat.visible_to_departments THEN
      RAISE EXCEPTION 'forbidden' USING DETAIL = 'Эта статья недоступна департаментам — выберите из короткого списка или «Прочее»';
    END IF;

    IF v_participant IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_participant) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
    END IF;
    IF r->>'contractor_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_contractors WHERE id = (r->>'contractor_id')::uuid AND is_active) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Контрагент не найден или архивирован';
    END IF;
    IF r->>'cost_center_id' IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_cost_centers WHERE id = (r->>'cost_center_id')::uuid AND is_active) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Cost center не найден или архивирован';
    END IF;

    v_rate := fin_private_get_rate(v_acc.currency_code, v_obj, v_on);
    v_rates[i + 1] := v_rate;
    v_bases[i + 1] := round(((r->>'amount')::numeric) * v_rate, 2);
  END LOOP;

  -- округление группами (валюта, курс): последняя строка добирает остаток
  FOR v_group_key, v_group_total_base, v_group_assigned, v_group_last IN
    SELECT g.key,
           round(SUM(g.amount * g.rate), 2),
           SUM(g.base_rounded),
           MAX(g.idx)
    FROM (
      SELECT (SELECT currency_code FROM fin_accounts a WHERE a.id = (o.x->>'account_id')::uuid) || ':' || v_rates[o.ord]::text AS key,
             (o.x->>'amount')::numeric AS amount,
             v_rates[o.ord] AS rate,
             v_bases[o.ord] AS base_rounded,
             o.ord AS idx
      FROM jsonb_array_elements(v_canonical_rows) WITH ORDINALITY AS o(x, ord)
    ) g
    GROUP BY g.key
    HAVING count(*) > 1
  LOOP
    IF v_group_total_base <> v_group_assigned THEN
      v_bases[v_group_last] := v_bases[v_group_last] + (v_group_total_base - v_group_assigned);
    END IF;
  END LOOP;

  -- запись
  v_approval := CASE
    WHEN v_any_post_close THEN 'not_required'::fin_approval          -- post-close всегда без цикла согласования
    WHEN p_type = 'expense' AND NOT v_is_admin THEN 'pending'::fin_approval
    ELSE 'not_required'::fin_approval
  END;

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, payer_contact_id, reason, comment, created_by)
  VALUES (v_request_id, v_hash, p_type, v_on, v_approval, v_payer, v_reason, v_comment, v_actor);

  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_obj := (r->>'object_id')::uuid;

    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, cost_center_id, object_id,
      is_post_close, participant_id, participant_balance_kind,
      contractor_id, payment_channel
    ) VALUES (
      (r->>'id')::uuid, v_request_id, v_acc.id, v_direction,
      (r->>'amount')::numeric, v_acc.currency_code,
      v_bases[i + 1], v_rates[i + 1],
      (r->>'category_id')::uuid,
      COALESCE((r->>'cost_center_id')::uuid, v_acc.default_cost_center_id),
      v_obj,
      (v_obj IS NOT NULL AND v_closed_objects IS NOT NULL AND v_obj = ANY (v_closed_objects)),
      (r->>'participant_id')::uuid,
      CASE WHEN r->>'participant_id' IS NULL THEN NULL ELSE 'none'::fin_participant_balance_kind END,
      (r->>'contractor_id')::uuid,
      CASE WHEN r->>'payment_channel' IS NULL THEN NULL ELSE (r->>'payment_channel')::fin_payment_channel END
    );
  END LOOP;

  -- post-close изменение помечает отчёт устаревшим
  IF v_closed_objects IS NOT NULL THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = ANY (v_closed_objects);
  END IF;

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

CREATE OR REPLACE FUNCTION fin_create_expense(payload jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT fin_private_create_flow('expense', payload); $$;

CREATE OR REPLACE FUNCTION fin_create_income(payload jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT fin_private_create_flow('income', payload); $$;

CREATE OR REPLACE FUNCTION fin_create_donation(payload jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$ SELECT fin_private_create_flow('donation', payload); $$;

-- -------------------------------------------------------------
-- Права
-- -------------------------------------------------------------
REVOKE ALL ON FUNCTION fin_private_create_flow(fin_operation_type, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION fin_create_transfer(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_expense(jsonb)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_income(jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION fin_create_donation(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_transfer(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_expense(jsonb)  TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_income(jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION fin_create_donation(jsonb) TO authenticated;
