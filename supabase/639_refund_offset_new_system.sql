-- Фаза 2, шаг 8 (часть 4): возврат аванса и зачёт между участниками — в новой системе.
-- Раньше обе операции мерили аванс/долг балансом v1 (всё в ₹), поэтому в новой системе
-- кнопки были скрыты. Теперь:
--   возврат аванса — аванс в валюте гостя (v2); деньги уходят со счёта в его валюте;
--     счёт в другой валюте — возврат засчитывается в валюту гостя по курсу ретрита
--     (fin_settlement_credits на проводку), как приём денег в другой валюте;
--   зачёт — сумма в валюте донора; у получателя в другой валюте засчитывается по курсу
--     ретрита (fin_settlement_credits на его стартовую строку).
-- Сева-ретрит (legacy_inr_settlement) — прежний путь в ₹, без изменений.

create or replace function public.fin_refund_advance(payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor       uuid;
  v_request_id  uuid;
  v_participant uuid;
  v_retreat     uuid;
  v_account_id  uuid;
  v_amount      numeric;
  v_on          date;
  v_reason      text;
  v_comment     text;
  v_object      uuid;
  v_closed      boolean := false;
  v_acc         fin_accounts%rowtype;
  v_rate        numeric;
  v_base        numeric;
  v_аванс       numeric;
  v_balance     numeric;
  v_category    uuid;
  v_hash        text;
  v_existing    jsonb;
  v_warnings    jsonb := '[]'::jsonb;
  v_detail      text;
  v_legacy      boolean;
  v_cur         text;      -- валюта расчёта гостя (новая система)
  v_rate_from   numeric;
  v_rate_to     numeric;
  v_settle      numeric;   -- возврат в валюте гостя
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Возврат проводит только администратор финансов';
  end if;

  perform fin_private_assert_keys(payload, array[
    'request_id', 'participant_id', 'retreat_id', 'account_id',
    'amount', 'occurred_on', 'reason', 'comment', 'payment_channel'
  ]);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_retreat     := fin_private_get_uuid(payload, 'retreat_id', true);
  v_account_id  := fin_private_get_uuid(payload, 'account_id', true);
  v_amount      := fin_private_get_money(payload, 'amount', true);
  v_on          := fin_private_get_date(payload, 'occurred_on', true);
  v_reason      := nullif(trim(coalesce(payload->>'reason', '')), '');
  v_comment     := nullif(trim(coalesce(payload->>'comment', '')), '');

  if v_amount <= 0 then
    raise exception 'invalid_payload' using detail = 'Сумма возврата должна быть больше нуля';
  end if;
  if v_on > current_date + 1 then
    raise exception 'occurred_on_in_future' using detail = 'Дата возврата в будущем';
  end if;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'refund_advance',
    'participant_id', lower(v_participant::text),
    'retreat_id', lower(v_retreat::text),
    'account_id', lower(v_account_id::text),
    'amount', fin_private_norm_money(v_amount),
    'occurred_on', v_on,
    'reason', v_reason));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  end if;

  -- Возврат обязан висеть на объекте ретрита: иначе баланс участника его не увидит
  select o.id, o.legacy_inr_settlement into v_object, v_legacy
  from fin_accounting_objects o where o.retreat_id = v_retreat;
  if v_object is null then
    raise exception 'invalid_payload' using detail = 'У ретрита нет объекта учёта';
  end if;
  perform 1 from fin_accounting_objects where id = v_object for update;
  v_closed := exists (select 1 from fin_object_closures c where c.object_id = v_object and c.is_initial);
  if v_closed and v_reason is null then
    raise exception 'post_close_reason_required'
      using detail = 'Возврат по закрытому ретриту требует причины';
  end if;

  select * into v_acc from fin_accounts where id = v_account_id for update;
  if not found or not v_acc.is_active then
    raise exception 'account_not_found' using detail = 'Счёт возврата не найден или деактивирован';
  end if;

  v_rate := fin_private_get_rate(v_acc.currency_code, v_object, v_on);
  v_base := round(v_amount * v_rate, 2);

  if v_legacy then
    -- Сева-ретрит: всё в ₹, как было
    v_аванс := greatest((fin_private_participant_balance(v_participant, v_retreat)->>'total_advance')::numeric, 0);
    if v_аванс <= 0.005 then
      raise exception 'no_advance_to_refund'
        using detail = 'У участника нет аванса — возвращать нечего';
    end if;
    if v_base > v_аванс + 0.005 then
      raise exception 'refund_above_advance'
        using detail = format('Аванса всего %s, а возврат выходит на %s',
                              fin_fmt_money(v_аванс, 'INR'), fin_fmt_money(v_base, 'INR'));
    end if;
  else
    -- новая система: аванс в валюте гостя; деньги другой валюты — по курсу ретрита
    select coalesce((j->>'total_advance')::numeric, 0), j->>'currency' into v_аванс, v_cur
    from (select fin_private_participant_balance_v2(v_participant, v_retreat) as j) b;
    v_аванс := greatest(v_аванс, 0);
    if v_аванс <= 0.005 then
      raise exception 'no_advance_to_refund'
        using detail = 'У участника нет аванса — возвращать нечего';
    end if;
    if v_acc.currency_code = v_cur then
      v_settle := v_amount;
    else
      v_rate_from := fin_private_retreat_rate(v_acc.currency_code, v_object, v_on);
      v_rate_to := fin_private_retreat_rate(v_cur, v_object, v_on);
      v_settle := round(v_amount * v_rate_from / v_rate_to, 2);
    end if;
    if v_settle > v_аванс + 0.005 then
      raise exception 'refund_above_advance'
        using detail = format('Аванса всего %s, а возврат выходит на %s',
                              fin_fmt_money(v_аванс, v_cur), fin_fmt_money(v_settle, v_cur));
    end if;
  end if;

  v_balance := fin_private_account_balance(v_acc.id);
  if v_balance - v_amount < 0 then
    if v_acc.kind = 'real' then
      raise exception 'insufficient_funds'
        using detail = format('Счёт «%s»: остаток %s, возврат %s', v_acc.name, v_balance, v_amount);
    else
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'custodial_negative_balance',
        'message', format('Счёт «%s» уйдёт в минус', v_acc.name)));
    end if;
  end if;

  select id into v_category from fin_categories where code = 'participant_refund';

  insert into fin_operations (id, request_hash, type, occurred_on, approval,
                              payer_contact_id, refund_recipient_contact_id,
                              reason, comment, created_by)
  values (v_request_id, v_hash, 'refund', v_on, 'not_required',
          v_participant, v_participant, v_reason, v_comment, v_actor);

  insert into fin_postings (
    id, operation_id, account_id, direction, amount, currency_code,
    amount_base, rate_used, category_id, cost_center_id, object_id, is_post_close,
    participant_id, participant_balance_kind, payment_channel
  ) values (
    fin_private_child_uuid(v_request_id, 'posting'), v_request_id, v_acc.id, 'out',
    v_amount, v_acc.currency_code, v_base, v_rate,
    v_category, v_acc.default_cost_center_id, v_object, v_closed,
    v_participant, 'general', nullif(payload->>'payment_channel','')::fin_payment_channel
  );

  -- деньги в другой валюте, чем долг гостя: сколько засчитано в его валюту
  if not v_legacy and v_acc.currency_code <> v_cur then
    insert into fin_settlement_credits (posting_id, participant_id, retreat_id, from_currency, from_amount,
                                        settle_currency, settle_amount, rate_from, rate_to, created_by)
    values (fin_private_child_uuid(v_request_id, 'posting'), v_participant, v_retreat,
            v_acc.currency_code, v_amount, v_cur, v_settle, v_rate_from, v_rate_to, v_actor);
  end if;

  if v_closed then
    update fin_accounting_objects set report_dirty_at = now() where id = v_object;
  end if;

  return jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id)
      || case when v_legacy then jsonb_build_object('advance_after', v_аванс - v_base)
              else jsonb_build_object('advance_after', v_аванс - v_settle, 'currency', v_cur) end,
    'warnings', v_warnings);

exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

create or replace function public.fin_offset_between_participants(payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_actor      uuid;
  v_request_id uuid;
  v_from       uuid;
  v_to         uuid;
  v_retreat    uuid;
  v_amount     numeric;
  v_reason     text;
  v_донор      jsonb;
  v_получ      jsonb;
  v_аванс      numeric;
  v_долг       numeric;
  v_hash       text;
  v_detail     text;
  v_object     uuid;
  v_legacy     boolean;
  v_cur_from   text := 'INR';   -- валюта донора: в ней сумма зачёта
  v_cur_to     text := 'INR';   -- валюта получателя
  v_rate_from  numeric := 1;
  v_rate_to    numeric := 1;
  v_долг_д     numeric;         -- долг получателя в валюте донора
  v_засчитано  numeric;         -- зачёт в валюте получателя
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;

  perform fin_private_assert_keys(payload, array[
    'request_id', 'from_participant', 'to_participant', 'retreat_id', 'amount', 'reason'
  ]);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_from       := fin_private_get_uuid(payload, 'from_participant', true);
  v_to         := fin_private_get_uuid(payload, 'to_participant', true);
  v_retreat    := fin_private_get_uuid(payload, 'retreat_id', true);
  v_amount     := fin_private_get_money(payload, 'amount', false);
  v_reason     := nullif(trim(coalesce(payload->>'reason', '')), '');

  if v_from = v_to then
    raise exception 'invalid_payload' using detail = 'Донор и получатель — один человек';
  end if;

  select id, coalesce(legacy_inr_settlement, false) into v_object, v_legacy
  from fin_accounting_objects where retreat_id = v_retreat;
  v_legacy := coalesce(v_legacy, true);

  if v_legacy then
    -- Сева-ретрит: всё в ₹, как было
    v_донор := fin_private_participant_balance(v_from, v_retreat);
    v_получ := fin_private_participant_balance(v_to, v_retreat);
  else
    -- новая система: аванс донора и долг получателя — каждый в своей валюте
    v_донор := fin_private_participant_balance_v2(v_from, v_retreat);
    v_получ := fin_private_participant_balance_v2(v_to, v_retreat);
    v_cur_from := v_донор->>'currency';
    v_cur_to := v_получ->>'currency';
    if v_cur_from <> v_cur_to then
      v_rate_from := fin_private_retreat_rate(v_cur_from, v_object, current_date);
      v_rate_to := fin_private_retreat_rate(v_cur_to, v_object, current_date);
    end if;
  end if;
  v_аванс := greatest((v_донор->>'total_advance')::numeric, 0);
  v_долг  := greatest((v_получ->>'total_debt')::numeric, 0);
  v_долг_д := round(v_долг * v_rate_to / v_rate_from, 2);

  if v_аванс <= 0.005 then
    raise exception 'no_advance_to_offset'
      using detail = 'У донора нет аванса — зачитывать нечего';
  end if;
  if v_долг <= 0.005 then
    raise exception 'no_debt_to_cover'
      using detail = 'У получателя нет долга — зачитывать некуда';
  end if;

  -- по умолчанию зачитываем ровно столько, сколько закрывает долг и есть у донора
  v_amount := round(coalesce(v_amount, least(v_аванс, v_долг_д)), 2);
  if v_amount <= 0.005 then
    raise exception 'invalid_payload' using detail = 'Сумма зачёта должна быть больше нуля';
  end if;
  if v_amount > v_аванс + 0.005 then
    raise exception 'offset_above_advance'
      using detail = format('У донора аванса только %s', fin_fmt_money(v_аванс, v_cur_from));
  end if;
  v_засчитано := case when v_cur_from = v_cur_to then v_amount
                      else round(v_amount * v_rate_from / v_rate_to, 2) end;
  -- закрыть долг целиком: остаток от округления курса в долг не превращается
  if v_cur_from <> v_cur_to and v_amount = v_долг_д then v_засчитано := v_долг; end if;
  if v_засчитано > v_долг + 0.005 then
    raise exception 'offset_above_debt'
      using detail = format('Долг получателя всего %s', fin_fmt_money(v_долг, v_cur_to));
  end if;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'offset_between_participants',
    'from', lower(v_from::text), 'to', lower(v_to::text),
    'retreat', lower(v_retreat::text),
    'amount', fin_private_norm_money(v_amount)));

  if exists (select 1 from fin_participant_opening_balances
              where id = fin_private_child_uuid(v_request_id, 'from')) then
    return jsonb_build_object('ok', true, 'result',
      jsonb_build_object('amount_inr', v_amount, 'repeated', true), 'warnings', '[]'::jsonb);
  end if;

  insert into fin_participant_opening_balances (
    id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
    source_document, request_hash, comment, created_by
  ) values (
    fin_private_child_uuid(v_request_id, 'from'),
    v_from, v_retreat, v_amount, v_cur_from, 'debt', 'general',
    'Зачёт аванса между участниками', v_hash,
    format('Аванс передан: %s → %s%s', fin_private_person_name(v_from), fin_private_person_name(v_to), coalesce(' · ' || v_reason, '')),
    v_actor
  ), (
    fin_private_child_uuid(v_request_id, 'to'),
    v_to, v_retreat, v_amount, v_cur_from, 'credit', 'general',
    'Зачёт аванса между участниками', v_hash,
    format('Аванс получен: %s → %s%s', fin_private_person_name(v_from), fin_private_person_name(v_to), coalesce(' · ' || v_reason, '')),
    v_actor
  );

  -- получатель в другой валюте: сумма зачёта засчитывается по курсу ретрита
  if v_cur_from <> v_cur_to then
    insert into fin_settlement_credits (opening_id, participant_id, retreat_id, from_currency, from_amount,
                                        settle_currency, settle_amount, rate_from, rate_to, created_by)
    values (fin_private_child_uuid(v_request_id, 'to'), v_to, v_retreat, v_cur_from, v_amount,
            v_cur_to, v_засчитано, v_rate_from, v_rate_to, v_actor);
  end if;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'amount_inr', v_amount,
    'amount', v_amount, 'currency', v_cur_from,
    'credited', v_засчитано, 'credited_currency', v_cur_to,
    'from_advance_left', v_аванс - v_amount,
    'to_debt_left', v_долг - v_засчитано), 'warnings', '[]'::jsonb);

exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;
