-- 420. Возврат аванса участнику деньгами, без привязки к исходной проводке
--
-- ВГ: «человек отказался от участия… пожертвование небольшое в 4 000, остальное
-- спросила вернуть. Мне нужно на такие случаи, что выдана сдача с остатка,
-- сейчас такого инструмента нет».
--
-- fin_create_refund возвращает деньги строго по исходной приходной проводке.
-- У людей, чей платёж прошёл до рубежа, проводки нет вовсе — аванс живёт
-- в начальном остатке, и вернуть его было нечем. Здесь деньги настоящим
-- образом уходят со счёта (проводка out), а аванс гасится тем, что проводка
-- несёт participant_balance_kind = 'general'.
--
-- Требует послабления гварда из миграции 421.
create or replace function fin_refund_advance(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
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
  select o.id into v_object from fin_accounting_objects o where o.retreat_id = v_retreat;
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

  if v_closed then
    update fin_accounting_objects set report_dirty_at = now() where id = v_object;
  end if;

  return jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id)
      || jsonb_build_object('advance_after', v_аванс - v_base),
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
$fn$;

revoke all on function fin_refund_advance(jsonb) from public, anon;
grant execute on function fin_refund_advance(jsonb) to authenticated;
