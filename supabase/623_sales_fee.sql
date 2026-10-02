-- 623: процент отделу продаж за полноценных участников ретрита (решения ВГ 02.10.2026).
-- Полноценный участник — приехал (регистрация не отменена: «не приехал» её снимает) и оплатил
-- оргвзнос не меньше порога (80%) от ПОЛНОГО ВЗРОСЛОГО оргвзноса ретрита в той же валюте.
-- Считается только оплата оргвзноса из финансов (что фактически покрыло блок «Оргвзнос»,
-- включая зачёт из общего и от другого участника), без «Излишек — пожертвование»/«Курсовая разница».
-- Новая система — в валюте расчёта человека против цены оргвзноса в этой валюте;
-- архив (Сева-ретрит, всё в рупиях) — в рупиях, показ в валюте сделки через соотношение цен.
-- Ставка (1500 ₽) и порог (0.8) — настройки; фиксация хранит их снимок.
-- До фиксации — только расчёт. «Зафиксировать» (администратор финансов) проводит трату ретрита
-- «Процент отделу продаж» на счёт «Отдел продаж (₽)» = долг отделу; выдачи — переводы на этот счёт.
-- Перефиксация сторнирует прежнюю операцию и проводит новую на полную сумму.

insert into fin_categories (code, name, direction, visible_to_departments)
select 'sales_percent', 'Процент отделу продаж', 'out', false
where not exists (select 1 from fin_categories where code = 'sales_percent');

insert into fin_settings (key, value) values
  ('sales_fee_rate_rub', '1500'),
  ('sales_fee_threshold', '0.8'),
  ('sales_fee_account_id', 'f00d9a40-72dc-4518-b8e4-07f45c624ff2')
on conflict (key) do nothing;

-- Ручное решение по человеку: засчитать / не засчитывать вопреки формуле
create table if not exists public.fin_sales_fee_overrides (
  retreat_id     uuid not null references public.retreats(id) on delete cascade,
  participant_id uuid not null references public.vaishnavas(id) on delete cascade,
  include        boolean not null,
  comment        text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  primary key (retreat_id, participant_id)
);
alter table public.fin_sales_fee_overrides enable row level security;
revoke all on public.fin_sales_fee_overrides from anon, authenticated;

-- Фиксации: активная одна на ретрит, прежние остаются историей
create table if not exists public.fin_sales_fee_fixations (
  id              uuid primary key default gen_random_uuid(),
  retreat_id      uuid not null references public.retreats(id) on delete cascade,
  operation_id    uuid references public.fin_operations(id),
  rate_rub        numeric not null,
  threshold       numeric not null,
  qualified_count int not null,
  amount_rub      numeric not null,
  rows            jsonb not null,
  comment         text,
  is_active       boolean not null default true,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  superseded_at   timestamptz
);
create unique index if not exists fin_sales_fee_fixations_active
  on public.fin_sales_fee_fixations (retreat_id) where is_active;
alter table public.fin_sales_fee_fixations enable row level security;
revoke all on public.fin_sales_fee_fixations from anon, authenticated;

-- Живой расчёт по ретриту
create or replace function public.fin_private_sales_fee_calc(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
declare
  v_rate numeric := coalesce((select value from fin_settings where key = 'sales_fee_rate_rub')::numeric, 1500);
  v_thr numeric := coalesce((select value from fin_settings where key = 'sales_fee_threshold')::numeric, 0.8);
  v_obj fin_accounting_objects%rowtype;
  v_prices jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_excluded jsonb := '{}'::jsonb;
  v_qualified int := 0;
  v_unposted int;
  v_fix fin_sales_fee_fixations%rowtype;
  r record;
  v_bal jsonb; v_cur text; v_disp text; v_ch numeric; v_debt numeric; v_extra numeric;
  v_paid numeric; v_price numeric; v_pct numeric; v_auto boolean; v_ok boolean; v_k numeric;
  v_flags text[]; v_ov fin_sales_fee_overrides%rowtype;
begin
  select * into v_obj from fin_accounting_objects where retreat_id = p_retreat;

  select jsonb_strip_nulls(jsonb_build_object('INR', p.price, 'RUB', p.price_rub, 'EUR', p.price_eur, 'USD', p.price_usd))
    into v_prices
  from crm_retreat_prices p join crm_services s on s.id = p.service_id
  where p.retreat_id = p_retreat and s.code = 'org_fee'
  limit 1;
  v_prices := coalesce(v_prices, '{}'::jsonb);

  for r in
    select rr.vaishnava_id as pid, rr.status::text as status,
           trim(coalesce(nullif(trim(v.spiritual_name), ''), concat_ws(' ', v.first_name, v.last_name))) as name,
           (select d.currency from crm_deals d where d.retreat_id = p_retreat and d.vaishnava_id = rr.vaishnava_id
             order by (d.status = 'cancelled'), d.updated_at desc limit 1) as deal_cur
    from retreat_registrations rr join vaishnavas v on v.id = rr.vaishnava_id
    where rr.retreat_id = p_retreat and rr.status <> 'cancelled'
  loop
    v_bal := case when v_obj.id is null then null else fin_private_participant_balance_v2(r.pid, p_retreat) end;
    v_cur := coalesce(v_bal->>'currency', 'INR');
    v_ch := coalesce((v_bal->'blocks'->'org_fee'->>'charged')::numeric, 0);
    v_debt := greatest(coalesce((v_bal->'blocks'->'org_fee'->>'balance')::numeric, 0), 0);
    select coalesce(sum(c.amount - c.discount_amount), 0) into v_extra
    from fin_charges c
    where c.participant_id = r.pid and c.retreat_id = p_retreat and c.kind = 'org_fee' and not c.is_cancelled
      and c.currency_code = v_cur
      and (c.description ilike 'Излишек%' or c.description ilike 'Курсовая разница%');

    -- команда/волонтёры/VIP без оргвзноса — только счётчик
    if r.status in ('team', 'volunteer', 'vip') and v_ch = 0 then
      v_excluded := jsonb_set(v_excluded, array[r.status], to_jsonb(coalesce((v_excluded->>r.status)::int, 0) + 1));
      continue;
    end if;

    v_paid := greatest(v_ch - v_debt - v_extra, 0);
    v_price := (v_prices->>v_cur)::numeric;
    v_pct := case when v_price > 0 then v_paid / v_price end;
    v_auto := coalesce(v_pct >= v_thr - 0.00001, false);

    -- показ: новая система — в валюте расчёта; архив в рупиях — в валюте сделки через соотношение цен
    v_disp := v_cur; v_k := 1;
    if v_bal->>'system' = 'legacy_inr' and r.deal_cur is not null and r.deal_cur <> 'INR'
       and (v_prices->>r.deal_cur)::numeric > 0 and v_price > 0 then
      v_disp := r.deal_cur;
      v_k := (v_prices->>r.deal_cur)::numeric / v_price;
    end if;

    v_flags := array[]::text[];
    if v_price is null then v_flags := array_append(v_flags, 'no_price'); end if;
    if v_ch = 0 then v_flags := array_append(v_flags, 'no_charge'); end if;
    if v_auto and v_price > 0 and (v_ch - v_extra) < v_price * 0.99 then v_flags := array_append(v_flags, 'discount_pass'); end if;
    if not v_auto and v_debt > 0 and v_price > 0 and (v_ch - v_extra) >= v_price * v_thr then v_flags := array_append(v_flags, 'debt'); end if;
    if jsonb_array_length(coalesce(v_bal->'problems', '[]'::jsonb)) > 0 then v_flags := array_append(v_flags, 'problems'); end if;

    select * into v_ov from fin_sales_fee_overrides o where o.retreat_id = p_retreat and o.participant_id = r.pid;
    v_ok := case when v_ov.participant_id is not null then v_ov.include else v_auto end;
    if v_ok then v_qualified := v_qualified + 1; end if;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'participant_id', r.pid, 'name', r.name, 'status', r.status,
      'currency', v_disp,
      'price', round(coalesce(v_price, 0) * v_k, 2),
      'charged', round((v_ch - v_extra) * v_k, 2),
      'paid', round(v_paid * v_k, 2),
      'debt', round(v_debt * v_k, 2),
      'pct', round(v_pct * 100, 1),
      'auto', v_auto, 'ok', v_ok,
      'override', case when v_ov.participant_id is null then null
                  else jsonb_build_object('include', v_ov.include, 'comment', v_ov.comment, 'at', v_ov.created_at) end,
      'flags', to_jsonb(v_flags),
      'problems', coalesce(v_bal->'problems', '[]'::jsonb)));
    v_ov := null;
  end loop;

  select count(*) into v_unposted
  from fin_v_unposted_crm_payments u join crm_deals d on d.id = u.deal_id
  where d.retreat_id = p_retreat and u.payment_type = 'org_fee';

  select * into v_fix from fin_sales_fee_fixations where retreat_id = p_retreat and is_active;

  return jsonb_build_object(
    'retreat_id', p_retreat,
    'has_object', v_obj.id is not null,
    'legacy', coalesce(v_obj.legacy_inr_settlement, false),
    'rate_rub', v_rate,
    'threshold', v_thr,
    'prices', v_prices,
    'rows', (select coalesce(jsonb_agg(x order by (x->>'ok')::boolean desc, (x->>'pct')::numeric desc nulls last, x->>'name'), '[]'::jsonb)
             from jsonb_array_elements(v_rows) x),
    'excluded', v_excluded,
    'qualified', v_qualified,
    'amount_rub', v_qualified * v_rate,
    'unposted_crm', v_unposted,
    'fixation', case when v_fix.id is null then null else jsonb_build_object(
      'id', v_fix.id, 'operation_id', v_fix.operation_id, 'created_at', v_fix.created_at,
      'created_by_name', fin_private_person_name((select v.id from vaishnavas v where v.user_id = v_fix.created_by limit 1)),
      'rate_rub', v_fix.rate_rub, 'threshold', v_fix.threshold,
      'qualified_count', v_fix.qualified_count, 'amount_rub', v_fix.amount_rub,
      'comment', v_fix.comment,
      'participant_ids', (select coalesce(jsonb_agg(x->'participant_id'), '[]'::jsonb)
                          from jsonb_array_elements(v_fix.rows) x where (x->>'ok')::boolean)) end
  );
end;
$function$;

create or replace function public.fin_sales_fee_calc(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return fin_private_sales_fee_calc(p_retreat);
end;
$function$;

-- Ретриты со сводкой для выпадашки и итогов
create or replace function public.fin_sales_fee_retreats()
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'name', r.name_ru, 'start_date', r.start_date, 'end_date', r.end_date,
      'fixed_amount_rub', f.amount_rub, 'fixed_count', f.qualified_count, 'fixed_at', f.created_at)
      order by r.start_date desc), '[]'::jsonb)
    from retreats r
    join fin_accounting_objects o on o.retreat_id = r.id
    left join fin_sales_fee_fixations f on f.retreat_id = r.id and f.is_active
    where not coalesce(r.is_system, false)
      and exists (select 1 from crm_retreat_prices p join crm_services s on s.id = p.service_id
                  where p.retreat_id = r.id and s.code = 'org_fee')
  );
end;
$function$;

-- Засчитать / не засчитывать человека вручную (null — вернуть к формуле)
create or replace function public.fin_sales_fee_set_override(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare v_actor uuid; v_detail text; v_retreat uuid; v_pid uuid; v_comment text;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Решение принимает администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['retreat_id', 'participant_id', 'include', 'comment']);
  v_retreat := fin_private_get_uuid(payload, 'retreat_id', true);
  v_pid := fin_private_get_uuid(payload, 'participant_id', true);
  v_comment := nullif(trim(coalesce(payload->>'comment', '')), '');
  if payload->'include' is null or jsonb_typeof(payload->'include') = 'null' then
    delete from fin_sales_fee_overrides where retreat_id = v_retreat and participant_id = v_pid;
  else
    if v_comment is null then
      raise exception 'invalid_payload' using detail = 'Напишите, почему решение расходится с формулой';
    end if;
    insert into fin_sales_fee_overrides (retreat_id, participant_id, include, comment, created_by)
    values (v_retreat, v_pid, (payload->>'include')::boolean, v_comment, v_actor)
    on conflict (retreat_id, participant_id) do update
      set include = excluded.include, comment = excluded.comment,
          created_by = excluded.created_by, created_at = now();
  end if;
  return jsonb_build_object('ok', true);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

-- Ставка и порог
create or replace function public.fin_sales_fee_set_settings(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare v_actor uuid; v_detail text; v_rate numeric; v_thr numeric;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Меняет администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['rate_rub', 'threshold']);
  v_rate := nullif(payload->>'rate_rub', '')::numeric;
  v_thr := nullif(payload->>'threshold', '')::numeric;
  if v_rate is null or v_rate <= 0 then
    raise exception 'invalid_payload' using detail = 'Ставка за человека должна быть больше нуля';
  end if;
  if v_thr is null or v_thr <= 0 or v_thr > 1 then
    raise exception 'invalid_payload' using detail = 'Порог — от 1 до 100%';
  end if;
  update fin_settings set value = v_rate::text, updated_at = now() where key = 'sales_fee_rate_rub';
  update fin_settings set value = v_thr::text, updated_at = now() where key = 'sales_fee_threshold';
  return jsonb_build_object('ok', true);
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

-- Фиксация: трата ретрита на счёт отдела продаж; повторная — сторно прежней + новая на полную сумму
create or replace function public.fin_sales_fee_fix(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $function$
declare
  v_actor uuid; v_detail text; v_retreat uuid; v_comment text;
  v_calc jsonb; v_old fin_sales_fee_fixations%rowtype; v_obj uuid; v_acc uuid; v_cat uuid;
  v_amount numeric; v_count int; v_res jsonb; v_op uuid; v_name text; v_fix uuid;
begin
  v_actor := fin_actor();
  if not fin_is_admin(v_actor) then
    raise exception 'forbidden' using detail = 'Фиксирует администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['retreat_id', 'comment']);
  v_retreat := fin_private_get_uuid(payload, 'retreat_id', true);
  v_comment := nullif(trim(coalesce(payload->>'comment', '')), '');

  -- одна фиксация за раз по ретриту
  perform pg_advisory_xact_lock(hashtext('sales_fee:' || v_retreat::text));

  select id into v_obj from fin_accounting_objects where retreat_id = v_retreat;
  if v_obj is null then
    raise exception 'invalid_payload' using detail = 'У ретрита нет учётного объекта в финансах';
  end if;
  v_acc := (select value from fin_settings where key = 'sales_fee_account_id')::uuid;
  v_cat := (select id from fin_categories where code = 'sales_percent');
  select name_ru into v_name from retreats where id = v_retreat;

  v_calc := fin_private_sales_fee_calc(v_retreat);
  v_count := (v_calc->>'qualified')::int;
  v_amount := (v_calc->>'amount_rub')::numeric;

  select * into v_old from fin_sales_fee_fixations where retreat_id = v_retreat and is_active for update;
  if v_old.id is not null then
    if v_old.amount_rub = v_amount
       and (select coalesce(jsonb_agg(x->'participant_id' order by x->>'participant_id'), '[]'::jsonb)
              from jsonb_array_elements(v_old.rows) x where (x->>'ok')::boolean)
         = (select coalesce(jsonb_agg(x->'participant_id' order by x->>'participant_id'), '[]'::jsonb)
              from jsonb_array_elements(v_calc->'rows') x where (x->>'ok')::boolean) then
      raise exception 'nothing_changed' using detail = 'С прошлой фиксации ничего не изменилось';
    end if;
    if v_old.operation_id is not null then
      v_res := fin_create_reversal(jsonb_build_object(
        'request_id', gen_random_uuid(), 'original_operation_id', v_old.operation_id,
        'occurred_on_policy', 'actual_reverse_date', 'occurred_on', current_date,
        'reason', 'Перефиксация процента отдела продаж'));
      if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception 'reversal_failed' using detail = coalesce(v_res->'error'->>'message', 'Не удалось сторнировать прежнюю фиксацию');
      end if;
    end if;
    update fin_sales_fee_fixations set is_active = false, superseded_at = now() where id = v_old.id;
  end if;

  if v_amount > 0 then
    v_op := gen_random_uuid();
    v_res := fin_create_expense(jsonb_build_object(
      'request_id', v_op,
      'occurred_on', current_date,
      'comment', format('Расчёт процента отдела продаж: %s чел. × %s ₽ — %s', v_count, v_calc->>'rate_rub', v_name)
                 || coalesce(' · ' || v_comment, ''),
      'rows', jsonb_build_array(jsonb_build_object(
        'id', gen_random_uuid(), 'account_id', v_acc, 'amount', v_amount,
        'category_id', v_cat, 'object_id', v_obj))));
    if not coalesce((v_res->>'ok')::boolean, false) then
      raise exception 'expense_failed' using detail = coalesce(v_res->'error'->>'message', 'Не удалось провести трату');
    end if;
  end if;

  insert into fin_sales_fee_fixations (retreat_id, operation_id, rate_rub, threshold, qualified_count, amount_rub, rows, comment, created_by)
  values (v_retreat, v_op, (v_calc->>'rate_rub')::numeric, (v_calc->>'threshold')::numeric, v_count, v_amount,
          v_calc->'rows', v_comment, v_actor)
  returning id into v_fix;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'fixation_id', v_fix, 'operation_id', v_op, 'qualified', v_count, 'amount_rub', v_amount,
    'previous_amount_rub', v_old.amount_rub));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

-- Снимок фиксации (отчёт Олегу)
create or replace function public.fin_sales_fee_fixation(p_fixation uuid)
returns jsonb language plpgsql stable security definer set search_path = public
as $function$
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return (select jsonb_build_object(
    'id', f.id, 'retreat_id', f.retreat_id, 'created_at', f.created_at, 'is_active', f.is_active,
    'rate_rub', f.rate_rub, 'threshold', f.threshold, 'qualified_count', f.qualified_count,
    'amount_rub', f.amount_rub, 'rows', f.rows, 'comment', f.comment,
    'created_by_name', fin_private_person_name((select v.id from vaishnavas v where v.user_id = f.created_by limit 1)))
    from fin_sales_fee_fixations f where f.id = p_fixation);
end;
$function$;

revoke all on function public.fin_private_sales_fee_calc(uuid) from public, anon, authenticated;
revoke all on function public.fin_sales_fee_calc(uuid) from public, anon;
revoke all on function public.fin_sales_fee_retreats() from public, anon;
revoke all on function public.fin_sales_fee_set_override(jsonb) from public, anon;
revoke all on function public.fin_sales_fee_set_settings(jsonb) from public, anon;
revoke all on function public.fin_sales_fee_fix(jsonb) from public, anon;
revoke all on function public.fin_sales_fee_fixation(uuid) from public, anon;
grant execute on function public.fin_sales_fee_calc(uuid) to authenticated;
grant execute on function public.fin_sales_fee_retreats() to authenticated;
grant execute on function public.fin_sales_fee_set_override(jsonb) to authenticated;
grant execute on function public.fin_sales_fee_set_settings(jsonb) to authenticated;
grant execute on function public.fin_sales_fee_fix(jsonb) to authenticated;
grant execute on function public.fin_sales_fee_fixation(uuid) to authenticated;
