-- Сдача: в кассу пишется вся принятая от гостя сумма (ВГ, 27.09)
--
-- Было: форма проводила блоки + дар = «получено − сдача», а затем списывала
-- сдачу ещё раз отдельной строкой. Сдача в той же валюте: €500 − €60 сдачи
-- проводились как €380 вместо €440. Сдача в другой валюте: гость дал €350,
-- получил ₹300 — в Кассу € шло €347,25. Так при сверке 23.09 набежало
-- €128 / ₽7 091 / $78 недостачи в системе.
--
-- Стало: часть денег гостя, возвращённая сдачей, проводится той же операцией
-- строкой «Принято под сдачу» — приход в валюте гостя, блок none (на долг
-- участника не влияет, как и сама сдача). Касса = то, что в коробке.

insert into fin_categories (code, name, direction, visible_to_departments, is_active)
values ('participant_change_exchange', 'Принято под сдачу', 'in', false, true)
on conflict (code) do nothing;

CREATE OR REPLACE FUNCTION public.fin_create_payment(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_on date;
  v_comment text;
  v_reason text;
  v_payer uuid;
  v_rows jsonb;
  v_canonical_rows jsonb := '[]'::jsonb;
  v_change jsonb;
  v_changes jsonb := '[]'::jsonb;          -- входные строки сдачи
  v_canonical_changes jsonb := '[]'::jsonb;
  v_exchanges jsonb := '[]'::jsonb;        -- входные строки «принято под сдачу»
  v_canonical_exchanges jsonb := '[]'::jsonb;
  v_exchange_category uuid;
  v_exchange_base numeric;
  v_change_base numeric;
  v_hash_payload jsonb;
  v_hash text;
  v_existing jsonb;
  r jsonb;
  v_category uuid;
  v_change_category uuid;
  v_accounts uuid[];
  v_objects uuid[];
  v_closed_objects uuid[];
  v_acc fin_accounts%ROWTYPE;
  v_obj uuid;
  v_kind fin_participant_balance_kind;
  v_rate numeric;
  v_base numeric;
  v_price record;
  v_balance numeric;
  v_out_total numeric;
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

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'occurred_on', 'payer_contact_id', 'comment', 'reason', 'rows', 'change', 'exchange']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_on := fin_private_get_date(payload, 'occurred_on', true);
  v_comment := NULLIF(trim(COALESCE(payload->>'comment', '')), '');
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  v_payer := fin_private_get_uuid(payload, 'payer_contact_id', true);
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_payer) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Плательщик не найден';
  END IF;

  SELECT id INTO v_category FROM fin_categories WHERE code = 'participant_payment';
  SELECT id INTO v_change_category FROM fin_categories WHERE code = 'participant_change';
  SELECT id INTO v_exchange_category FROM fin_categories WHERE code = 'participant_change_exchange';

  v_rows := payload->'rows';
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив строк платежа';
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'participant_balance_kind', 'payment_channel', 'rate_mode']);
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
    IF NULLIF(r->>'rate_mode', '') IS NOT NULL AND r->>'rate_mode' NOT IN ('crm_price', 'retreat') THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rate_mode: crm_price | retreat';
    END IF;
    v_canonical_rows := v_canonical_rows || jsonb_build_array(jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'participant_balance_kind', v_kind,
      'payment_channel', NULLIF(r->>'payment_channel', ''),
      'rate_mode', NULLIF(r->>'rate_mode', '')
    ));
  END LOOP;

  -- Сдача: одна или несколько строк (разные валюты в одной операции, п.11 v4)
  v_change := payload->'change';
  IF v_change IS NOT NULL AND jsonb_typeof(v_change) = 'object' THEN
    v_changes := jsonb_build_array(v_change);
  ELSIF v_change IS NOT NULL AND jsonb_typeof(v_change) = 'array' THEN
    v_changes := v_change;
  ELSIF v_change IS NOT NULL AND jsonb_typeof(v_change) <> 'null' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'change: ожидается объект или массив';
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_changes) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'participant_balance_kind', 'payment_channel']);
    BEGIN
      v_kind := (r->>'participant_balance_kind')::fin_participant_balance_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'change.participant_balance_kind: org_fee | accommodation | meals | extra | general';
    END;
    -- блок сдачи не проверяем: в проводку пишется none (см. миграцию 408)
    v_canonical_changes := v_canonical_changes || jsonb_build_array(jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'participant_balance_kind', v_kind,
      'payment_channel', NULLIF(r->>'payment_channel', '')));
  END LOOP;

  -- Принято под сдачу: часть денег гостя, которую вернули сдачей (ВГ, 27.09).
  -- Без неё касса недосчитывает принятое.
  IF payload->'exchange' IS NOT NULL AND jsonb_typeof(payload->'exchange') = 'array' THEN
    v_exchanges := payload->'exchange';
  ELSIF payload->'exchange' IS NOT NULL AND jsonb_typeof(payload->'exchange') <> 'null' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'exchange: ожидается массив';
  END IF;
  IF jsonb_array_length(v_exchanges) > 0 AND jsonb_array_length(v_canonical_changes) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = '«Принято под сдачу» проводится только вместе со сдачей';
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_exchanges) AS x(val) ORDER BY lower(x.val->>'id')
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'payment_channel']);
    IF NULLIF(r->>'payment_channel', '') IS NOT NULL THEN
      BEGIN
        PERFORM (r->>'payment_channel')::fin_payment_channel;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректный payment_channel';
      END;
    END IF;
    v_canonical_exchanges := v_canonical_exchanges || jsonb_build_array(jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'payment_channel', NULLIF(r->>'payment_channel', '')));
  END LOOP;

  -- ключ exchange в хеше только когда он есть: хеши прежних платежей не меняются
  v_hash_payload := jsonb_build_object(
    'command', 'create_payment',
    'occurred_on', v_on,
    'payer_contact_id', lower(v_payer::text),
    'comment', v_comment,
    'reason', v_reason,
    'rows', v_canonical_rows,
    'change', CASE WHEN jsonb_array_length(v_canonical_changes) = 0 THEN NULL ELSE v_canonical_changes END
  );
  IF jsonb_array_length(v_canonical_exchanges) > 0 THEN
    v_hash_payload := v_hash_payload || jsonb_build_object('exchange', v_canonical_exchanges);
  END IF;
  v_hash := fin_private_hash(v_hash_payload);

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  SELECT array_agg(DISTINCT (z.x->>'object_id')::uuid),
         array_agg(DISTINCT (z.x->>'account_id')::uuid)
    INTO v_objects, v_accounts
  FROM (
    SELECT y.x FROM jsonb_array_elements(v_canonical_rows) AS y(x)
    UNION ALL
    SELECT c.x FROM jsonb_array_elements(v_canonical_changes) AS c(x)
    UNION ALL
    SELECT e.x FROM jsonb_array_elements(v_canonical_exchanges) AS e(x)
  ) z(x);

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

  PERFORM 1 FROM fin_accounts WHERE id = ANY (v_accounts) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM fin_accounts WHERE id = ANY (v_accounts) AND is_active) <> array_length(v_accounts, 1) THEN
    RAISE EXCEPTION 'account_not_found' USING DETAIL = 'Счёт не найден или деактивирован';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (
      SELECT y.x FROM jsonb_array_elements(v_canonical_rows) AS y(x)
      UNION ALL
      SELECT c.x FROM jsonb_array_elements(v_canonical_changes) AS c(x)
      UNION ALL
      SELECT e.x FROM jsonb_array_elements(v_canonical_exchanges) AS e(x)
    ) z(x)
    LEFT JOIN vaishnavas v ON v.id = (z.x->>'participant_id')::uuid
    WHERE v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
  END IF;

  -- Принятое под сдачу не может быть дороже самой сдачи (2% на округление):
  -- иначе этой строкой можно провести в кассу что угодно
  IF jsonb_array_length(v_canonical_exchanges) > 0 THEN
    SELECT COALESCE(SUM(round((e.x->>'amount')::numeric
             * fin_private_get_rate(ea.currency_code, (e.x->>'object_id')::uuid, v_on), 2)), 0)
      INTO v_exchange_base
    FROM jsonb_array_elements(v_canonical_exchanges) e(x)
    JOIN fin_accounts ea ON ea.id = (e.x->>'account_id')::uuid;
    SELECT COALESCE(SUM(round((c.x->>'amount')::numeric
             * fin_private_get_rate(ca.currency_code, (c.x->>'object_id')::uuid, v_on), 2)), 0)
      INTO v_change_base
    FROM jsonb_array_elements(v_canonical_changes) c(x)
    JOIN fin_accounts ca ON ca.id = (c.x->>'account_id')::uuid;
    IF v_exchange_base > v_change_base * 1.02 THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = format('Принято под сдачу (%s ₹) больше самой сдачи (%s ₹)', v_exchange_base, v_change_base);
    END IF;
  END IF;

  n := jsonb_array_length(v_canonical_rows);
  v_bases := array_fill(NULL::numeric, ARRAY[n]);
  v_rates := array_fill(NULL::numeric, ARRAY[n]);
  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_kind := (r->>'participant_balance_kind')::fin_participant_balance_kind;
    v_rate := NULL;
    -- Чек-лист ВГ v3, п.1: цена блока в CRM задана отдельно по каждой валюте
    IF v_acc.currency_code <> 'INR'
       AND COALESCE(r->>'rate_mode', 'crm_price') = 'crm_price'
       AND v_kind IN ('org_fee', 'accommodation', 'meals') THEN
      SELECT * INTO v_price FROM fin_private_crm_block_rate(
        (r->>'participant_id')::uuid, (r->>'object_id')::uuid, v_kind::text, v_acc.currency_code);
      IF v_price.price_cur IS NOT NULL THEN
        v_rate := v_price.price_inr / v_price.price_cur;
        v_base := round(((r->>'amount')::numeric) * v_rate, 2);
      END IF;
    END IF;
    IF v_rate IS NULL THEN
      v_rate := fin_private_get_rate(v_acc.currency_code, (r->>'object_id')::uuid, v_on);
      v_base := round(((r->>'amount')::numeric) * v_rate, 2);
    END IF;
    v_rates[i + 1] := v_rate;
    v_bases[i + 1] := v_base;
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

  -- принято под сдачу: приход в валюте гостя, на долг не влияет (none)
  FOR i IN 0 .. jsonb_array_length(v_canonical_exchanges) - 1
  LOOP
    r := v_canonical_exchanges->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_obj := (r->>'object_id')::uuid;
    v_rate := fin_private_get_rate(v_acc.currency_code, v_obj, v_on);
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, object_id,
      is_post_close, participant_id, participant_balance_kind, payment_channel
    ) VALUES (
      (r->>'id')::uuid, v_request_id, v_acc.id, 'in',
      (r->>'amount')::numeric, v_acc.currency_code,
      round(((r->>'amount')::numeric) * v_rate, 2), v_rate,
      v_exchange_category, v_obj,
      (v_closed_objects IS NOT NULL AND v_obj = ANY (v_closed_objects)),
      (r->>'participant_id')::uuid,
      'none'::fin_participant_balance_kind,
      CASE WHEN r->>'payment_channel' IS NULL THEN NULL
           ELSE (r->>'payment_channel')::fin_payment_channel END
    );
  END LOOP;

  -- сдача: по строке на каждую валюту, все — расходом из своей кассы
  FOR i IN 0 .. jsonb_array_length(v_canonical_changes) - 1
  LOOP
    r := v_canonical_changes->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_obj := (r->>'object_id')::uuid;
    -- живые наличные: из реального счёта нельзя выдать больше остатка
    SELECT COALESCE(SUM((x->>'amount')::numeric), 0) INTO v_out_total
    FROM jsonb_array_elements(v_canonical_changes) AS x
    WHERE (x->>'account_id')::uuid = v_acc.id;
    v_balance := fin_private_account_balance(v_acc.id);
    IF v_acc.kind = 'real' AND v_balance - v_out_total < 0 THEN
      RAISE EXCEPTION 'insufficient_funds'
        USING DETAIL = format('Счёт «%s»: остаток %s, сдача %s', v_acc.name, v_balance, v_out_total);
    END IF;
    v_rate := fin_private_get_rate(v_acc.currency_code, v_obj, v_on);
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, object_id,
      is_post_close, participant_id, participant_balance_kind, payment_channel
    ) VALUES (
      (r->>'id')::uuid, v_request_id, v_acc.id, 'out',
      (r->>'amount')::numeric, v_acc.currency_code,
      round(((r->>'amount')::numeric) * v_rate, 2), v_rate,
      v_change_category, v_obj,
      (v_closed_objects IS NOT NULL AND v_obj = ANY (v_closed_objects)),
      (r->>'participant_id')::uuid,
      'none'::fin_participant_balance_kind,   -- сдача не относится к блоку
      CASE WHEN r->>'payment_channel' IS NULL THEN NULL
           ELSE (r->>'payment_channel')::fin_payment_channel END
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
$function$;
