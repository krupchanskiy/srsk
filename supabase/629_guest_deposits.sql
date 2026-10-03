-- 629: баланс гостя без ретрита (ВГ, 02–03.10).
--
-- Человек отменил участие, а деньги не вернул и не пожертвовал: они лежат на
-- нём, не привязанные ни к какому ретриту, в той валюте, в которой он их
-- прислал. Пример — Ксения Голубова: 24 000 ₽ за Сева-ретрит (01.04, до запуска).
-- Потом: зачесть на любой ретрит или вернуть. Подсветки давности нет —
-- деньги лежат сколько угодно (ВГ).
--
-- Устройство — как «Гости без события» (573): служебный ретрит-контейнер,
-- скрытый RLS от всех страниц. Баланс в нём — обычный баланс участника
-- (fin_private_participant_balance_v2), в валюте взноса, без пересчёта.
--
-- • fin_deposit_from_payments — из сигнала «человека нет в учёте»: платежи CRM
--   ложатся на баланс в своей валюте (начальный остаток в контейнере), платежи
--   помечаются disposition='deposit' — сигнал гаснет. Деньги пришли до запуска,
--   они уже внутри остатков счетов: проводок нет, как и у «Аванс».
-- • fin_deposit_apply — зачесть на ретрит: минус в контейнере, плюс в ретрите,
--   та же валюта и сумма; дальше ретрит пересчитывает по своему курсу, как
--   любой стартовый аванс в чужой валюте (582).
-- • fin_deposit_refund — вернуть: расход со счёта в той же валюте; сверка суммы —
--   в валюте баланса, а не в ₹, чтобы курс не мешал вернуть всё до копейки.
-- • fin_get_deposits — список для главной финансов и карточки участника.

-- ============ Контейнер ============
insert into retreats (name_ru, name_en, name_hi, slug, start_date, end_date,
                      is_system, is_public, registration_open, cafe_eligible)
select 'Баланс гостей (без ретрита)', 'Guest balances (no retreat)', 'अतिथि शेष (बिना रिट्रीट)', 'deposits',
       date '2000-01-01', date '2000-01-01', true, false, false, false
where not exists (select 1 from retreats where slug = 'deposits');
-- учётный объект создаёт триггер trg_fin_sync_retreat_object

create or replace function fin_private_deposit_retreat()
returns uuid language sql stable security definer set search_path to 'public' as $$
    select id from retreats where slug = 'deposits' and is_system;
$$;
revoke all on function fin_private_deposit_retreat() from public, anon, authenticated;

alter table fin_payment_dispositions drop constraint fin_payment_dispositions_disposition_check;
alter table fin_payment_dispositions add constraint fin_payment_dispositions_disposition_check
    check (disposition = any (array['donation', 'refund', 'deposit']));

-- Остаток на балансе: валюта и сумма (advance > 0 — деньги человека у нас)
create or replace function fin_private_deposit_balance(p_participant uuid)
returns table(currency text, advance numeric)
language sql stable security definer set search_path to 'public' as $$
    select b->>'currency', coalesce((b->>'total_advance')::numeric, 0) - coalesce((b->>'total_debt')::numeric, 0)
      from (select fin_private_participant_balance_v2(p_participant, fin_private_deposit_retreat()) b) x;
$$;
revoke all on function fin_private_deposit_balance(uuid) from public, anon, authenticated;

-- ============ Из сигнала: платежи → баланс гостя ============
create or replace function public.fin_deposit_from_payments(payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_actor uuid; v_request_id uuid; v_participant uuid; v_retreat uuid;
  v_container uuid := fin_private_deposit_retreat();
  v_ids uuid[]; v_строк int := 0; v_detail text; d record;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'participant_id', 'retreat_id']);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_retreat     := fin_private_get_uuid(payload, 'retreat_id', true);

  -- Те же платежи, из-за которых горит сигнал (как в fin_resolve_missing_advance)
  select array_agg(cp.id) into v_ids
    from crm_payments cp join crm_deals cd on cd.id = cp.deal_id
   where cd.vaishnava_id = v_participant and cd.retreat_id = v_retreat
     and cp.is_confirmed
     and not exists (select 1 from fin_operations o where o.id = cp.id)
     and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp.id);
  if v_ids is null then
    raise exception 'nothing_to_resolve'
      using detail = 'По этому человеку не осталось неразобранных платежей — сигнал уже погашен';
  end if;

  -- Баланс в контейнере ведётся в одной валюте: вторая валюта — разбирать руками
  if (select count(distinct cp.currency) from crm_payments cp where cp.id = any (v_ids))
     + (select count(*) from fin_private_deposit_balance(v_participant) b
         where b.advance <> 0 and b.currency not in (select cp.currency from crm_payments cp where cp.id = any (v_ids))) > 1 then
    raise exception 'mixed_currencies'
      using detail = 'Платежи в разных валютах — баланс гостя ведётся в одной; разберите вручную';
  end if;

  for d in
    select cp.currency, sum(cp.amount) as сумма, count(*) as n,
           string_agg(cp.amount || ' ' || cp.currency || ' от ' || fin_fmt_date_ru(coalesce(cp.received_at, cp.confirmed_at)::date), ', ') as что,
           min(cd.id::text) as deal_id
      from crm_payments cp join crm_deals cd on cd.id = cp.deal_id
     where cp.id = any (v_ids)
     group by cp.currency
  loop
    insert into fin_participant_opening_balances (
      id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
      source_document, source_row_id, request_hash, comment, created_by
    ) values (
      fin_private_child_uuid(v_request_id, d.currency), v_participant, v_container,
      d.сумма, d.currency, 'credit', 'general',
      'Баланс гостя: оплата отменённого участия', d.deal_id,
      fin_private_hash(jsonb_build_object('command', 'deposit_from_payments',
        'participant_id', lower(v_participant::text), 'retreat_id', lower(v_retreat::text),
        'currency', d.currency, 'amount', fin_private_norm_money(d.сумма))),
      format('С ретрита «%s»: %s', (select coalesce(name_ru, name_en) from retreats where id = v_retreat), d.что),
      v_actor
    ) on conflict (id) do nothing;
    v_строк := v_строк + 1;
  end loop;

  insert into fin_payment_dispositions (payment_id, disposition, occurred_on, note, created_by)
  select u, 'deposit', current_date, 'Участие отменено, деньги оставлены на балансе гостя', v_actor
    from unnest(v_ids) u
  on conflict (payment_id) do nothing;

  -- Итоги сделки в CRM: деньги ушли с ретрита на баланс — «оплачено» там обнуляется
  perform crm_apply_deal_totals(cd.id) from crm_deals cd
    where cd.vaishnava_id = v_participant and cd.retreat_id = v_retreat;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('rows', v_строк, 'payments', array_length(v_ids, 1)),
                            'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;
revoke all on function public.fin_deposit_from_payments(jsonb) from public, anon;
grant execute on function public.fin_deposit_from_payments(jsonb) to authenticated;

-- ============ Зачесть на ретрит ============
create or replace function public.fin_deposit_apply(payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_actor uuid; v_request_id uuid; v_participant uuid; v_retreat uuid; v_amount numeric;
  v_container uuid := fin_private_deposit_retreat();
  v_cur text; v_есть numeric; v_name text; v_detail text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Доступно только администратору финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'participant_id', 'retreat_id', 'amount']);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_retreat     := fin_private_get_uuid(payload, 'retreat_id', true);
  v_amount      := fin_private_get_money(payload, 'amount', true);

  select coalesce(name_ru, name_en) into v_name from retreats where id = v_retreat and not is_system;
  if v_name is null then
    raise exception 'invalid_payload' using detail = 'Ретрит не найден';
  end if;
  select b.currency, b.advance into v_cur, v_есть from fin_private_deposit_balance(v_participant) b;
  if coalesce(v_есть, 0) <= 0.005 then
    raise exception 'no_deposit' using detail = 'На балансе гостя ничего нет';
  end if;
  if v_amount <= 0 or v_amount > v_есть + 0.005 then
    raise exception 'invalid_payload'
      using detail = format('На балансе %s — зачесть можно не больше', fin_fmt_money(v_есть, v_cur));
  end if;

  -- Повтор того же запроса — без второго зачёта
  if exists (select 1 from fin_participant_opening_balances where id = fin_private_child_uuid(v_request_id, 'out')) then
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount, 'currency', v_cur), 'warnings', '[]'::jsonb);
  end if;

  insert into fin_participant_opening_balances (id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
                                                source_document, request_hash, comment, created_by)
  values (fin_private_child_uuid(v_request_id, 'out'), v_participant, v_container, v_amount, v_cur, 'debt', 'general',
          'Баланс гостя: зачтено на ретрит',
          fin_private_hash(jsonb_build_object('command', 'deposit_apply_out', 'request_id', lower(v_request_id::text))),
          format('Зачтено на «%s»', v_name), v_actor),
         (fin_private_child_uuid(v_request_id, 'in'), v_participant, v_retreat, v_amount, v_cur, 'credit', 'general',
          'Баланс гостя: зачтено с баланса',
          fin_private_hash(jsonb_build_object('command', 'deposit_apply_in', 'request_id', lower(v_request_id::text))),
          format('С баланса гостя: %s', fin_fmt_money(v_amount, v_cur)), v_actor);

  -- Итоги сделки в CRM на ретрите, куда зачли: начальные остатки сами их не пересчитывают
  perform crm_apply_deal_totals(cd.id) from crm_deals cd
    where cd.vaishnava_id = v_participant and cd.retreat_id = v_retreat;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('amount', v_amount, 'currency', v_cur), 'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;
revoke all on function public.fin_deposit_apply(jsonb) from public, anon;
grant execute on function public.fin_deposit_apply(jsonb) to authenticated;

-- ============ Вернуть ============
create or replace function public.fin_deposit_refund(payload jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_actor uuid; v_request_id uuid; v_participant uuid; v_account uuid; v_amount numeric; v_on date; v_comment text;
  v_container uuid := fin_private_deposit_retreat();
  v_object uuid; v_acc fin_accounts%rowtype; v_cur text; v_есть numeric; v_rate numeric;
  v_category uuid; v_hash text; v_existing jsonb; v_detail text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Возврат проводит только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'participant_id', 'account_id', 'amount', 'occurred_on', 'comment']);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_account     := fin_private_get_uuid(payload, 'account_id', true);
  v_amount      := fin_private_get_money(payload, 'amount', true);
  v_on          := fin_private_get_date(payload, 'occurred_on', true);
  v_comment     := nullif(trim(coalesce(payload->>'comment', '')), '');

  v_hash := fin_private_hash(jsonb_build_object('command', 'deposit_refund',
    'participant_id', lower(v_participant::text), 'account_id', lower(v_account::text),
    'amount', fin_private_norm_money(v_amount), 'occurred_on', v_on));
  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  end if;

  if v_on > current_date + 1 then
    raise exception 'occurred_on_in_future' using detail = 'Дата возврата в будущем';
  end if;
  select b.currency, b.advance into v_cur, v_есть from fin_private_deposit_balance(v_participant) b;
  if coalesce(v_есть, 0) <= 0.005 then
    raise exception 'no_deposit' using detail = 'На балансе гостя ничего нет';
  end if;
  select * into v_acc from fin_accounts where id = v_account for update;
  if not found or not v_acc.is_active then
    raise exception 'account_not_found' using detail = 'Счёт не найден или деактивирован';
  end if;
  if v_acc.currency_code <> v_cur then
    raise exception 'currency_mismatch'
      using detail = format('Баланс гостя в %s — вернуть можно только со счёта в этой валюте', v_cur);
  end if;
  if v_amount <= 0 or v_amount > v_есть + 0.005 then
    raise exception 'invalid_payload'
      using detail = format('На балансе %s — вернуть можно не больше', fin_fmt_money(v_есть, v_cur));
  end if;
  if v_acc.kind = 'real' and fin_private_account_balance(v_acc.id) - v_amount < 0 then
    raise exception 'insufficient_funds'
      using detail = format('Счёт «%s»: остаток %s, возврат %s', v_acc.name, fin_private_account_balance(v_acc.id), v_amount);
  end if;

  select o.id into v_object from fin_accounting_objects o where o.retreat_id = v_container;
  v_rate := fin_private_get_rate(v_cur, null, v_on);
  select id into v_category from fin_categories where code = 'participant_refund';

  insert into fin_operations (id, request_hash, type, occurred_on, approval,
                              payer_contact_id, refund_recipient_contact_id, comment, created_by)
  values (v_request_id, v_hash, 'refund', v_on, 'not_required',
          v_participant, v_participant, coalesce(v_comment, 'Возврат с баланса гостя'), v_actor);
  insert into fin_postings (id, operation_id, account_id, direction, amount, currency_code,
                            amount_base, rate_used, category_id, cost_center_id, object_id, is_post_close,
                            participant_id, participant_balance_kind)
  values (fin_private_child_uuid(v_request_id, 'posting'), v_request_id, v_acc.id, 'out',
          v_amount, v_cur, round(v_amount * v_rate, 2), v_rate,
          v_category, v_acc.default_cost_center_id, v_object, false,
          v_participant, 'general');

  return jsonb_build_object('ok', true, 'result', fin_private_operation_result(v_request_id), 'warnings', '[]'::jsonb);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;
revoke all on function public.fin_deposit_refund(jsonb) from public, anon;
grant execute on function public.fin_deposit_refund(jsonb) to authenticated;

-- ============ Список ============
-- p_participant — для карточки одного человека; null — все с ненулевым балансом
create or replace function public.fin_get_deposits(p_participant uuid default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_rows jsonb;
begin
  if not fin_can_read_all() then
    return jsonb_build_object('ok', true, 'result', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'participant_id', x.participant_id,
           'name', fin_private_person_name(x.participant_id),
           'currency', b.currency,
           'amount', b.advance,
           'since', x.since,
           'comment', x.comment,
           -- ретриты, на которые человек записан и которые не закончились — куда можно зачесть
           'retreats', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', coalesce(r.name_ru, r.name_en)) order by r.start_date), '[]'::jsonb)
                          from retreats r
                         where not r.is_system and r.end_date >= current_date
                           and (exists (select 1 from retreat_registrations rr where rr.retreat_id = r.id
                                          and rr.vaishnava_id = x.participant_id and rr.status <> 'cancelled')
                             or exists (select 1 from crm_deals d where d.retreat_id = r.id
                                          and d.vaishnava_id = x.participant_id and d.status::text <> 'cancelled')))
         ) order by x.since), '[]'::jsonb)
    into v_rows
    from (select ob.participant_id, min(ob.created_at)::date as since,
                 (array_agg(ob.comment order by ob.created_at) filter (where ob.kind = 'credit'))[1] as comment
            from fin_participant_opening_balances ob
           where ob.retreat_id = fin_private_deposit_retreat()
             and (p_participant is null or ob.participant_id = p_participant)
           group by ob.participant_id) x
    cross join lateral fin_private_deposit_balance(x.participant_id) b
   where b.advance > 0.005;
  return jsonb_build_object('ok', true, 'result', v_rows);
end;
$$;
revoke all on function public.fin_get_deposits(uuid) from public, anon;
grant execute on function public.fin_get_deposits(uuid) to authenticated;
