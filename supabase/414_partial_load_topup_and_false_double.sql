-- 414. Добор неполного начального остатка + починка ложной проверки задвоения
--
-- ВГ прислал три случая advance_partial_load (Адхиягья дас, Элиада Чигир,
-- Ангелина Трунина). У всех одна причина: платёж датирован до рубежа, но
-- подтверждён уже после загрузки начальных остатков, поэтому в остаток не попал.
--
-- Заодно: проверка advance_double_representation ловила нормальные послерубежные
-- платежи — у сделки законно есть и остаток (за прошлое), и проводки (за новое).
-- Все 6 её «нарушений» оказались платежами от 12–31 августа. Добавлен фильтр
-- «платёж датирован до рубежа» — только тогда это действительно задвоение.
--
-- Ветка 'advance' в fin_resolve_missing_advance теперь считает ДЕЛЬТУ между
-- платежами до рубежа и тем, что уже лежит в остатке, поэтому одна кнопка
-- закрывает и «остатка нет вовсе» (advance_missing), и «остаток недобрал»
-- (advance_partial_load).

create or replace function fin_resolve_missing_advance(payload jsonb)
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
  v_action      text;
  v_note        text;
  v_batch       uuid;
  v_ids         uuid[];
  v_сумма       numeric := 0;
  v_строк       int := 0;
  v_дельта      numeric;
  v_detail      text;
  d             record;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;

  perform fin_private_assert_keys(payload, array[
    'request_id', 'participant_id', 'retreat_id', 'action', 'note'
  ]);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_retreat     := fin_private_get_uuid(payload, 'retreat_id', true);
  v_action      := nullif(trim(coalesce(payload->>'action', '')), '');
  v_note        := nullif(trim(coalesce(payload->>'note', '')), '');

  if v_action is null or v_action not in ('donation', 'advance') then
    raise exception 'invalid_payload' using detail = 'action: ожидается donation или advance';
  end if;

  if v_action = 'donation' then
    select array_agg(cp.id), coalesce(sum(cp.amount_inr), 0)
      into v_ids, v_сумма
      from crm_payments cp
      join crm_deals cd on cd.id = cp.deal_id
     where cd.vaishnava_id = v_participant
       and cd.retreat_id = v_retreat
       and cp.is_confirmed
       and not exists (select 1 from fin_operations o where o.id = cp.id)
       and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp.id);

    if v_ids is null then
      raise exception 'nothing_to_resolve'
        using detail = 'По этому человеку не осталось неразобранных платежей — сигнал уже погашен';
    end if;

    insert into fin_payment_dispositions (payment_id, disposition, note, created_by)
    select u, 'donation',
           coalesce(v_note, 'Участие отменено, сумма оставлена как пожертвование'),
           v_actor
      from unnest(v_ids) u
    on conflict (payment_id) do nothing;
    get diagnostics v_строк = row_count;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object(
      'action', v_action, 'payments', array_length(v_ids, 1),
      'rows', v_строк, 'amount_inr', v_сумма), 'warnings', '[]'::jsonb);
  end if;

  -- Добор аванса: сравниваем платежи до рубежа с тем, что уже лежит в остатке
  select ob.cutover_batch_id into v_batch
    from fin_participant_opening_balances ob
   where ob.retreat_id = v_retreat and ob.cutover_batch_id is not null
   limit 1;

  for d in
    select cd.id as deal_id,
           sum(cp.amount_inr) as платежей,
           count(*) as штук,
           string_agg(cp.amount || ' ' || cp.currency, ' + ' order by cp.received_at) as расшифровка,
           coalesce((select sum(ob.amount) from fin_participant_opening_balances ob
                      where ob.source_row_id = cd.id::text
                        and ob.cutover_batch_id is not null), 0) as в_остатке
      from crm_payments cp
      join crm_deals cd on cd.id = cp.deal_id
     where cd.vaishnava_id = v_participant
       and cd.retreat_id = v_retreat
       and cp.is_confirmed
       and coalesce(cp.received_at::date, cp.confirmed_at::date)
             < coalesce(fin_cutover_date(), current_date)
       and not exists (select 1 from fin_operations o where o.id = cp.id)
       and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp.id)
     group by cd.id
  loop
    v_дельта := round(d.платежей - d.в_остатке, 2);
    if v_дельта < 0.01 then
      continue;   -- по этой сделке остаток уже сходится
    end if;
    if v_дельта < 0 then
      raise exception 'opening_above_payments'
        using detail = 'В остатке больше, чем в платежах — автоматически не поправить, нужна ручная коррекция';
    end if;

    insert into fin_participant_opening_balances (
      id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
      source_document, source_row_id, cutover_batch_id, request_hash, comment, created_by
    ) values (
      fin_private_child_uuid(v_request_id, d.deal_id::text),
      v_participant, v_retreat, v_дельта, 'INR', 'credit', 'general',
      'Добор к загрузке рубежа: платёж подтверждён позже',
      d.deal_id::text, v_batch,
      fin_private_hash(jsonb_build_object(
        'command', 'resolve_missing_advance',
        'deal_id', lower(d.deal_id::text),
        'amount', fin_private_norm_money(v_дельта))),
      coalesce(v_note, format('Оплачено до запуска: %s (%s пл.)', d.расшифровка, d.штук)),
      v_actor
    )
    on conflict (id) do nothing;
    v_строк := v_строк + 1;
    v_сумма := v_сумма + v_дельта;
  end loop;

  if v_строк = 0 then
    raise exception 'nothing_to_resolve'
      using detail = 'Нечего добирать: остаток уже сходится с платежами до рубежа';
  end if;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'action', v_action, 'rows', v_строк, 'amount_inr', v_сумма), 'warnings', '[]'::jsonb);

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

revoke all on function fin_resolve_missing_advance(jsonb) from public, anon;
grant execute on function fin_resolve_missing_advance(jsonb) to authenticated;

-- Сторож: задвоение только если платёж датирован до рубежа
do $do$
declare
  v_def   text;
  v_якорь text := 'AND EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.source_row_id=d.id::text)'')';
  v_новый text := 'AND COALESCE(p.received_at::date, p.confirmed_at::date) < COALESCE(fin_cutover_date(), CURRENT_DATE) AND EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.source_row_id=d.id::text)'')';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_run_integrity_checks';

  if position('advance_double_representation' in v_def) = 0 then
    raise exception 'Проверка advance_double_representation не найдена';
  end if;
  if position('fin_cutover_date(), CURRENT_DATE) AND EXISTS (SELECT 1 FROM fin_participant_opening_balances' in v_def) > 0 then
    raise notice 'Фильтр рубежа уже стоит';
    return;
  end if;
  if position(v_якорь in v_def) = 0 then
    raise exception 'Якорь проверки задвоения не найден — функция изменилась';
  end if;

  execute replace(v_def, v_якорь, v_новый);
end
$do$;

-- Расшифровка задвоения: тот же фильтр
do $do$
declare
  v_def   text;
  v_якорь text := '         where cp.is_confirmed
           and exists (select 1 from fin_operations o where o.id = cp.id and not o.is_reversed)';
  v_новый text := '         where cp.is_confirmed
           and coalesce(cp.received_at::date, cp.confirmed_at::date)
                 < coalesce(fin_cutover_date(), current_date)
           and exists (select 1 from fin_operations o where o.id = cp.id and not o.is_reversed)';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_get_integrity_details';

  if position(v_якорь in v_def) = 0 then
    raise notice 'Якорь расшифровки задвоения не найден — вероятно, уже поправлено';
    return;
  end if;

  execute replace(v_def, v_якорь, v_новый);
end
$do$;

-- Расшифровка «неполной загрузки»: данные для кнопки
do $do$
declare
  v_def   text;
  v_якорь text := '             ''link'', format(''participants.html?retreat=%s&open=%s'', x.retreat_id, x.participant_id)
           ) order by abs(x.в_платежах - x.в_остатке) desc), ''[]''::jsonb)';
  v_новый text := '             ''link'', format(''participants.html?retreat=%s&open=%s'', x.retreat_id, x.participant_id),
             ''action'', jsonb_build_object(
                         ''kind'', ''resolve_missing_advance'',
                         ''mode'', ''topup'',
                         ''participant_id'', x.participant_id,
                         ''retreat_id'', x.retreat_id,
                         ''amount'', fin_fmt_money(x.в_платежах - x.в_остатке, ''INR''),
                         ''who'', x.имя)
           ) order by abs(x.в_платежах - x.в_остатке) desc), ''[]''::jsonb)';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_get_integrity_details';

  if position('''mode'', ''topup''' in v_def) > 0 then
    raise notice 'Кнопка добора уже есть';
    return;
  end if;
  if position(v_якорь in v_def) = 0 then
    raise exception 'Якорь ветки advance_partial_load не найден — функция изменилась';
  end if;

  execute replace(v_def, v_якорь, v_новый);
end
$do$;
