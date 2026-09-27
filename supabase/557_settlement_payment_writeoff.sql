-- Фаза 2, шаги 3–4: списание округления, приём в валюте расчёта (ВГ, 27.09)
--
-- Документ: docs/finance/phase2_debt_in_price_currency.md.
-- Всё новое действует только на события новой системы (без пометки
-- legacy_inr_settlement). Сева-ретрит идёт прежними ветками без изменений.
--
-- 1. fin_settlement_writeoffs — списание долга (не деньги): «Округление курса»
--    при доплате другой валютой, в той же операции, что платёж.
-- 2. fin_private_settlement_currency — валюта расчёта гостя одним местом
--    (выбрана кассиром / первая оплата / ₹).
-- 3. fin_set_settlement_currency — кассир выбирает валюту расчёта: деньги в
--    других валютах засчитываются по курсу ретрита, начисления переводятся.
-- 4. fin_create_payment — новая ветка: курс только ретрита, засчитанная сумма
--    за другую валюту, автосписание в пределах шага.
-- 5. fin_sync_charges_from_crm — начисления в валюте расчёта по ценам CRM.
-- 6. Карточка и список участников — на fin_private_participant_balance_v2.

-- ============ 1. Списания ============
create table fin_settlement_writeoffs (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid references fin_operations(id),   -- платёж, в котором списано
  participant_id uuid not null references vaishnavas(id),
  retreat_id uuid not null references retreats(id),
  kind text not null check (kind in ('org_fee', 'accommodation', 'meals', 'extra')),
  currency_code text not null check (currency_code in ('INR', 'RUB', 'USD', 'EUR')),
  amount numeric(14, 2) not null check (amount > 0),
  reason text not null,
  created_at timestamptz not null default now(),
  created_by uuid not null
);
create index fin_settlement_writeoffs_pair on fin_settlement_writeoffs (participant_id, retreat_id);
alter table fin_settlement_writeoffs enable row level security;
comment on table fin_settlement_writeoffs is
  'Списание долга участника в валюте расчёта (фаза 2): округление курса при доплате другой валютой. Отменяется вместе с операцией.';

create or replace function fin_settlement_writeoffs_immutable() returns trigger
language plpgsql set search_path to 'public' as $$
begin
  raise exception 'fin_settlement_writeoffs_immutable'
    using detail = 'Списания не меняются и не удаляются — отменяется операция';
end;
$$;
create trigger fin_settlement_writeoffs_immutable
  before update or delete on fin_settlement_writeoffs
  for each row execute function fin_settlement_writeoffs_immutable();

-- ============ 2. Валюта расчёта гостя ============
-- Выбрана кассиром; иначе валюта первой оплаты (стартовые остатки из CRM
-- раньше приёмов); без оплат — ₹ (ВГ, 27.09)
create or replace function fin_private_settlement_currency(p_participant uuid, p_retreat uuid,
  out o_currency text, out o_source text)
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_obj uuid;
begin
  select currency_code into o_currency from fin_participant_settlements
   where participant_id = p_participant and retreat_id = p_retreat;
  if o_currency is not null then o_source := 'chosen'; return; end if;
  select id into v_obj from fin_accounting_objects where retreat_id = p_retreat;
  select c into o_currency from (
    select b.currency_code c, 0 ord, b.created_at::date d, 0::bigint seq
      from fin_participant_opening_balances b
     where b.participant_id = p_participant and b.retreat_id = p_retreat and b.kind = 'credit'
    union all
    select p.currency_code, 1, o.occurred_on, p.ledger_seq
      from fin_postings p join fin_operations o on o.id = p.operation_id
     where p.participant_id = p_participant and p.object_id = v_obj and p.direction = 'in'
       and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
       and not o.is_reversed and o.type <> 'reversal'
  ) x order by ord, d, seq limit 1;
  o_source := case when o_currency is null then 'default' else 'first_payment' end;
  o_currency := coalesce(o_currency, 'INR');
end;
$$;

-- ============ 3. Долг в валюте расчёта (+ списания) ============
create or replace function fin_private_participant_balance_v2(p_participant uuid, p_retreat uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_obj uuid;
  v_legacy boolean;
  v_cur text;
  v_cur_source text := 'chosen';
  v_blocks text[] := array['org_fee', 'accommodation', 'meals', 'extra'];
  v_charges numeric[] := array[0, 0, 0, 0];
  v_open_debt numeric[] := array[0, 0, 0, 0];
  v_open_credit numeric[] := array[0, 0, 0, 0];
  v_signed numeric[] := array[0, 0, 0, 0];
  v_block_debt numeric[] := array[0, 0, 0, 0];
  v_general_debt numeric := 0;
  v_general_credit numeric := 0;
  v_general_signed numeric := 0;
  v_remaining numeric;
  v_apply numeric;
  v_total_debt numeric := 0;
  v_total_advance numeric := 0;
  v_offset numeric[] := array[0, 0, 0, 0];
  v_donor int; v_taker int;
  v_sum_charges numeric := 0;
  v_sum_open numeric := 0;
  v_sum_signed numeric := 0;
  v_problems jsonb := '[]'::jsonb;
  v_result jsonb := '{}'::jsonb;
  v_amt numeric;
  v_written numeric[] := array[0, 0, 0, 0];
  v_sum_written numeric := 0;
  v_writeoffs jsonb := '[]'::jsonb;
  i int;
  rec record;
begin
  select id, legacy_inr_settlement into v_obj, v_legacy
    from fin_accounting_objects where retreat_id = p_retreat;
  if v_legacy then
    return fin_private_participant_balance(p_participant, p_retreat)
           || jsonb_build_object('currency', 'INR', 'system', 'legacy_inr');
  end if;

  select o_currency, o_source into v_cur, v_cur_source
    from fin_private_settlement_currency(p_participant, p_retreat);

  -- Начисления — только в валюте расчёта
  for rec in
    select kind::text as k, currency_code as c, sum(amount - discount_amount) as s
      from fin_charges
     where participant_id = p_participant and retreat_id = p_retreat and not is_cancelled
     group by kind, currency_code
  loop
    if rec.c <> v_cur then
      v_problems := v_problems || jsonb_build_array(jsonb_build_object(
        'code', 'charge_foreign_currency',
        'message', format('Начисление «%s» в %s, а валюта расчёта %s', rec.k, rec.c, v_cur)));
      continue;
    end if;
    i := array_position(v_blocks, rec.k);
    if i is not null then v_charges[i] := v_charges[i] + rec.s; end if;
    v_sum_charges := v_sum_charges + rec.s;
  end loop;

  -- Стартовые остатки: своя валюта 1:1, чужая — через засчитанную сумму
  for rec in
    select b.id, b.balance_kind::text as bk, b.kind::text as k, b.currency_code as c, b.amount,
           (select sc.settle_amount from fin_settlement_credits sc
             where sc.opening_id = b.id and sc.settle_currency = v_cur) as credited
      from fin_participant_opening_balances b
     where b.participant_id = p_participant and b.retreat_id = p_retreat
  loop
    if rec.c = v_cur then
      v_amt := rec.amount;
    elsif rec.credited is not null then
      v_amt := rec.credited;
    else
      v_problems := v_problems || jsonb_build_array(jsonb_build_object(
        'code', 'unconverted_opening', 'id', rec.id,
        'message', format('Стартовый остаток %s %s не засчитан в %s', rec.amount, rec.c, v_cur)));
      continue;
    end if;
    if rec.bk = 'general' then
      if rec.k = 'debt' then v_general_debt := v_general_debt + v_amt;
      else v_general_credit := v_general_credit + v_amt; end if;
    else
      i := array_position(v_blocks, rec.bk);
      if i is not null then
        if rec.k = 'debt' then v_open_debt[i] := v_open_debt[i] + v_amt;
        else v_open_credit[i] := v_open_credit[i] + v_amt; end if;
      end if;
    end if;
    v_sum_open := v_sum_open + case rec.k when 'debt' then v_amt else -v_amt end;
  end loop;

  -- Платежи: своя валюта 1:1, чужая — через засчитанную сумму.
  -- Отменённая операция и её сторно гасят друг друга в одной валюте (сторно
  -- всегда полное) — пропускаем пару, иначе обе строки дали бы ложное
  -- «не засчитан»
  for rec in
    select p.id, p.participant_balance_kind::text as bk, p.currency_code as c, p.amount,
           case p.direction when 'in' then 1 else -1 end as sgn,
           (select sc.settle_amount from fin_settlement_credits sc
             where sc.posting_id = p.id and sc.settle_currency = v_cur) as credited
      from fin_postings p join fin_operations o on o.id = p.operation_id
     where p.participant_id = p_participant and p.object_id = v_obj
       and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
       and not o.is_reversed and o.type <> 'reversal'
  loop
    if rec.c = v_cur then
      v_amt := rec.sgn * rec.amount;
    elsif rec.credited is not null then
      v_amt := rec.sgn * rec.credited;
    else
      v_problems := v_problems || jsonb_build_array(jsonb_build_object(
        'code', 'unconverted_payment', 'id', rec.id,
        'message', format('Платёж %s %s не засчитан в %s', rec.amount, rec.c, v_cur)));
      continue;
    end if;
    if rec.bk = 'general' then
      v_general_signed := v_general_signed + v_amt;
    else
      i := array_position(v_blocks, rec.bk);
      if i is not null then v_signed[i] := v_signed[i] + v_amt; end if;
    end if;
    v_sum_signed := v_sum_signed + v_amt;
  end loop;

  -- Списания (округление курса при доплате другой валютой, миграция 557):
  -- не деньги, а уменьшение долга блока в валюте расчёта. Списание отменённой
  -- операции не действует — отменяется вместе с платежом
  for rec in
    select w.id, w.kind, w.currency_code as c, w.amount, w.reason, w.created_at, w.operation_id
      from fin_settlement_writeoffs w
      left join fin_operations o on o.id = w.operation_id
     where w.participant_id = p_participant and w.retreat_id = p_retreat
       and (o.id is null or not o.is_reversed)
     order by w.created_at
  loop
    if rec.c <> v_cur then
      v_problems := v_problems || jsonb_build_array(jsonb_build_object(
        'code', 'writeoff_foreign_currency', 'id', rec.id,
        'message', format('Списание %s %s, а валюта расчёта %s', rec.amount, rec.c, v_cur)));
      continue;
    end if;
    i := array_position(v_blocks, rec.kind);
    v_written[i] := v_written[i] + rec.amount;
    v_sum_written := v_sum_written + rec.amount;
    v_writeoffs := v_writeoffs || jsonb_build_array(jsonb_build_object(
      'id', rec.id, 'kind', rec.kind, 'amount', rec.amount, 'currency_code', rec.c,
      'reason', rec.reason, 'created_at', rec.created_at, 'operation_id', rec.operation_id));
  end loop;

  -- Дальше — тот же разбор по блокам, что в fin_private_participant_balance
  for i in 1 .. 4 loop
    v_block_debt[i] := v_charges[i] + v_open_debt[i] - v_open_credit[i] - v_signed[i] - v_written[i];
  end loop;

  v_apply := least(v_general_credit, greatest(v_general_debt, 0));
  v_general_credit := v_general_credit - v_apply;
  v_general_debt := v_general_debt - v_apply;
  v_remaining := v_general_credit + v_general_signed;
  for i in 1 .. 4 loop
    v_apply := least(v_remaining, greatest(v_block_debt[i], 0));
    v_block_debt[i] := v_block_debt[i] - v_apply;
    v_remaining := v_remaining - v_apply;
  end loop;
  v_apply := least(v_remaining, greatest(v_general_debt, 0));
  v_general_debt := v_general_debt - v_apply;
  v_remaining := v_remaining - v_apply;

  for v_donor in 1 .. 4 loop
    if v_block_debt[v_donor] >= 0 then continue; end if;
    for v_taker in 1 .. 4 loop
      exit when v_block_debt[v_donor] >= 0;
      if v_block_debt[v_taker] <= 0 then continue; end if;
      v_apply := least(-v_block_debt[v_donor], v_block_debt[v_taker]);
      v_block_debt[v_donor] := v_block_debt[v_donor] + v_apply;
      v_block_debt[v_taker] := v_block_debt[v_taker] - v_apply;
      v_offset[v_taker] := v_offset[v_taker] + v_apply;
    end loop;
  end loop;

  for i in 1 .. 4 loop
    v_total_debt := v_total_debt + greatest(v_block_debt[i], 0);
    v_total_advance := v_total_advance + greatest(-v_block_debt[i], 0);
  end loop;
  v_total_debt := v_total_debt + greatest(v_general_debt, 0);
  v_total_advance := v_total_advance + v_remaining;

  for i in 1 .. 4 loop
    v_result := v_result || jsonb_build_object(v_blocks[i], jsonb_build_object(
      'charged', v_charges[i] + v_open_debt[i],
      'paid', v_signed[i] + v_open_credit[i],
      'balance', v_block_debt[i],
      'offset', v_offset[i],
      'written_off', v_written[i]
    ));
  end loop;

  return jsonb_build_object(
    'system', 'settlement_currency',
    'currency', v_cur,
    'currency_source', v_cur_source,
    'blocks', v_result,
    'general_debt', greatest(v_general_debt, 0),
    'general_advance', v_remaining,
    'total_debt', v_total_debt,
    'total_advance', v_total_advance,
    'net', v_total_debt - v_total_advance,
    'quick_net', v_sum_charges + v_sum_open - v_sum_signed - v_sum_written,
    'writeoffs', v_writeoffs,
    'problems', v_problems
  );
end;
$$;

-- ============ Платёж участника: новая ветка ============
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
  v_donation jsonb;                        -- излишек в дар: {comment, rows}
  v_donation_res jsonb;
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
  -- новая система (валюта расчёта, миграция 557)
  v_row jsonb;
  v_ret uuid;
  v_legacy boolean;
  v_settle text;
  v_settle_src text;
  v_rate_to numeric;
  v_expected numeric;
  v_settles numeric[];
  v_writeoffs jsonb := '[]'::jsonb;
  v_canonical_writeoffs jsonb := '[]'::jsonb;
  v_limit numeric;
  v_bal jsonb;
  v_pair record;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Платёж участника проводит только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'occurred_on', 'payer_contact_id', 'comment', 'reason', 'rows', 'change', 'exchange', 'donation', 'writeoff']);
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
    PERFORM fin_private_assert_keys(r, ARRAY['id', 'account_id', 'amount', 'participant_id', 'object_id', 'participant_balance_kind', 'payment_channel', 'rate_mode', 'settle_amount']);
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
    v_row := jsonb_build_object(
      'id', lower(fin_private_get_uuid(r, 'id', true)::text),
      'account_id', lower(fin_private_get_uuid(r, 'account_id', true)::text),
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true)),
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'participant_balance_kind', v_kind,
      'payment_channel', NULLIF(r->>'payment_channel', ''),
      'rate_mode', NULLIF(r->>'rate_mode', '')
    );
    -- засчитано в валюте расчёта (новая система, другая валюта) — в хеше
    -- только когда есть: хеши прежних платежей не меняются
    IF NULLIF(r->>'settle_amount', '') IS NOT NULL THEN
      v_row := v_row || jsonb_build_object('settle_amount',
        fin_private_norm_money(fin_private_get_money(r, 'settle_amount', true)));
    END IF;
    v_canonical_rows := v_canonical_rows || jsonb_build_array(v_row);
  END LOOP;

  -- Автосписание округления курса (новая система, ВГ 27.09): недостача при
  -- доплате другой валютой в пределах шага списывается в той же операции
  IF payload->'writeoff' IS NOT NULL AND jsonb_typeof(payload->'writeoff') = 'array' THEN
    v_writeoffs := payload->'writeoff';
  ELSIF payload->'writeoff' IS NOT NULL AND jsonb_typeof(payload->'writeoff') <> 'null' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'writeoff: ожидается массив';
  END IF;
  FOR r IN SELECT x.val FROM jsonb_array_elements(v_writeoffs) AS x(val)
           ORDER BY x.val->>'participant_id', x.val->>'participant_balance_kind'
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['participant_id', 'object_id', 'participant_balance_kind', 'amount']);
    IF COALESCE(r->>'participant_balance_kind', '') NOT IN ('org_fee', 'accommodation', 'meals', 'extra') THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'writeoff.participant_balance_kind: org_fee | accommodation | meals | extra';
    END IF;
    v_canonical_writeoffs := v_canonical_writeoffs || jsonb_build_array(jsonb_build_object(
      'participant_id', lower(fin_private_get_uuid(r, 'participant_id', true)::text),
      'object_id', lower(fin_private_get_uuid(r, 'object_id', true)::text),
      'participant_balance_kind', r->>'participant_balance_kind',
      'amount', fin_private_norm_money(fin_private_get_money(r, 'amount', true))));
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

  -- Излишек в дар проводится в той же транзакции, что и платёж (ВГ, 27.09):
  -- раньше это был второй запрос с браузера, и при его сбое излишек
  -- не попадал в кассу, хотя лежал в коробке
  v_donation := payload->'donation';
  IF v_donation IS NOT NULL AND jsonb_typeof(v_donation) = 'null' THEN
    v_donation := NULL;
  END IF;
  IF v_donation IS NOT NULL AND (jsonb_typeof(v_donation) <> 'object'
       OR jsonb_typeof(v_donation->'rows') <> 'array' OR jsonb_array_length(v_donation->'rows') = 0) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'donation: ожидается объект {comment, rows}';
  END IF;

  -- ключи exchange и donation в хеше только когда они есть: хеши прежних платежей не меняются
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
  IF v_donation IS NOT NULL THEN
    v_hash_payload := v_hash_payload || jsonb_build_object('donation', v_donation);
  END IF;
  IF jsonb_array_length(v_canonical_writeoffs) > 0 THEN
    v_hash_payload := v_hash_payload || jsonb_build_object('writeoff', v_canonical_writeoffs);
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

  -- Новая система: валюта расчёта гостя фиксируется первым приёмом. Кассир
  -- выбирает её в карточке заранее (fin_set_settlement_currency); если не
  -- выбрал — валюта первой оплаты, а у гостя без денег — валюта первой строки
  -- этого платежа (в порядке формы)
  FOR v_pair IN
    SELECT DISTINCT (x->>'participant_id')::uuid AS pid, (x->>'object_id')::uuid AS obj
      FROM jsonb_array_elements(v_canonical_rows) AS x
  LOOP
    SELECT retreat_id, legacy_inr_settlement INTO v_ret, v_legacy
      FROM fin_accounting_objects WHERE id = v_pair.obj;
    IF v_ret IS NULL OR v_legacy THEN CONTINUE; END IF;
    IF EXISTS (SELECT 1 FROM fin_participant_settlements
                WHERE participant_id = v_pair.pid AND retreat_id = v_ret) THEN CONTINUE; END IF;
    SELECT o_currency, o_source INTO v_settle, v_settle_src
      FROM fin_private_settlement_currency(v_pair.pid, v_ret);
    IF v_settle_src = 'default' THEN
      SELECT a.currency_code INTO v_settle
        FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS y(x, ord)
        JOIN fin_accounts a ON a.id = (y.x->>'account_id')::uuid
       WHERE (y.x->>'participant_id')::uuid = v_pair.pid AND (y.x->>'object_id')::uuid = v_pair.obj
       ORDER BY y.ord LIMIT 1;
    END IF;
    PERFORM fin_private_apply_settlement_currency(v_pair.pid, v_ret, v_settle, v_on, v_actor);
  END LOOP;

  n := jsonb_array_length(v_canonical_rows);
  v_bases := array_fill(NULL::numeric, ARRAY[n]);
  v_rates := array_fill(NULL::numeric, ARRAY[n]);
  v_settles := array_fill(NULL::numeric, ARRAY[n]);
  FOR i IN 0 .. n - 1
  LOOP
    r := v_canonical_rows->i;
    SELECT * INTO v_acc FROM fin_accounts WHERE id = (r->>'account_id')::uuid;
    v_kind := (r->>'participant_balance_kind')::fin_participant_balance_kind;
    v_rate := NULL;
    SELECT retreat_id, legacy_inr_settlement INTO v_ret, v_legacy
      FROM fin_accounting_objects WHERE id = (r->>'object_id')::uuid;
    IF v_ret IS NOT NULL AND NOT v_legacy THEN
      -- Новая система: в ₹ — только для отчётов, по курсу ретрита (без общего
      -- курса: нет курса ретрита — приём не проходит). Долг гостя уменьшается
      -- в валюте расчёта: своя валюта 1:1, другая — засчитанной суммой
      v_rate := fin_private_retreat_rate(v_acc.currency_code, (r->>'object_id')::uuid, v_on);
      v_base := round(((r->>'amount')::numeric) * v_rate, 2);
      SELECT currency_code INTO v_settle FROM fin_participant_settlements
       WHERE participant_id = (r->>'participant_id')::uuid AND retreat_id = v_ret;
      IF v_acc.currency_code = v_settle THEN
        IF r ? 'settle_amount' THEN
          RAISE EXCEPTION 'invalid_payload'
            USING DETAIL = 'settle_amount передаётся только для оплаты в другой валюте';
        END IF;
      ELSE
        -- Один пересчёт на операцию по курсу ретрита. Форма передаёт ровно
        -- остаток долга, а не «сумма × курс» — центы валюты платежа дают
        -- расхождение до полцента по курсу, больше — ошибка
        v_rate_to := fin_private_retreat_rate(v_settle, (r->>'object_id')::uuid, v_on);
        v_expected := ((r->>'amount')::numeric) * v_rate / v_rate_to;
        IF r ? 'settle_amount' THEN
          v_settles[i + 1] := (r->>'settle_amount')::numeric;
          IF abs(v_settles[i + 1] - v_expected) > 0.005 * v_rate / v_rate_to + 0.01 THEN
            RAISE EXCEPTION 'settle_amount_mismatch'
              USING DETAIL = format('Засчитано %s %s, а по курсу ретрита %s %s = %s %s',
                v_settles[i + 1], v_settle, r->>'amount', v_acc.currency_code, round(v_expected, 2), v_settle);
          END IF;
        ELSE
          v_settles[i + 1] := round(v_expected, 2);
        END IF;
      END IF;
      v_rates[i + 1] := v_rate;
      v_bases[i + 1] := v_base;
      CONTINUE;
    END IF;
    IF r ? 'settle_amount' THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'Событие на старой системе расчёта: settle_amount не передаётся';
    END IF;
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
    IF v_settles[i + 1] IS NOT NULL THEN
      SELECT retreat_id INTO v_ret FROM fin_accounting_objects WHERE id = v_obj;
      SELECT currency_code INTO v_settle FROM fin_participant_settlements
       WHERE participant_id = (r->>'participant_id')::uuid AND retreat_id = v_ret;
      INSERT INTO fin_settlement_credits (posting_id, participant_id, retreat_id, from_currency, from_amount,
                                          settle_currency, settle_amount, rate_from, rate_to, created_by)
      VALUES ((r->>'id')::uuid, (r->>'participant_id')::uuid, v_ret, v_acc.currency_code, (r->>'amount')::numeric,
              v_settle, v_settles[i + 1], v_rates[i + 1], fin_private_retreat_rate(v_settle, v_obj, v_on), v_actor);
    END IF;
  END LOOP;

  -- Автосписание: только новая система, только если этот же гость платит
  -- здесь другой валютой, и не больше шага округления этой валюты (шаг
  -- сравнивается в валюте, которой платят: ₹100 при расчёте в $ — это $1,05)
  FOR i IN 0 .. jsonb_array_length(v_canonical_writeoffs) - 1
  LOOP
    r := v_canonical_writeoffs->i;
    v_obj := (r->>'object_id')::uuid;
    SELECT retreat_id, legacy_inr_settlement INTO v_ret, v_legacy FROM fin_accounting_objects WHERE id = v_obj;
    IF v_ret IS NULL OR v_legacy THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Автосписание округления — только для событий новой системы';
    END IF;
    SELECT currency_code INTO v_settle FROM fin_participant_settlements
     WHERE participant_id = (r->>'participant_id')::uuid AND retreat_id = v_ret;
    SELECT max(CASE a.currency_code WHEN 'INR' THEN 100 WHEN 'RUB' THEN 100 ELSE 1 END
               * fin_private_retreat_rate(a.currency_code, v_obj, v_on)
               / fin_private_retreat_rate(v_settle, v_obj, v_on))
      INTO v_limit
      FROM jsonb_array_elements(v_canonical_rows) AS x
      JOIN fin_accounts a ON a.id = (x->>'account_id')::uuid
     WHERE x->>'participant_id' = r->>'participant_id' AND x->>'object_id' = r->>'object_id'
       AND a.currency_code <> v_settle;
    IF v_settle IS NULL OR v_limit IS NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Автосписание — только при оплате другой валютой в этой же операции';
    END IF;
    IF (r->>'amount')::numeric > round(v_limit, 2) + 0.01 THEN
      RAISE EXCEPTION 'writeoff_exceeds_step'
        USING DETAIL = format('Недостача %s %s больше шага округления (%s %s) — это недоплата, она остаётся долгом',
          r->>'amount', v_settle, round(v_limit, 2), v_settle);
    END IF;
    INSERT INTO fin_settlement_writeoffs (operation_id, participant_id, retreat_id, kind, currency_code, amount, reason, created_by)
    VALUES (v_request_id, (r->>'participant_id')::uuid, v_ret, r->>'participant_balance_kind', v_settle,
            (r->>'amount')::numeric, 'Округление курса', v_actor);
  END LOOP;
  -- списание не может сделать из долга аванс
  FOR i IN 0 .. jsonb_array_length(v_canonical_writeoffs) - 1
  LOOP
    r := v_canonical_writeoffs->i;
    SELECT retreat_id INTO v_ret FROM fin_accounting_objects WHERE id = (r->>'object_id')::uuid;
    v_bal := fin_private_participant_balance_v2((r->>'participant_id')::uuid, v_ret);
    IF (v_bal->'blocks'->(r->>'participant_balance_kind')->>'balance')::numeric < -0.005 THEN
      RAISE EXCEPTION 'writeoff_exceeds_debt'
        USING DETAIL = format('Списание %s больше остатка долга блока', r->>'amount');
    END IF;
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

  -- дар — отдельная операция, но в этой же транзакции: не прошёл дар —
  -- откатывается и платёж (исключение ловит обработчик ниже)
  IF v_donation IS NOT NULL THEN
    v_donation_res := fin_create_donation(jsonb_build_object(
      'request_id', md5(v_request_id::text || ':donation')::uuid,
      'occurred_on', v_on,
      'payer_contact_id', v_payer,
      'comment', v_donation->>'comment',
      'rows', v_donation->'rows'));
    IF NOT COALESCE((v_donation_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION '%', COALESCE(v_donation_res->'error'->>'code', 'internal_error')
        USING DETAIL = 'Излишек в дар: ' || COALESCE(v_donation_res->'error'->>'message', 'не удалось провести');
    END IF;
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

-- ============ 4. Выбор валюты расчёта ============
-- Фиксирует валюту расчёта гостя и приводит к ней всё, что уже есть:
--   * деньги в других валютах (приёмы, стартовые авансы) засчитываются по
--     курсу ретрита на дату выбора — одна запись на деньги, задним числом не
--     пересчитывается; уже засчитанное в этой валюте не трогается;
--   * начисления из CRM пересобираются синком в новой валюте по ценам CRM;
--   * ручные начисления переводятся по курсу ретрита (отмена + новое, с
--     записью «было → стало»).
-- Нет курса ретрита — вся операция не проходит (retreat_rate_missing).
create or replace function fin_private_apply_settlement_currency(p_participant uuid, p_retreat uuid,
  p_currency text, p_on date, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_obj uuid;
  v_legacy boolean;
  v_rate_to numeric;
  v_rate_from numeric;
  v_credits int := 0;
  v_converted int := 0;
  v_amount numeric;
  v_discount numeric;
  v_sync jsonb := null;
  rec record;
begin
  if p_currency is null or p_currency not in ('INR', 'RUB', 'USD', 'EUR') then
    raise exception 'invalid_payload' using detail = 'Валюта расчёта: INR | RUB | USD | EUR';
  end if;
  select id, legacy_inr_settlement into v_obj, v_legacy from fin_accounting_objects where retreat_id = p_retreat;
  if v_obj is null then
    raise exception 'invalid_payload' using detail = 'У события нет учётного объекта';
  end if;
  if v_legacy then
    raise exception 'legacy_inr_only' using detail = 'Событие на старой системе расчёта: всё в ₹, валюта расчёта не выбирается';
  end if;
  v_rate_to := fin_private_retreat_rate(p_currency, v_obj, p_on);

  insert into fin_participant_settlements (participant_id, retreat_id, currency_code, chosen_on, created_by)
  values (p_participant, p_retreat, p_currency, p_on, p_actor)
  on conflict (participant_id, retreat_id) do update
    set currency_code = excluded.currency_code, chosen_on = excluded.chosen_on;

  -- приёмы в другой валюте (отменённые и сторно не в счёт — как в балансе)
  for rec in
    select p.id, p.currency_code, p.amount
      from fin_postings p join fin_operations o on o.id = p.operation_id
     where p.participant_id = p_participant and p.object_id = v_obj
       and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
       and not o.is_reversed and o.type <> 'reversal'
       and p.currency_code <> p_currency
       and not exists (select 1 from fin_settlement_credits sc
                        where sc.posting_id = p.id and sc.settle_currency = p_currency)
  loop
    v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
    insert into fin_settlement_credits (posting_id, participant_id, retreat_id, from_currency, from_amount,
                                        settle_currency, settle_amount, rate_from, rate_to, created_by)
    values (rec.id, p_participant, p_retreat, rec.currency_code, rec.amount,
            p_currency, round(rec.amount * v_rate_from / v_rate_to, 2), v_rate_from, v_rate_to, p_actor);
    v_credits := v_credits + 1;
  end loop;

  -- стартовые остатки в другой валюте
  for rec in
    select b.id, b.currency_code, b.amount
      from fin_participant_opening_balances b
     where b.participant_id = p_participant and b.retreat_id = p_retreat
       and b.currency_code <> p_currency
       and not exists (select 1 from fin_settlement_credits sc
                        where sc.opening_id = b.id and sc.settle_currency = p_currency)
  loop
    v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
    insert into fin_settlement_credits (opening_id, participant_id, retreat_id, from_currency, from_amount,
                                        settle_currency, settle_amount, rate_from, rate_to, created_by)
    values (rec.id, p_participant, p_retreat, rec.currency_code, rec.amount,
            p_currency, round(rec.amount * v_rate_from / v_rate_to, 2), v_rate_from, v_rate_to, p_actor);
    v_credits := v_credits + 1;
  end loop;

  -- ручные начисления в другой валюте — по курсу ретрита
  for rec in
    select * from fin_charges
     where participant_id = p_participant and retreat_id = p_retreat and not is_cancelled
       and currency_code <> p_currency and creation_reason is distinct from 'crm_auto'
  loop
    v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);
    v_amount := round(rec.amount * v_rate_from / v_rate_to, 2);
    v_discount := least(round(rec.discount_amount * v_rate_from / v_rate_to, 2), v_amount);
    update fin_charges
       set is_cancelled = true, cancelled_at = now(), cancelled_by = p_actor,
           cancelled_reason = format('Смена валюты расчёта: было %s − %s %s, стало %s − %s %s',
                                     rec.amount, rec.discount_amount, rec.currency_code, v_amount, v_discount, p_currency)
     where id = rec.id;
    insert into fin_charges (id, request_hash, participant_id, retreat_id, kind, description,
                             quantity, unit_price, amount, discount_amount, currency_code,
                             discount_reason, creation_reason, created_by, agreed_with, occurred_on)
    values (gen_random_uuid(), md5(rec.id::text || ':' || p_currency || ':' || clock_timestamp()::text),
            p_participant, p_retreat, rec.kind, rec.description,
            rec.quantity, round(v_amount / rec.quantity, 2), v_amount, v_discount, p_currency,
            rec.discount_reason,
            coalesce(rec.creation_reason || ' · ', '') || format('переведено из %s %s по курсу ретрита', rec.amount - rec.discount_amount, rec.currency_code),
            p_actor, rec.agreed_with, rec.occurred_on);
    v_converted := v_converted + 1;
  end loop;

  -- начисления из CRM — синк пересоберёт их в новой валюте
  if exists (select 1 from fin_charges
              where participant_id = p_participant and retreat_id = p_retreat and not is_cancelled
                and currency_code <> p_currency and creation_reason = 'crm_auto') then
    v_sync := fin_sync_charges_from_crm(p_participant, p_retreat);
    if not coalesce((v_sync->>'ok')::boolean, false) then
      raise exception '%', coalesce(v_sync->'error'->>'code', 'internal_error')
        using detail = 'Начисления из CRM: ' || coalesce(v_sync->'error'->>'message', 'не удалось пересобрать');
    end if;
  end if;

  return jsonb_build_object('currency', p_currency, 'credits_created', v_credits,
                            'charges_converted', v_converted, 'crm_sync', v_sync->'result');
end;
$$;

create or replace function fin_set_settlement_currency(payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_actor uuid;
  v_res jsonb;
  v_detail text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Валюту расчёта выбирает администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['participant_id', 'retreat_id', 'currency_code']);
  v_res := fin_private_apply_settlement_currency(
    fin_private_get_uuid(payload, 'participant_id', true),
    fin_private_get_uuid(payload, 'retreat_id', true),
    payload->>'currency_code', current_date, v_actor);
  return jsonb_build_object('ok', true, 'result', v_res, 'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

-- ============ 5. Начисления из CRM в валюте расчёта ============
-- Старая система (Сева) — по-прежнему заморожена. Новая: цена блока в
-- валюте расчёта гостя (standard/final/per_unit из crm_calc_participation);
-- фикс-сумма в другой валюте — по курсу ретрита. Нет цены в этой валюте —
-- блок пропускается (не угадываем).
create or replace function fin_sync_charges_from_crm(p_participant uuid, p_retreat uuid)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid;
    v_deal uuid;
    v_obj uuid;
    calc jsonb;
    v_block text;
    b jsonb;
    v_cur text;
    v_sym text;
    v_gross numeric;      -- стандартная цена (до условий), в валюте расчёта
    v_net numeric;        -- к оплате после условий, в валюте расчёта
    v_discount numeric;
    v_qty numeric;
    v_unit numeric;
    v_desc text;
    v_fix_cur text;
    v_rate numeric;
    существующее record;
    создано int := 0; обновлено int := 0; пропущено int := 0;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden',
            'message', 'Синхронизация начислений доступна администратору финансов'));
    end if;

    -- Старая система расчёта (Сева-ретрит): событие сведено, начисления заморожены
    if exists (select 1 from fin_accounting_objects
                where retreat_id = p_retreat and legacy_inr_settlement) then
        return jsonb_build_object('ok', true, 'result', jsonb_build_object(
            'frozen', true, 'created', 0, 'updated', 0, 'kept_manual', 0), 'warnings', '[]'::jsonb);
    end if;

    select id into v_deal from crm_deals
     where vaishnava_id = p_participant and retreat_id = p_retreat and status <> 'cancelled'
     order by updated_at desc nulls last limit 1;
    if v_deal is null then
        return jsonb_build_object('ok', true, 'result', jsonb_build_object(
            'no_deal', true, 'created', 0, 'updated', 0), 'warnings', '[]'::jsonb);
    end if;

    calc := crm_calc_participation(v_deal);
    if not (calc->>'ok')::boolean then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'calc_failed', 'message', calc->>'error'));
    end if;

    select o_currency into v_cur from fin_private_settlement_currency(p_participant, p_retreat);
    v_sym := case v_cur when 'INR' then '₹' when 'RUB' then '₽' when 'USD' then '$' when 'EUR' then '€' end;
    select id into v_obj from fin_accounting_objects where retreat_id = p_retreat;

    for v_block in select unnest(array['org_fee', 'accommodation', 'meals']) loop
        b := calc->'blocks'->v_block;
        v_gross := (b->'standard'->>v_cur)::numeric;
        v_net := (b->'final'->>v_cur)::numeric;
        v_rate := null;

        -- Фикс-сумма в другой валюте — по курсу ретрита
        if b->'term'->>'type' = 'fixed' then
            v_fix_cur := coalesce(b->'term'->>'currency', 'INR');
            if v_fix_cur = v_cur then
                v_net := (b->'term'->>'amount')::numeric;
            else
                begin
                    v_rate := fin_private_retreat_rate(v_fix_cur, v_obj, current_date)
                              / fin_private_retreat_rate(v_cur, v_obj, current_date);
                exception when others then
                    v_rate := null;
                end;
                if v_rate is null then
                    пропущено := пропущено + 1;   -- курса нет — не угадываем
                    continue;
                end if;
                v_net := round((b->'term'->>'amount')::numeric * v_rate, 2);
            end if;
        end if;

        if v_net is null then continue; end if;   -- нет цены в валюте расчёта — нечего начислять
        -- Без стандартной цены (только фикс) — брутто равно итогу
        if v_gross is null or v_gross < v_net then v_gross := v_net; end if;
        v_discount := round(v_gross - v_net, 2);

        v_qty := greatest(coalesce((b->>'units')::numeric, 1), 1);
        v_unit := round(v_gross / v_qty, 2);
        v_desc := case v_block
            when 'org_fee' then 'Оргвзнос'
            when 'meals' then
                case when b->'term'->>'type' = 'self' then 'Не кушает'
                     when b->'term'->>'type' = 'tickets' then 'Питание по талончикам'
                     else format('Питание %s — %s: %s дн. × %s %s',
                        to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'),
                        b->'during'->>'days', b->'per_unit'->>v_cur, v_sym)
                        || case when coalesce((b->'between'->>'days')::int, 0) > 0
                                then format(' + %s дн. вне ретрита%s', b->'between'->>'days',
                                     case when b->'between'->>'discount_percent' is not null then format(' (−%s%%)', b->'between'->>'discount_percent') else '' end)
                                else '' end
                end
            else
                case when b->'term'->>'type' = 'self' then 'Самостоятельное размещение'
                     else format('Проживание %s%s, %s — %s: %s ноч. × %s %s',
                        coalesce(calc->'dates'->>'building', '—'),
                        case when calc->'dates'->>'room' is not null then ' №' || (calc->'dates'->>'room') else '' end,
                        to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'),
                        b->'during'->>'nights', b->'per_unit'->>v_cur, v_sym)
                        || case when coalesce((b->'between'->>'nights')::int, 0) > 0
                                then format(' + %s ноч. вне ретрита%s', b->'between'->>'nights',
                                     case when b->'between'->>'discount_percent' is not null then format(' (−%s%%)', b->'between'->>'discount_percent') else '' end)
                                else '' end
                        || coalesce(' · ' || (b->>'note'), '')
                end
        end || case when b->'term' is not null
                    then format(' · инд. условия: %s', coalesce(b->'term'->>'reason', b->'term'->>'type'))
                         || case when v_rate is not null
                                 then format(' (%s %s по курсу ретрита)', b->'term'->>'amount', b->'term'->>'currency') else '' end
                    else '' end;

        -- Последнее начисление блока (в т.ч. отменённое): ручная отмена или
        -- ручное начисление главнее автосинхронизации (ВГ, 07.09)
        select * into существующее from fin_charges
         where participant_id = p_participant and retreat_id = p_retreat
           and kind = v_block::fin_charge_kind
         order by created_at desc limit 1;

        if found then
            if существующее.is_cancelled then
                пропущено := пропущено + 1;
                continue;
            end if;
            if существующее.creation_reason is distinct from 'crm_auto' then
                пропущено := пропущено + 1;
                continue;
            end if;
            if существующее.currency_code = v_cur and существующее.amount = v_gross
               and существующее.discount_amount = v_discount then
                continue;
            end if;
            update fin_charges
               set is_cancelled = true, cancelled_at = now(), cancelled_by = v_actor,
                   cancelled_reason = format('Автопересчёт из CRM: было %s − %s %s, стало %s − %s %s',
                                             существующее.amount, существующее.discount_amount, существующее.currency_code,
                                             v_gross, v_discount, v_cur)
             where id = существующее.id;
            обновлено := обновлено + 1;
        else
            создано := создано + 1;
        end if;

        insert into fin_charges (id, request_hash, participant_id, retreat_id, kind, description,
                                 quantity, unit_price, amount, discount_amount, currency_code,
                                 discount_reason, creation_reason, created_by, agreed_with)
        values (gen_random_uuid(), md5(v_deal::text || v_block || v_cur || v_gross::text || v_discount::text || clock_timestamp()::text),
                p_participant, p_retreat, v_block::fin_charge_kind, v_desc,
                v_qty, v_unit, v_gross, v_discount, v_cur,
                case when v_discount > 0 then coalesce(b->'term'->>'reason', b->'term'->>'type', 'условия CRM') end,
                'crm_auto', v_actor,
                (select coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''))
                    from vaishnavas v where v.id = nullif(b->'term'->>'manager_id', '')::uuid));
    end loop;

    return jsonb_build_object('ok', true,
        'result', jsonb_build_object('created', создано, 'updated', обновлено, 'kept_manual', пропущено, 'currency', v_cur),
        'calc', calc, 'warnings', '[]'::jsonb);
end;
$$;

-- ============ 6. Карточка и список — на v2 ============
-- Для Сева-ретрита v2 = прежняя функция + {currency: INR, system: legacy_inr}
-- (проверено на всех парах в 554/556)
create or replace function fin_get_participant_balance(p_participant uuid, p_retreat uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return fin_private_participant_balance_v2(p_participant, p_retreat);
end;
$$;

create or replace function fin_list_retreat_participants(p_retreat uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_result jsonb;
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'participant_id', ids.pid,
      'name', fin_private_person_name(ids.pid),
      'balance', fin_private_participant_balance_v2(ids.pid, p_retreat),
      -- Была сделка в CRM и её отменили, новой активной взамен нет — казначей
      -- видит долг человека, который по факту отказался от участия (ВГ, 07.09)
      'crm_cancelled', (
        exists (select 1 from crm_deals cd where cd.vaishnava_id = ids.pid and cd.retreat_id = p_retreat and cd.status = 'cancelled')
        and not exists (select 1 from crm_deals cd2 where cd2.vaishnava_id = ids.pid and cd2.retreat_id = p_retreat and cd2.status <> 'cancelled')
      )
    ) order by fin_private_person_name(ids.pid)
  ), '[]'::jsonb) into v_result
  from (
    select distinct participant_id as pid from fin_charges where retreat_id = p_retreat
    union
    select distinct participant_id from fin_participant_opening_balances where retreat_id = p_retreat
    union
    select distinct p.participant_id from fin_postings p
    join fin_accounting_objects o on o.id = p.object_id
    where o.retreat_id = p_retreat and p.participant_id is not null
    union
    -- зарегистрированные в модуле проживания
    select distinct rr.vaishnava_id from retreat_registrations rr
    where rr.retreat_id = p_retreat and rr.status <> 'cancelled' and rr.vaishnava_id is not null
    union
    -- купившие через CRM: именно они платят, и именно их казначей ищет
    select distinct cd.vaishnava_id from crm_deals cd
    where cd.retreat_id = p_retreat
      and cd.status not in ('lead', 'cancelled')
      and cd.vaishnava_id is not null
  ) ids
  where ids.pid is not null;

  return jsonb_build_object('ok', true, 'result', v_result);
end;
$$;

revoke execute on function fin_private_settlement_currency(uuid, uuid) from public, anon, authenticated;
revoke execute on function fin_private_apply_settlement_currency(uuid, uuid, text, date, uuid) from public, anon, authenticated;
revoke execute on function fin_settlement_writeoffs_immutable() from public, anon, authenticated;
revoke execute on function fin_set_settlement_currency(jsonb) from public, anon;
grant execute on function fin_set_settlement_currency(jsonb) to authenticated;

-- ============ 7. История платежей: засчитано в валюте расчёта ============
-- Для денег в другой валюте (новая система) — сколько засчитано в текущей
-- валюте расчёта гостя. Поля добавочные, прежние потребители их не видят.
CREATE OR REPLACE FUNCTION public.fin_private_participant_payments(p_participant uuid, p_retreat uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'occurred_on') DESC), '[]'::jsonb)
  FROM (
    -- 1. Проводки финмодуля
    SELECT jsonb_build_object(
      'posting_id', p.id,
      'operation_id', p.operation_id,
      'direction', p.direction,
      'occurred_on', o.occurred_on,
      'type', o.type,
      'amount', p.amount,
      'currency_code', p.currency_code,
      'amount_base', p.amount_base,
      'rate_used', p.rate_used,
      'payment_channel', p.payment_channel,
      'account_name', a.name,
      'payment_system', NULL,
      'source', 'ledger',
      'balance_kind', p.participant_balance_kind,
      'is_reversed', o.is_reversed,
      'paid_by', CASE
        WHEN o.payer_contact_id IS NOT NULL AND o.payer_contact_id <> p.participant_id
          THEN fin_private_person_name(o.payer_contact_id)
        ELSE NULL
      END,
      'status', CASE
        WHEN o.is_reversed AND EXISTS (
              SELECT 1 FROM fin_operations rv
               WHERE rv.original_operation_id = o.id
                 AND rv.reason LIKE 'Перераспределение платежа%')
          THEN 'reallocated'
        WHEN o.is_reversed THEN 'reversed'
        WHEN o.type = 'payment' AND n.net_amount >= p.amount THEN 'refunded_fully'
        WHEN o.type = 'payment' AND n.net_amount > 0 THEN 'refunded_partially'
        ELSE 'active'
      END,
      'available_to_refund', CASE WHEN o.type = 'payment' AND NOT o.is_reversed AND p.direction = 'in' THEN p.amount - n.net_amount ELSE 0 END,
      'settle_amount', sc.settle_amount,
      'settle_currency', sc.settle_currency
    ) AS x
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounting_objects ao ON ao.id = p.object_id
    LEFT JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN LATERAL fin_private_net_refunded(p.id) n ON o.type = 'payment'
    LEFT JOIN LATERAL (
      SELECT c.settle_amount, c.settle_currency
        FROM fin_settlement_credits c
        JOIN fin_participant_settlements s ON s.participant_id = c.participant_id
         AND s.retreat_id = c.retreat_id AND s.currency_code = c.settle_currency
       WHERE c.posting_id = p.id
    ) sc ON true
    WHERE p.participant_id = p_participant
      AND ao.retreat_id = p_retreat
      AND p.participant_balance_kind IS NOT NULL
      -- Само сторно от перераспределения гостю не показываем: иначе на одну
      -- историю выходит три строки (было / сторно / стало).
      AND NOT (o.type = 'reversal' AND o.reason LIKE 'Перераспределение платежа%')

    UNION ALL

    -- 2. Платежи из CRM, сделанные до переезда: в журнале их нет, они свёрнуты
    --    в начальный остаток. Здесь показываем, из чего этот остаток сложился.
    SELECT jsonb_build_object(
      'posting_id', NULL,
      'operation_id', NULL,
      'occurred_on', COALESCE(cp.received_at::date, cp.confirmed_at::date),
      'type', 'payment',
      'amount', cp.amount,
      'currency_code', cp.currency,
      'amount_base', cp.amount_inr,
      'rate_used', cp.rate_to_inr,
      'payment_channel', NULL,
      'account_name', acc.name,
      'payment_system', ps.name_ru,
      'source', 'crm',
      'balance_kind', CASE cp.payment_type
                        WHEN 'org_fee' THEN 'org_fee'
                        WHEN 'accommodation' THEN 'accommodation'
                        ELSE 'general' END,
      'is_reversed', false,
      'paid_by', NULL,
      'status', 'pre_cutover',
      'available_to_refund', 0
    )
    FROM crm_payments cp
    JOIN crm_deals cd ON cd.id = cp.deal_id
    LEFT JOIN crm_payment_systems ps ON ps.id = cp.payment_system_id
    LEFT JOIN fin_accounts acc ON acc.id = cp.fin_account_id
    WHERE cd.vaishnava_id = p_participant
      AND cd.retreat_id = p_retreat
      AND cp.is_confirmed
      -- только те, что не попали в журнал: иначе платёж покажется дважды
      AND NOT EXISTS (SELECT 1 FROM fin_operations o2 WHERE o2.id = cp.id)
  ) t
$function$;

-- ============ 8. Ручные начисления — в валюте расчёта ============
-- Карточке нужна валюта строки начисления
create or replace view fin_v_charges as
 select id, participant_id, fin_private_person_name(participant_id) as participant_name,
    retreat_id, kind, description, quantity, unit_price, amount, discount_amount,
    amount - discount_amount as net_amount, discount_reason, agreed_with, is_cancelled,
    cancelled_reason, creation_reason, created_at, occurred_on, currency_code
   from fin_charges c
  where fin_can_read_all();

-- fin_create_charge: сумма вводится в валюте расчёта гостя (новая система);
-- у Сева-ретрита — ₹, как было. Остальное без изменений
CREATE OR REPLACE FUNCTION public.fin_create_charge(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_agreed text;
  v_hash text;
  v_existing fin_charges%ROWTYPE;
  v_lock record;
  v_creation_reason text;
  v_results jsonb := '[]'::jsonb;
  v_retreats uuid[] := '{}';
  v_detail text;
  v_cur text;
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
      'quantity', 'unit_price', 'discount_amount', 'discount_reason', 'creation_reason',
      'agreed_with', 'occurred_on'
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

    v_agreed := NULLIF(trim(COALESCE(r->>'agreed_with', '')), '');

    v_hash := fin_private_hash(jsonb_build_object(
      'command', 'create_charge',
      'participant_id', lower(v_participant::text),
      'retreat_id', lower(v_retreat::text),
      'kind', v_kind,
      'description', trim(COALESCE(r->>'description', '')),
      'quantity', v_qty::text,
      'unit_price', fin_private_norm_money(v_price),
      'discount_amount', fin_private_norm_money(v_discount),
      'discount_reason', NULLIF(trim(COALESCE(r->>'discount_reason', '')), ''),
      'agreed_with', v_agreed
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

    -- валюта начисления: новая система — валюта расчёта гостя, старая — ₹
    v_cur := 'INR';
    IF EXISTS (SELECT 1 FROM fin_accounting_objects WHERE retreat_id = v_retreat AND NOT legacy_inr_settlement) THEN
      SELECT o_currency INTO v_cur FROM fin_private_settlement_currency(v_participant, v_retreat);
    END IF;

    INSERT INTO fin_charges (
      id, request_hash, participant_id, retreat_id, kind, description,
      quantity, unit_price, amount, discount_amount, discount_reason,
      agreed_with, creation_reason, created_by, occurred_on, currency_code
    ) VALUES (
      v_id, v_hash, v_participant, v_retreat, v_kind,
      v_description,
      v_qty, v_price, v_amount, v_discount,
      NULLIF(trim(COALESCE(r->>'discount_reason', '')), ''),
      v_agreed, v_creation_reason, v_actor,
      COALESCE(fin_private_get_date(r, 'occurred_on'), CURRENT_DATE), v_cur
    );
    v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id, 'amount', v_amount, 'net_amount', v_amount - v_discount, 'currency_code', v_cur));
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
$function$;
