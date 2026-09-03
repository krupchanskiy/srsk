-- 412. Разбор сигнала «Взносы подтверждены в CRM, но человека нет в учёте»
--
-- ВГ: «Это все люди, которые отменили своё участие, и нам нужен механизм
-- внесения как пожертвования переведённых сумм».
--
-- Важное про деньги: все эти платежи прошли ДО рубежа (04.08.2026), а остатки
-- счетов на рубеже — это снимок факта. Деньги уже внутри снимка, поэтому новая
-- проводка задвоила бы кассу. Значит правильный ход — не проводка, а решение:
--   • отменившим участие — пометка «оставлено как пожертвование»;
--   • тем, кто едет (платёж подтвердили после загрузки рубежа) — добор
--     начального остатка, которого не хватило.
-- Оба действия гасят сигнал, ни одно не двигает кассу.

-- 1. Журнал решений по неразнесённым платежам
create table if not exists fin_payment_dispositions (
  payment_id  uuid primary key references crm_payments(id) on delete cascade,
  disposition text not null check (disposition in ('donation')),
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid not null
);

comment on table fin_payment_dispositions is
  'Решения по платежам до рубежа, которые не попали в учёт: сумма оставлена как пожертвование';

alter table fin_payment_dispositions enable row level security;
revoke all on fin_payment_dispositions from anon, authenticated;
-- Политик нет намеренно: таблица читается и пишется только через SECURITY DEFINER

-- 2. RPC: разобрать одну строку сигнала
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

  if v_action not in ('donation', 'advance') then
    raise exception 'invalid_payload' using detail = 'action: ожидается donation или advance';
  end if;

  -- Платежи, из-за которых горит сигнал
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

  if v_action = 'donation' then
    insert into fin_payment_dispositions (payment_id, disposition, note, created_by)
    select u, 'donation',
           coalesce(v_note, 'Участие отменено, сумма оставлена как пожертвование'),
           v_actor
      from unnest(v_ids) u
    on conflict (payment_id) do nothing;
    get diagnostics v_строк = row_count;

  else
    -- Добор начального остатка: платёж подтвердили после загрузки рубежа
    if exists (select 1 from fin_participant_opening_balances ob
                where ob.participant_id = v_participant and ob.retreat_id = v_retreat) then
      raise exception 'opening_exists'
        using detail = 'Начальный остаток у этого человека уже есть — добор не нужен';
    end if;

    select ob.cutover_batch_id into v_batch
      from fin_participant_opening_balances ob
     where ob.retreat_id = v_retreat and ob.cutover_batch_id is not null
     limit 1;

    for d in
      select cd.id as deal_id,
             sum(cp.amount_inr) as сумма,
             count(*) as платежей,
             string_agg(cp.amount || ' ' || cp.currency, ', ' order by cp.received_at) as расшифровка
        from crm_payments cp
        join crm_deals cd on cd.id = cp.deal_id
       where cp.id = any (v_ids)
       group by cd.id
    loop
      insert into fin_participant_opening_balances (
        id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
        source_document, source_row_id, cutover_batch_id, request_hash, comment, created_by
      ) values (
        fin_private_child_uuid(v_request_id, d.deal_id::text),
        v_participant, v_retreat, d.сумма, 'INR', 'credit', 'general',
        'Добор к загрузке рубежа: платёж подтверждён позже',
        d.deal_id::text, v_batch,
        fin_private_hash(jsonb_build_object(
          'command', 'resolve_missing_advance',
          'deal_id', lower(d.deal_id::text),
          'amount', fin_private_norm_money(d.сумма))),
        coalesce(v_note, format('Оплачено до запуска: %s (%s пл.)', d.расшифровка, d.платежей)),
        v_actor
      )
      on conflict (id) do nothing;
      v_строк := v_строк + 1;
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'action', v_action, 'payments', array_length(v_ids, 1),
    'rows', v_строк, 'amount_inr', v_сумма), 'warnings', '[]'::jsonb);

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

-- 3. Сторож перестаёт считать разобранные платежи
do $do$
declare
  v_def  text;
  v_якорь text := 'AND NOT EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id=cd.vaishnava_id AND ob.retreat_id=cd.retreat_id) GROUP BY 1,2) x';
  v_новый text := 'AND NOT EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id=cd.vaishnava_id AND ob.retreat_id=cd.retreat_id) AND NOT EXISTS (SELECT 1 FROM fin_payment_dispositions pd WHERE pd.payment_id=cp.id) GROUP BY 1,2) x';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_run_integrity_checks';

  if v_def is null then
    raise exception 'Функция fin_run_integrity_checks не найдена';
  end if;
  if position('fin_payment_dispositions' in v_def) > 0 then
    raise notice 'Проверка уже учитывает решения, менять нечего';
    return;
  end if;
  if position(v_якорь in v_def) = 0 then
    raise exception 'Якорь проверки advance_missing не найден — функция изменилась';
  end if;

  execute replace(v_def, v_якорь, v_новый);
end
$do$;

-- 4. Расшифровка сигнала: статус сделки и данные для кнопки
do $do$
declare
  v_def   text;
  v_нач   int;
  v_кон   int;
  v_ветка text := $frag$  elsif p_check = 'advance_missing' then
    -- Платежи подтверждены, но начального остатка нет вовсе: деньги не в учёте
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('подтверждено %s, в учёте ничего нет — %s',
                              fin_fmt_money(x.в_платежах, 'INR'),
                              case when x.отменён then 'участие отменено'
                                   else 'участие в силе' end),
             'link', format('participants.html?retreat=%s&open=%s', x.retreat_id, x.participant_id),
             'action', jsonb_build_object(
                         'kind', 'resolve_missing_advance',
                         'participant_id', x.participant_id,
                         'retreat_id', x.retreat_id,
                         'cancelled', x.отменён,
                         'amount', fin_fmt_money(x.в_платежах, 'INR'),
                         'who', x.имя)
           ) order by x.в_платежах desc), '[]'::jsonb)
      into v_rows
      from (
        select cd.vaishnava_id as participant_id, cd.retreat_id,
               fin_private_person_name(cd.vaishnava_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               sum(cp.amount_inr) as в_платежах,
               bool_and(cd.status::text = 'cancelled') as отменён
          from crm_payments cp
          join crm_deals cd on cd.id = cp.deal_id
          join retreats r on r.id = cd.retreat_id
         where cp.is_confirmed
           and not exists (select 1 from fin_operations o where o.id = cp.id)
           and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp.id)
           and not exists (select 1 from fin_participant_opening_balances ob
                            where ob.participant_id = cd.vaishnava_id
                              and ob.retreat_id = cd.retreat_id)
         group by cd.vaishnava_id, cd.retreat_id, r.name_ru, r.name_en
      ) x
     limit 50;

$frag$;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_get_integrity_details';

  if v_def is null then
    raise exception 'Функция fin_get_integrity_details не найдена';
  end if;
  if position('fin_payment_dispositions' in v_def) > 0 then
    raise notice 'Расшифровка уже обновлена, менять нечего';
    return;
  end if;

  v_нач := position('  elsif p_check = ''advance_missing'' then' in v_def);
  v_кон := position('  elsif p_check = ''unposted_payments'' then' in v_def);
  if v_нач = 0 or v_кон = 0 or v_кон < v_нач then
    raise exception 'Границы ветки advance_missing не найдены — функция изменилась';
  end if;

  execute left(v_def, v_нач - 1) || v_ветка || substr(v_def, v_кон);
end
$do$;
