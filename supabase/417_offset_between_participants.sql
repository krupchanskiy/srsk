-- 417. Зачёт аванса одного участника в долг другого, когда аванс лежит
-- в начальном остатке, а не в проводках журнала.
--
-- ВГ: «у жены есть долг, а у мужа большая переплата (он оплатит сразу за двоих),
-- но нет возможности учесть эту переплату».
--
-- Существующий зачёт (fin_reallocate_payment) перевешивает строку платежа на
-- другого человека и потому работает только с проводками. У людей, чей аванс
-- пришёл из загрузки рубежа, проводок нет вовсе — как раз случай Адхиягьи дас.
-- Здесь деньги тоже не двигаются: меняется только принадлежность суммы, двумя
-- строками начального остатка (донору debt, получателю credit).
--
-- correction_reason не заполняем: CHECK fin_pob_correction_shape разрешает его
-- только вместе со ссылкой на исправляемую строку — причина уходит в comment.
create or replace function fin_offset_between_participants(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
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

  v_донор := fin_private_participant_balance(v_from, v_retreat);
  v_получ := fin_private_participant_balance(v_to, v_retreat);
  v_аванс := greatest((v_донор->>'total_advance')::numeric, 0);
  v_долг  := greatest((v_получ->>'total_debt')::numeric, 0);

  if v_аванс <= 0.005 then
    raise exception 'no_advance_to_offset'
      using detail = 'У донора нет аванса — зачитывать нечего';
  end if;
  if v_долг <= 0.005 then
    raise exception 'no_debt_to_cover'
      using detail = 'У получателя нет долга — зачитывать некуда';
  end if;

  -- по умолчанию зачитываем ровно столько, сколько закрывает долг и есть у донора
  v_amount := round(coalesce(v_amount, least(v_аванс, v_долг)), 2);
  if v_amount <= 0.005 then
    raise exception 'invalid_payload' using detail = 'Сумма зачёта должна быть больше нуля';
  end if;
  if v_amount > v_аванс + 0.005 then
    raise exception 'offset_above_advance'
      using detail = format('У донора аванса только %s', fin_fmt_money(v_аванс, 'INR'));
  end if;
  if v_amount > v_долг + 0.005 then
    raise exception 'offset_above_debt'
      using detail = format('Долг получателя всего %s', fin_fmt_money(v_долг, 'INR'));
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
    v_from, v_retreat, v_amount, 'INR', 'debt', 'general',
    'Зачёт аванса между участниками', v_hash,
    format('Аванс передан: %s → %s%s', fin_private_person_name(v_from), fin_private_person_name(v_to),
           coalesce(' · ' || v_reason, '')),
    v_actor
  ), (
    fin_private_child_uuid(v_request_id, 'to'),
    v_to, v_retreat, v_amount, 'INR', 'credit', 'general',
    'Зачёт аванса между участниками', v_hash,
    format('Аванс получен: %s → %s%s', fin_private_person_name(v_from), fin_private_person_name(v_to),
           coalesce(' · ' || v_reason, '')),
    v_actor
  );

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'amount_inr', v_amount,
    'from_advance_left', v_аванс - v_amount,
    'to_debt_left', v_долг - v_amount), 'warnings', '[]'::jsonb);

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

revoke all on function fin_offset_between_participants(jsonb) from public, anon;
grant execute on function fin_offset_between_participants(jsonb) to authenticated;
