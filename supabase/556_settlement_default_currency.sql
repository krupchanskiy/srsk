-- Фаза 2: валюта расчёта по умолчанию вместо предпросмотра в 4 валютах (ВГ, 27.09)
--
-- Пока кассир не выбрал валюту расчёта гостя, долг считается в валюте первой
-- оплаты, а без оплат — в ₹. Карточка всегда в одной валюте;
-- currency_source: chosen | first_payment | default.

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
  i int;
  rec record;
begin
  select id, legacy_inr_settlement into v_obj, v_legacy
    from fin_accounting_objects where retreat_id = p_retreat;
  if v_legacy then
    return fin_private_participant_balance(p_participant, p_retreat)
           || jsonb_build_object('currency', 'INR', 'system', 'legacy_inr');
  end if;

  select currency_code into v_cur from fin_participant_settlements
   where participant_id = p_participant and retreat_id = p_retreat;

  -- Валюта не выбрана кассиром — валюта первой оплаты (стартовые остатки из
  -- CRM раньше приёмов в финмодуле), без оплат — ₹. Кассир меняет при
  -- приезде гостя (ВГ, 27.09). Предпросмотра в 4 валютах нет.
  if v_cur is null then
    select c into v_cur from (
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
    v_cur_source := case when v_cur is null then 'default' else 'first_payment' end;
    v_cur := coalesce(v_cur, 'INR');
  end if;

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

  -- Дальше — тот же разбор по блокам, что в fin_private_participant_balance
  for i in 1 .. 4 loop
    v_block_debt[i] := v_charges[i] + v_open_debt[i] - v_open_credit[i] - v_signed[i];
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
      'offset', v_offset[i]
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
    'quick_net', v_sum_charges + v_sum_open - v_sum_signed,
    'problems', v_problems
  );
end;
$$;
