-- 400: Чек-лист ВГ v3 (курсы, кассы, сдача), серверная часть.
--
-- 1. Платёж в валюте, у которой в CRM задана своя цена блока (оргвзнос/проживание/
--    питание), сверяется напрямую с этой ценой: 24 000 ₽ при цене 25 000 ₹ / 24 000 ₽
--    зачисляется как 25 000 ₹, а не конвертируется по курсу ретрита (пункт 1).
--    Клиент может явно запросить курс ретрита (rate_mode='retreat') — для доплаты
--    остатка другой валютой (пункт 6).
-- 2. «Сдача» — out-проводка внутри платёжной операции (payload.change): деньги
--    физически возвращаются гостю из кассы, баланс участника уменьшается (пункт 2).
-- 3. Новые статьи: «Сдача участнику» (out) и «Пожертвование от участника» (in —
--    для излишка, оставленного как пожертвование, пункт 3).
-- 4. Возврат возможен только с приходной проводки (сдачу нельзя «вернуть»).

-- ==================== СТАТЬИ ====================
insert into fin_categories (code, name, direction, visible_to_departments, is_active)
values ('participant_change', 'Сдача участнику', 'out', false, true)
on conflict (code) do nothing;

insert into fin_categories (code, name, direction, visible_to_departments, is_active)
values ('participant_donation', 'Пожертвование от участника', 'in', false, true)
on conflict (code) do nothing;

-- ==================== ЦЕНА БЛОКА ИЗ CRM ====================
-- Цена блока в валюте платежа и в рупиях — из расчёта участия последней живой
-- сделки. NULL-пара = цены нет (нет сделки, нет прайса, блок бесплатный) —
-- вызывающий падает обратно на курс ретрита.
create or replace function fin_private_crm_block_rate(
  p_participant uuid, p_object uuid, p_kind text, p_currency text,
  out price_cur numeric, out price_inr numeric)
 language plpgsql stable security definer
 set search_path to 'public'
as $$
declare
  v_retreat uuid;
  v_deal uuid;
  v_calc jsonb;
begin
  select retreat_id into v_retreat from fin_accounting_objects where id = p_object;
  if v_retreat is null then return; end if;
  select id into v_deal from crm_deals
   where vaishnava_id = p_participant and retreat_id = v_retreat and status <> 'cancelled'
   order by updated_at desc limit 1;
  if v_deal is null then return; end if;
  v_calc := crm_calc_participation(v_deal);
  if not coalesce((v_calc->>'ok')::boolean, false) then return; end if;
  price_cur := nullif(v_calc->'blocks'->p_kind->'final'->>p_currency, '')::numeric;
  price_inr := nullif(v_calc->'blocks'->p_kind->'final'->>'INR', '')::numeric;
  if price_cur is null or price_inr is null or price_cur <= 0 or price_inr <= 0 then
    price_cur := null; price_inr := null;
  end if;
end $$;

-- ==================== ГАРД ПРОВОДОК ====================
-- Платёж по-прежнему принимает деньги (in), с единственным исключением: сдача —
-- out-проводка со статьёй «Сдача участнику», обязательно с участником и блоком.
CREATE OR REPLACE FUNCTION public.fin_postings_validate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op   fin_operations%ROWTYPE;
  v_acc  fin_accounts%ROWTYPE;
  v_cat_direction fin_direction;
  v_cat_code text;
BEGIN
  SELECT * INTO v_op FROM fin_operations WHERE id = NEW.operation_id;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;

  IF NEW.currency_code <> v_acc.currency_code THEN
    RAISE EXCEPTION 'account_currency_mismatch'
      USING DETAIL = 'Валюта проводки не совпадает с валютой счёта';
  END IF;

  IF NEW.refund_of_posting_id IS NOT NULL AND v_op.type <> 'refund' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'refund_of_posting_id допустим только для refund';
  END IF;

  IF v_op.type IN ('transfer', 'opening', 'reconciliation_adjustment') THEN
    IF NEW.category_id IS NOT NULL OR NEW.cost_center_id IS NOT NULL OR NEW.object_id IS NOT NULL
       OR NEW.participant_id IS NOT NULL OR NEW.participant_balance_kind IS NOT NULL
       OR NEW.contractor_id IS NOT NULL OR NEW.payment_channel IS NOT NULL THEN
      RAISE EXCEPTION 'technical_posting_no_analytics'
        USING DETAIL = 'Технические проводки не несут аналитику';
    END IF;
    IF v_op.type = 'opening' AND NEW.direction = 'out'
       AND v_acc.kind = 'real' AND v_acc.reconciliation_mode = 'cash_count' THEN
      RAISE EXCEPTION 'negative_cash_opening_forbidden'
        USING DETAIL = 'Расходный opening запрещён для наличного реального счёта';
    END IF;
  ELSIF v_op.type = 'reversal' THEN
    NULL;
  ELSE
    IF NEW.category_id IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья обязательна для ' || v_op.type;
    END IF;
    SELECT direction, code INTO v_cat_direction, v_cat_code FROM fin_categories WHERE id = NEW.category_id;
    IF v_op.type IN ('payment', 'income', 'donation') THEN
      IF v_op.type = 'payment' AND NEW.direction = 'out' THEN
        -- сдача наличными: единственная допустимая out-проводка платежа
        IF v_cat_code <> 'participant_change' THEN
          RAISE EXCEPTION 'invalid_payload'
            USING DETAIL = 'Out-проводка платежа допустима только со статьёй «Сдача участнику»';
        END IF;
        IF NEW.participant_id IS NULL OR NEW.participant_balance_kind IS NULL
           OR NEW.participant_balance_kind = 'none' THEN
          RAISE EXCEPTION 'invalid_payload'
            USING DETAIL = 'Сдача требует участника и блока баланса';
        END IF;
      ELSE
        IF NEW.direction <> 'in' THEN
          RAISE EXCEPTION 'invalid_payload' USING DETAIL = v_op.type || ' допускает только in-проводки';
        END IF;
        IF v_cat_direction <> 'in' THEN
          RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья направления out недопустима для ' || v_op.type;
        END IF;
      END IF;
    ELSIF v_op.type IN ('expense', 'refund') THEN
      IF NEW.direction <> 'out' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = v_op.type || ' допускает только out-проводки';
      END IF;
      IF v_cat_direction <> 'out' THEN
        RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Статья направления in недопустима для ' || v_op.type;
      END IF;
    END IF;
    IF v_op.type IN ('expense', 'income', 'donation')
       AND NEW.participant_id IS NOT NULL AND NEW.participant_balance_kind <> 'none' THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'Для expense/income/donation с участником допустим только balance_kind = none';
    END IF;
    IF v_op.type = 'refund' AND NEW.refund_of_posting_id IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'refund требует refund_of_posting_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ==================== ПЛАТЁЖ ====================
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
  v_canonical_change jsonb := NULL;
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

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'occurred_on', 'payer_contact_id', 'comment', 'reason', 'rows', 'change']);
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

  -- Сдача: сколько наличных вернулось гостю в рамках этой же операции
  v_change := payload->'change';
  IF v_change IS NOT NULL AND jsonb_typeof(v_change) = 'object' THEN
    PERFORM fin_private_assert_keys(v_change, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'participant_balance_kind', 'payment_channel']);
    BEGIN
      v_kind := (v_change->>'participant_balance_kind')::fin_participant_balance_kind;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'change.participant_balance_kind: org_fee | accommodation | meals | extra | general';
    END;
    IF v_kind = 'none' THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Сдача относится к блоку баланса участника';
    END IF;
    v_canonical_change := jsonb_build_object(
      'id', lower(fin_private_get_uuid(v_change, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(v_change, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(v_change, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(v_change, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(v_change, 'object_id', true)::text),
      'participant_balance_kind', v_kind,
      'payment_channel', NULLIF(v_change->>'payment_channel', ''));
  ELSIF v_change IS NOT NULL AND jsonb_typeof(v_change) <> 'null' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'change: ожидается объект';
  END IF;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_payment',
    'occurred_on', v_on,
    'payer_contact_id', lower(v_payer::text),
    'comment', v_comment,
    'reason', v_reason,
    'rows', v_canonical_rows,
    'change', v_canonical_change
  ));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  SELECT array_agg(DISTINCT (x->>'object_id')::uuid),
         array_agg(DISTINCT (x->>'account_id')::uuid)
    INTO v_objects, v_accounts
  FROM (
    SELECT * FROM jsonb_array_elements(v_canonical_rows) AS y(x)
    UNION ALL
    SELECT v_canonical_change WHERE v_canonical_change IS NOT NULL
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
      SELECT * FROM jsonb_array_elements(v_canonical_rows) AS y(x)
      UNION ALL
      SELECT v_canonical_change WHERE v_canonical_change IS NOT NULL
    ) z(x)
    LEFT JOIN vaishnavas v ON v.id = (z.x->>'participant_id')::uuid
    WHERE v.id IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден';
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
    -- Чек-лист ВГ v3, п.1: у 4 основных валют цена блока задана в CRM напрямую —
    -- платёж в такой валюте сверяется с ней, а не с курсом ретрита. Курс ретрита
    -- остаётся для остатка в другой валюте (rate_mode='retreat') и валют без цены.
    IF v_acc.currency_code <> 'INR'
       AND COALESCE(r->>'rate_mode', 'crm_price') = 'crm_price'
       AND v_kind IN ('org_fee', 'accommodation', 'meals') THEN
      SELECT * INTO v_price FROM fin_private_crm_block_rate(
        (r->>'participant_id')::uuid, (r->>'object_id')::uuid, v_kind::text, v_acc.currency_code);
      IF v_price.price_cur IS NOT NULL THEN
        v_rate := round(v_price.price_inr / v_price.price_cur, 6);
        v_base := round(((r->>'amount')::numeric) * v_price.price_inr / v_price.price_cur, 2);
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

  IF v_canonical_change IS NOT NULL THEN
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (v_canonical_change->>'account_id')::uuid;
    v_obj := (v_canonical_change->>'object_id')::uuid;
    -- сдача — живые наличные: из реального счёта нельзя выдать больше остатка
    v_balance := fin_private_account_balance(v_acc.id);
    IF v_acc.kind = 'real' AND v_balance - (v_canonical_change->>'amount')::numeric < 0 THEN
      RAISE EXCEPTION 'insufficient_funds'
        USING DETAIL = format('Счёт «%s»: остаток %s, сдача %s', v_acc.name, v_balance, v_canonical_change->>'amount');
    END IF;
    v_rate := fin_private_get_rate(v_acc.currency_code, v_obj, v_on);
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, object_id,
      is_post_close, participant_id, participant_balance_kind, payment_channel
    ) VALUES (
      (v_canonical_change->>'id')::uuid, v_request_id, v_acc.id, 'out',
      (v_canonical_change->>'amount')::numeric, v_acc.currency_code,
      round(((v_canonical_change->>'amount')::numeric) * v_rate, 2), v_rate,
      v_change_category, v_obj,
      (v_closed_objects IS NOT NULL AND v_obj = ANY (v_closed_objects)),
      (v_canonical_change->>'participant_id')::uuid,
      (v_canonical_change->>'participant_balance_kind')::fin_participant_balance_kind,
      CASE WHEN v_canonical_change->>'payment_channel' IS NULL THEN NULL
           ELSE (v_canonical_change->>'payment_channel')::fin_payment_channel END
    );
  END IF;

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

-- ==================== ВОЗВРАТ: ТОЛЬКО С ПРИХОДНОЙ ПРОВОДКИ ====================
-- Патч точечный: после загрузки исходной проводки убеждаемся, что она приходная
-- (сдача — out-проводка платежа, и «возврат сдачи» не имеет смысла).
do $$
declare
  src text := pg_get_functiondef('fin_create_refund(jsonb)'::regprocedure);
  anchor text := 'IF v_orig_op.type <> ''payment'' THEN';
begin
  if position(anchor in src) = 0 then
    raise exception 'fin_create_refund: якорь для патча не найден';
  end if;
  src := replace(src, anchor,
    'IF v_orig.direction <> ''in'' THEN
    RAISE EXCEPTION ''refund_source_invalid'' USING DETAIL = ''Возврат возможен только с приходной проводки'';
  END IF;
  ' || anchor);
  execute src;
end $$;

-- ==================== ИСТОРИЯ ПЛАТЕЖЕЙ: НАПРАВЛЕНИЕ ====================
-- direction нужен интерфейсу, чтобы показать сдачу как «выдано», и защите,
-- чтобы не предлагать возврат с out-проводки.
do $$
declare
  src text := pg_get_functiondef('fin_private_participant_payments(uuid,uuid)'::regprocedure);
  anchor1 text := '''operation_id'', p.operation_id,';
  anchor2 text := '''available_to_refund'', CASE WHEN o.type = ''payment'' AND NOT o.is_reversed THEN p.amount - n.net_amount ELSE 0 END';
begin
  if position(anchor1 in src) = 0 or position(anchor2 in src) = 0 then
    raise exception 'fin_private_participant_payments: якорь для патча не найден';
  end if;
  src := replace(src, anchor1, anchor1 || '
      ''direction'', p.direction,');
  src := replace(src, anchor2,
    '''available_to_refund'', CASE WHEN o.type = ''payment'' AND NOT o.is_reversed AND p.direction = ''in'' THEN p.amount - n.net_amount ELSE 0 END');
  execute src;
end $$;

-- ==================== ПЕРЕВОДЫ ====================
insert into translations (key, ru, en, hi, context)
values
  ('fin_block_remaining', 'Остаток по блоку', 'Block remaining', 'ब्लॉक शेष', 'finance'),
  ('fin_rate_by_crm', 'по прайсу CRM', 'at CRM price', 'CRM मूल्य के अनुसार', 'finance'),
  ('fin_rate_by_retreat', 'по курсу ретрита', 'at retreat rate', 'रिट्रीट दर के अनुसार', 'finance'),
  ('fin_change_give', 'Выдать сдачу', 'Give change', 'बाकी पैसे लौटाएँ', 'finance'),
  ('fin_change', 'Сдача', 'Change', 'बाकी', 'finance'),
  ('fin_change_hint', 'Наличные, возвращаемые гостю', 'Cash returned to the guest', 'अतिथि को लौटाई गई नकदी', 'finance'),
  ('fin_keep_as_donation', 'Оставить как пожертвование', 'Keep as donation', 'दान के रूप में रखें', 'finance'),
  ('fin_donation_excess', 'Излишек — пожертвование', 'Excess as donation', 'अधिशेष — दान', 'finance'),
  ('fin_write_off', 'Списать', 'Write off', 'माफ़ करें', 'finance'),
  ('fin_write_off_title', 'Списать остаток долга', 'Write off remaining debt', 'शेष ऋण माफ़ करें', 'finance'),
  ('fin_write_off_reason', 'Причина списания', 'Write-off reason', 'माफ़ी का कारण', 'finance'),
  ('fin_write_off_no_charge', 'Нет начисления, которое покрыло бы списание — используйте «Перерасчёт»', 'No charge can absorb this write-off — use "Recalculation"', 'कोई शुल्क नहीं मिला — «पुनर्गणना» का उपयोग करें', 'finance'),
  ('fin_own_history', 'История платежей', 'Payment history', 'भुगतान इतिहास', 'finance')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, updated_at = now();
