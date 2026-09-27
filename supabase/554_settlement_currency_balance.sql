-- Фаза 2, шаг 2: долг участника в валюте расчёта гостя (ВГ, 27.09)
--
-- Документ: docs/finance/phase2_debt_in_price_currency.md.
--
-- Новая система (событие без пометки legacy_inr_settlement, миграция 553):
--   * гость выбирает валюту расчёта при приезде — fin_participant_settlements;
--   * начисления и долг — в этой валюте, платёж в ней засчитывается 1:1;
--   * деньги в другой валюте (предоплата, остаток «в другой валюте»)
--     засчитываются записью в fin_settlement_credits: сколько засчитано в
--     валюте расчёта. Запись хранит обе суммы и курс ретрита, задним числом не
--     пересчитывается. Проводки при этом не меняются (денежные поля неизменны);
--   * курс — только курс ретрита (fin_exchange_rates с object_id), без общего.
--
-- Сева-ретрит (legacy_inr_settlement) считается прежней функцией без изменений.
-- Новая функция fin_private_participant_balance_v2 пока никем не вызывается:
-- переключение — вместе с формой приёма и показом валюты (шаг 4), иначе
-- карточки и портал показали бы рубли как рупии.

-- Валюта расчёта гостя по событию
create table fin_participant_settlements (
  participant_id uuid not null references vaishnavas(id),
  retreat_id uuid not null references retreats(id),
  currency_code text not null check (currency_code in ('INR', 'RUB', 'USD', 'EUR')),
  chosen_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  primary key (participant_id, retreat_id)
);
alter table fin_participant_settlements enable row level security;
comment on table fin_participant_settlements is
  'Валюта расчёта гостя по событию (новая система, фаза 2). Выбирается при приезде; начисления и долг ведутся в ней.';

-- Засчитано в валюте расчёта за деньги в другой валюте
create table fin_settlement_credits (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid references fin_postings(id),
  opening_id uuid references fin_participant_opening_balances(id),
  participant_id uuid not null references vaishnavas(id),
  retreat_id uuid not null references retreats(id),
  from_currency text not null,
  from_amount numeric(14, 2) not null check (from_amount > 0),
  settle_currency text not null check (settle_currency in ('INR', 'RUB', 'USD', 'EUR')),
  settle_amount numeric(14, 2) not null check (settle_amount >= 0),
  rate_from numeric not null,   -- курс ретрита: ₹ за единицу from_currency
  rate_to numeric not null,     -- курс ретрита: ₹ за единицу settle_currency
  created_at timestamptz not null default now(),
  created_by uuid not null,
  check (num_nonnulls(posting_id, opening_id) = 1),
  check (from_currency <> settle_currency)
);
-- при смене валюты расчёта появляются новые записи в новой валюте, старые остаются
create unique index fin_settlement_credits_posting on fin_settlement_credits (posting_id, settle_currency) where posting_id is not null;
create unique index fin_settlement_credits_opening on fin_settlement_credits (opening_id, settle_currency) where opening_id is not null;
alter table fin_settlement_credits enable row level security;
comment on table fin_settlement_credits is
  'Сколько засчитано в валюте расчёта за деньги в другой валюте (фаза 2). Только добавление: суммы не пересчитываются задним числом.';

create or replace function fin_settlement_credits_immutable() returns trigger
language plpgsql set search_path to 'public' as $$
begin
  raise exception 'fin_settlement_credits_immutable'
    using detail = 'Засчитанные суммы не меняются и не удаляются';
end;
$$;
create trigger fin_settlement_credits_immutable
  before update or delete on fin_settlement_credits
  for each row execute function fin_settlement_credits_immutable();

-- Начисления и стартовые остатки: теперь 4 валюты. У Сева-ретрита (старая
-- система) — по-прежнему только ₹, это держит триггер.
alter table fin_charges drop constraint fin_charges_currency_code_check;
alter table fin_charges add constraint fin_charges_currency_code_check
  check (currency_code in ('INR', 'RUB', 'USD', 'EUR'));
alter table fin_participant_opening_balances drop constraint fin_participant_opening_balances_currency_code_check;
alter table fin_participant_opening_balances add constraint fin_participant_opening_balances_currency_code_check
  check (currency_code in ('INR', 'RUB', 'USD', 'EUR'));

create or replace function fin_legacy_inr_only() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if new.currency_code <> 'INR' and exists (
       select 1 from fin_accounting_objects
        where retreat_id = new.retreat_id and legacy_inr_settlement) then
    raise exception 'legacy_inr_only'
      using detail = 'Событие на старой системе расчёта: начисления и остатки только в ₹';
  end if;
  return new;
end;
$$;
create trigger fin_charges_legacy_inr_only
  before insert or update of currency_code on fin_charges
  for each row execute function fin_legacy_inr_only();
create trigger fin_opening_legacy_inr_only
  before insert or update of currency_code on fin_participant_opening_balances
  for each row execute function fin_legacy_inr_only();

-- Курс ретрита без запасного общего курса: в новой системе курс задаётся
-- один раз на событие, общий курс молча подставлять нельзя
create or replace function fin_private_retreat_rate(p_currency text, p_object uuid, p_on date)
returns numeric
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_rate numeric;
begin
  if p_currency = 'INR' then return 1; end if;
  select rate into v_rate from fin_exchange_rates
   where from_currency = p_currency and object_id = p_object and effective_date <= p_on
   order by effective_date desc limit 1;
  if v_rate is null then
    raise exception 'retreat_rate_missing'
      using detail = format('Нет курса ретрита %s→INR на %s — заведите курс ретрита', p_currency, p_on);
  end if;
  return v_rate;
end;
$$;

-- Долг участника: старая система — прежняя функция без изменений;
-- новая — в валюте расчёта гостя. Форма результата та же + currency, problems,
-- а до выбора валюты — preview: долг в каждой из 4 валют по ценам CRM.
create or replace function fin_private_participant_balance_v2(p_participant uuid, p_retreat uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_obj uuid;
  v_legacy boolean;
  v_cur text;
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
  v_preview jsonb := '{}'::jsonb;
  v_result jsonb := '{}'::jsonb;
  v_deal uuid;
  v_calc jsonb;
  v_price numeric;
  v_money numeric;
  v_c text;
  v_b text;
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

  -- До выбора валюты: начислений ещё нет, показываем долг в каждой валюте
  -- по ценам CRM минус деньги, пересчитанные по курсу ретрита
  if v_cur is null then
    select d.id into v_deal from crm_deals d
     where d.vaishnava_id = p_participant and d.retreat_id = p_retreat
     order by (d.status = 'cancelled'), d.created_at desc limit 1;
    if v_deal is not null then
      v_calc := crm_calc_participation(v_deal);
    end if;
    foreach v_c in array array['INR', 'RUB', 'USD', 'EUR'] loop
      v_price := null;
      if (v_calc->>'ok')::boolean then
        v_price := 0;
        foreach v_b in array array['org_fee', 'accommodation', 'meals'] loop
          if v_calc->'blocks'->v_b ? 'final' then
            if (v_calc->'blocks'->v_b->'final'->>v_c) is null then v_price := null; exit; end if;
            v_price := v_price + (v_calc->'blocks'->v_b->'final'->>v_c)::numeric;
          end if;
        end loop;
      end if;
      begin
        select coalesce(sum(round(m.signed * fin_private_retreat_rate(m.cur, v_obj, current_date)
                                  / fin_private_retreat_rate(v_c, v_obj, current_date), 2)), 0)
          into v_money
          from (select p.currency_code cur,
                       case p.direction when 'in' then p.amount else -p.amount end signed
                  from fin_postings p
                 where p.participant_id = p_participant and p.object_id = v_obj
                   and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
                union all
                select b.currency_code, case b.kind when 'credit' then b.amount else -b.amount end
                  from fin_participant_opening_balances b
                 where b.participant_id = p_participant and b.retreat_id = p_retreat) m;
      exception when others then
        v_money := null;   -- нет курса ретрита — долг в этой валюте не посчитать
      end;
      v_preview := v_preview || jsonb_build_object(v_c, jsonb_build_object(
        'price', v_price, 'paid', v_money,
        'balance', case when v_price is null or v_money is null then null else v_price - v_money end));
    end loop;
    if exists (select 1 from fin_charges where participant_id = p_participant
                and retreat_id = p_retreat and not is_cancelled) then
      v_problems := v_problems || jsonb_build_array(jsonb_build_object(
        'code', 'charges_without_currency', 'message', 'Есть начисления, но валюта расчёта не выбрана'));
    end if;
    return jsonb_build_object('system', 'settlement_currency', 'currency', null,
                              'preview', v_preview, 'problems', v_problems);
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

  -- Платежи: своя валюта 1:1, чужая — через засчитанную сумму
  for rec in
    select p.id, p.participant_balance_kind::text as bk, p.currency_code as c, p.amount,
           case p.direction when 'in' then 1 else -1 end as sgn,
           (select sc.settle_amount from fin_settlement_credits sc
             where sc.posting_id = p.id and sc.settle_currency = v_cur) as credited
      from fin_postings p
     where p.participant_id = p_participant and p.object_id = v_obj
       and p.participant_balance_kind is not null and p.participant_balance_kind <> 'none'
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

-- Как у fin_private_participant_balance: только postgres и service_role.
-- Иначе security definer отдаёт баланс любого участника через PostgREST.
revoke execute on function fin_private_participant_balance_v2(uuid, uuid) from public, anon, authenticated;
revoke execute on function fin_private_retreat_rate(text, uuid, date) from public, anon, authenticated;
revoke execute on function fin_legacy_inr_only() from public, anon, authenticated;
revoke execute on function fin_settlement_credits_immutable() from public, anon, authenticated;
