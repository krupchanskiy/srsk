-- =============================================================
-- Зарплатная ведомость: вторая вкладка «Наёмные рабочие» — люди со стороны
-- (уборщицы, помощницы на кухне, рабочие Зелёных), которым платят за месяц
-- по листу: дни, часы, начислено, аванс, к выплате. Первая вкладка —
-- «Преданные на окладе» (438_fin_payroll и далее), её не трогаем.
--
-- Рабочие не заводятся в vaishnavas: это не люди общины, список людей
-- не засоряем. Выплата = одна операция на департамент за месяц:
--   (если платил не сам департамент) перевод «кто заплатил» → счёт департамента,
--   затем расход со счёта департамента по статье «Оплата труда», строка на
--   человека. «Кто заплатил» — касса или счёт другого департамента: за август
--   2026 платила стройка, и перевод со счёта «Стройка (₹)» уменьшает её долг
--   перед нами (взаимозачёт, договорённость с Диной Харидасом).
--
-- Себестоимость кухни: выплаты наёмным — накладные кухни за месяц РАБОТЫ
-- (period), а не за месяц оплаты, и без предупреждения «не связано с
-- ведомостью» — они связаны.
-- =============================================================

create table if not exists public.fin_hired_workers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (btrim(name) <> ''),
  department_id uuid not null references public.fin_departments(id),
  -- month — оклад за месяц, day — ставка за день (+ сверхурочный час, если есть)
  pay_kind      text not null check (pay_kind in ('month', 'day')),
  rate          numeric(12,2) check (rate > 0),
  hour_rate     numeric(12,2) check (hour_rate > 0),
  currency_code text not null default 'INR',
  note          text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid default auth.uid()
);
alter table public.fin_hired_workers enable row level security;

create table if not exists public.fin_hired_payments (
  id                uuid primary key default gen_random_uuid(),
  worker_id         uuid not null references public.fin_hired_workers(id),
  period            date not null check (period = date_trunc('month', period)::date),
  days              numeric(5,1) check (days >= 0),
  hours             numeric(6,1) check (hours >= 0),
  accrued           numeric(12,2) check (accrued >= 0),
  advance           numeric(12,2) not null default 0 check (advance >= 0),
  source_account_id uuid references public.fin_accounts(id),
  posting_id        uuid not null unique references public.fin_postings(id),
  created_at        timestamptz not null default now()
);
create index if not exists fin_hired_payments_worker_idx on public.fin_hired_payments (worker_id, period);
alter table public.fin_hired_payments enable row level security;

create or replace view public.fin_v_hired_workers as
  select w.id, w.name, w.department_id, d.name as department_name, w.pay_kind, w.rate, w.hour_rate,
         w.currency_code, w.note, w.is_active, w.created_at
    from fin_hired_workers w
    join fin_departments d on d.id = w.department_id
   where fin_is_admin();

create or replace view public.fin_v_hired_payments as
  select hp.id, hp.worker_id, hp.period, hp.days, hp.hours, hp.accrued, hp.advance,
         hp.source_account_id, sa.name as source_account_name,
         po.amount, po.currency_code, o.id as operation_id, o.occurred_on, o.comment, o.is_reversed
    from fin_hired_payments hp
    join fin_postings po on po.id = hp.posting_id
    join fin_operations o on o.id = po.operation_id
    left join fin_accounts sa on sa.id = hp.source_account_id
   where fin_is_admin();

grant select on public.fin_v_hired_workers, public.fin_v_hired_payments to authenticated;

-- ---------- рабочий: завести / изменить ----------
create or replace function public.fin_hired_worker_save(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_kind text;
  v_detail text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['id', 'name', 'department_id', 'pay_kind', 'rate', 'hour_rate', 'note', 'is_active']);

  v_kind := coalesce(payload->>'pay_kind', 'day');
  if v_kind not in ('month', 'day') then
    raise exception 'invalid_payload' using detail = 'Способ оплаты: оклад за месяц или ставка за день';
  end if;
  if nullif(btrim(coalesce(payload->>'name', '')), '') is null then
    raise exception 'invalid_payload' using detail = 'Укажите имя';
  end if;

  v_id := fin_private_get_uuid(payload, 'id', false);
  if v_id is null then
    insert into fin_hired_workers (name, department_id, pay_kind, rate, hour_rate, note)
    values (btrim(payload->>'name'), fin_private_get_uuid(payload, 'department_id', true), v_kind,
            fin_private_get_money(payload, 'rate', false), fin_private_get_money(payload, 'hour_rate', false),
            nullif(btrim(coalesce(payload->>'note', '')), ''))
    returning id into v_id;
  else
    update fin_hired_workers set
      name          = btrim(payload->>'name'),
      department_id = fin_private_get_uuid(payload, 'department_id', true),
      pay_kind      = v_kind,
      rate          = fin_private_get_money(payload, 'rate', false),
      hour_rate     = fin_private_get_money(payload, 'hour_rate', false),
      note          = nullif(btrim(coalesce(payload->>'note', '')), ''),
      is_active     = coalesce((payload->>'is_active')::boolean, is_active)
    where id = v_id;
    if not found then
      raise exception 'invalid_payload' using detail = 'Рабочий не найден';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

-- ---------- ведомость департамента за месяц: провести ----------
-- payload: request_id (uuid формы — повторное нажатие ничего не задвоит),
--   department_id, period ('YYYY-MM-01'), occurred_on, source_account_id
--   (кто заплатил), comment, rows: [{worker_id, days, hours, accrued, advance, amount}]
create or replace function public.fin_hired_pay(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_req uuid;
  v_dept uuid;
  v_dept_name text;
  v_period date;
  v_on date;
  v_src uuid;
  v_src_cur text;
  v_acc uuid;
  v_cat uuid;
  v_rows jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_n int := 0;
  v_r jsonb;
  v_w fin_hired_workers%rowtype;
  v_amount numeric;
  v_comment text;
  v_res jsonb;
  v_detail text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['request_id', 'department_id', 'period', 'occurred_on', 'source_account_id', 'comment', 'rows']);

  v_req    := fin_private_get_uuid(payload, 'request_id', true);
  v_dept   := fin_private_get_uuid(payload, 'department_id', true);
  v_period := date_trunc('month', fin_private_get_date(payload, 'period', true))::date;
  v_on     := coalesce(fin_private_get_date(payload, 'occurred_on', false), (v_period + interval '1 month - 1 day')::date);
  v_src    := fin_private_get_uuid(payload, 'source_account_id', true);

  select name into v_dept_name from fin_departments where id = v_dept;
  if v_dept_name is null then
    raise exception 'invalid_payload' using detail = 'Департамент не найден';
  end if;
  select currency_code into v_src_cur from fin_accounts where id = v_src and is_active;
  if v_src_cur is null then
    raise exception 'invalid_payload' using detail = 'Счёт «Кто заплатил» не найден';
  end if;

  select id into v_cat from fin_categories where code = 'dept_labor' and is_active;
  if v_cat is null then
    raise exception 'internal_error' using detail = 'Статья «Оплата труда» не найдена в справочнике';
  end if;

  for v_r in select * from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) loop
    v_amount := nullif(v_r->>'amount', '')::numeric;
    continue when coalesce(v_amount, 0) = 0;
    if v_amount < 0 then
      raise exception 'invalid_payload' using detail = 'Сумма к выплате не может быть меньше нуля';
    end if;
    select * into v_w from fin_hired_workers where id = (v_r->>'worker_id')::uuid;
    if not found or v_w.department_id <> v_dept then
      raise exception 'invalid_payload' using detail = 'Рабочий не из этого департамента';
    end if;
    if v_w.currency_code <> v_src_cur then
      raise exception 'invalid_payload' using detail = format('Валюта счёта не совпадает с валютой рабочего (%s)', v_w.name);
    end if;
    v_n := v_n + 1;
    v_total := v_total + v_amount;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', fin_private_child_uuid(v_req, 'hired-row-' || v_w.id::text),
      'worker_id', v_w.id, 'amount', v_amount,
      'days', nullif(v_r->>'days', '')::numeric, 'hours', nullif(v_r->>'hours', '')::numeric,
      'accrued', nullif(v_r->>'accrued', '')::numeric, 'advance', coalesce(nullif(v_r->>'advance', '')::numeric, 0)));
  end loop;
  if v_n = 0 then
    raise exception 'invalid_payload' using detail = 'Нет ни одной суммы к выплате';
  end if;

  v_comment := format('Наёмные рабочие за %s — %s чел.', to_char(v_period, 'MM.YYYY'), v_n)
            || coalesce(' — ' || nullif(btrim(coalesce(payload->>'comment', '')), ''), '');
  v_acc := fin_dept_account(v_dept, v_src_cur);

  -- суммы зарплат в чаты не уходят (как в ведомости преданных, 683)
  perform set_config('tg.suppress_chat_notify', '1', true);

  if v_src <> v_acc then
    v_res := fin_create_transfer(jsonb_build_object(
      'request_id', fin_private_child_uuid(v_req, 'hired-transfer'),
      'occurred_on', v_on,
      'source_account_id', v_src, 'target_account_id', v_acc,
      'source_amount', v_total, 'target_amount', null,
      'comment', v_comment || ' — за департамент «' || v_dept_name || '»'));
    if not coalesce((v_res->>'ok')::boolean, false) then
      raise exception 'internal_error' using detail = coalesce(v_res#>>'{error,message}', 'не удалось передать сумму');
    end if;
  end if;

  v_res := fin_create_expense(jsonb_build_object(
    'request_id', v_req,
    'occurred_on', v_on,
    'comment', v_comment,
    'rows', (select jsonb_agg(jsonb_build_object(
               'id', r->>'id', 'account_id', v_acc, 'amount', (r->>'amount')::numeric,
               'category_id', v_cat))
               from jsonb_array_elements(v_rows) r)));
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'internal_error' using detail = coalesce(v_res#>>'{error,message}', 'не удалось провести расход');
  end if;

  insert into fin_hired_payments (worker_id, period, days, hours, accrued, advance, source_account_id, posting_id)
  select (r->>'worker_id')::uuid, v_period, (r->>'days')::numeric, (r->>'hours')::numeric,
         (r->>'accrued')::numeric, (r->>'advance')::numeric, v_src, (r->>'id')::uuid
    from jsonb_array_elements(v_rows) r
  on conflict (posting_id) do nothing;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('operation_id', v_req, 'total', v_total, 'count', v_n));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

revoke all on function public.fin_hired_worker_save(jsonb), public.fin_hired_pay(jsonb) from public, anon;
grant execute on function public.fin_hired_worker_save(jsonb), public.fin_hired_pay(jsonb) to authenticated;

-- ---------- себестоимость кухни: наёмные — за месяц работы, связаны ----------
create or replace function public.fin_kitchen_overhead_items(p_from date, p_to date)
returns table (posting_id uuid, occurred_on date, category_name text, kind text, confirmed boolean,
               amount_base numeric, retreat_id uuid, eff_from date, eff_to date, comment text, labor_unlinked boolean)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not fin_kitchen_can_view() then
    raise exception 'forbidden' using detail = 'Нет права на просмотр';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'invalid_payload' using detail = 'Некорректный период';
  end if;

  return query
    select x.id, x.occurred_on, x.cname, x.kind, x.confirmed, x.amount_base, x.retreat_id, x.eff_from, x.eff_to, x.comment, x.labor
      from (
        select b.id, b.occurred_on, b.cname, b.kind, b.confirmed, b.amount_base, b.retreat_id, b.comment,
               (b.ccode = 'dept_labor' and b.hired_period is null) as labor,
               case b.kind when 'retreat_event' then b.rs
                           when 'retreat_period' then b.period_from
                           else coalesce(b.period_from, b.hired_period, date_trunc('month', b.occurred_on)::date) end as eff_from,
               case b.kind when 'retreat_event' then b.re
                           when 'retreat_period' then b.period_to
                           else coalesce(b.period_to, (coalesce(b.hired_period, date_trunc('month', b.occurred_on)::date) + interval '1 month - 1 day')::date) end as eff_to
          from (
            select p.id, o.occurred_on, c.name as cname, c.code as ccode,
                   (g.cost_group is not null) as confirmed, p.amount_base, o.comment,
                   dd.mode as dmode, dd.period_from, dd.period_to, ao.retreat_id, r.start_date as rs, r.end_date as re,
                   hp.period as hired_period,
                   case
                     when coalesce(g.cost_group, 'general') = 'retreat' and ao.retreat_id is not null then 'retreat_event'
                     when coalesce(g.cost_group, 'general') = 'retreat' and dd.mode = 'period' then 'retreat_period'
                     when coalesce(g.cost_group, 'general') = 'retreat' and dd.mode is null then 'unassigned'
                     else 'general'
                   end as kind
              from fin_postings p
              join fin_operations o on o.id = p.operation_id
              join fin_accounts a on a.id = p.account_id
              join fin_departments d on d.id = a.department_id and d.code = 'kitchen'
              join fin_categories c on c.id = p.category_id
              left join fin_cost_groups g on g.category_id = c.id
              left join fin_posting_destinations dd on dd.posting_id = p.id
              left join fin_accounting_objects ao on ao.id = p.object_id
              left join retreats r on r.id = ao.retreat_id
              left join fin_hired_payments hp on hp.posting_id = p.id
             where p.direction::text = 'out' and o.type::text = 'expense' and not o.is_reversed
               and coalesce(g.cost_group, 'general') not in ('direct', 'excluded')
               and not exists (select 1 from fin_payroll_payments pp where pp.posting_id = p.id)
          ) b
      ) x
     where x.eff_from is not null and x.eff_to is not null
       and x.eff_from <= p_to and x.eff_to >= p_from
     order by x.occurred_on;
end;
$$;

insert into translations (key, ru, en, hi) values
  ('fin_payroll_tab_salaried', 'Преданные на окладе', 'Salaried devotees', 'वेतनभोगी भक्त'),
  ('fin_payroll_tab_hired', 'Наёмные рабочие', 'Hired workers', 'किराए के कर्मचारी'),
  ('fin_hired_add_worker', 'Добавить рабочего', 'Add worker', 'कर्मचारी जोड़ें'),
  ('fin_hired_edit_worker', 'Рабочий', 'Worker', 'कर्मचारी'),
  ('fin_hired_enter_sheet', 'Внести ведомость', 'Enter pay sheet', 'वेतन पत्रक दर्ज करें'),
  ('fin_hired_name', 'Имя', 'Name', 'नाम'),
  ('fin_hired_department', 'Департамент', 'Department', 'विभाग'),
  ('fin_hired_pay_kind', 'Оплата', 'Pay', 'भुगतान'),
  ('fin_hired_kind_month', 'Оклад за месяц', 'Monthly salary', 'मासिक वेतन'),
  ('fin_hired_kind_day', 'Ставка за день', 'Daily rate', 'दैनिक दर'),
  ('fin_hired_rate', 'Оклад / ставка', 'Salary / rate', 'वेतन / दर'),
  ('fin_hired_hour_rate', 'Сверхурочный час', 'Overtime hour', 'ओवरटाइम घंटा'),
  ('fin_hired_per_day', 'день', 'day', 'दिन'),
  ('fin_hired_per_hour', 'ч', 'h', 'घं'),
  ('fin_hired_per_month', 'мес.', 'mo.', 'माह'),
  ('fin_hired_days', 'Дни', 'Days', 'दिन'),
  ('fin_hired_hours', 'Часы', 'Hours', 'घंटे'),
  ('fin_hired_accrued', 'Начислено', 'Accrued', 'अर्जित'),
  ('fin_hired_advance', 'Аванс', 'Advance', 'अग्रिम'),
  ('fin_hired_to_pay', 'К выплате', 'To pay', 'देय'),
  ('fin_hired_paid_by', 'Кто заплатил', 'Paid by', 'किसने भुगतान किया'),
  ('fin_hired_month', 'Месяц работы', 'Month of work', 'कार्य का महीना'),
  ('fin_hired_pay_date', 'Дата проводки', 'Posting date', 'प्रविष्टि तिथि'),
  ('fin_hired_total', 'Итого', 'Total', 'कुल'),
  ('fin_hired_post', 'Провести', 'Post', 'दर्ज करें'),
  ('fin_hired_no_workers', 'Рабочих пока нет', 'No workers yet', 'अभी कोई कर्मचारी नहीं'),
  ('fin_hired_not_paid', 'нет выплаты', 'not paid', 'भुगतान नहीं'),
  ('fin_hired_already_paid', 'Уже есть выплата за этот месяц', 'Already paid for this month', 'इस महीने का भुगतान पहले से है'),
  ('fin_hired_posted', 'Ведомость проведена', 'Pay sheet posted', 'वेतन पत्रक दर्ज'),
  ('fin_hired_inactive', 'не работает', 'inactive', 'निष्क्रिय'),
  ('fin_hired_active', 'Работает', 'Active', 'सक्रिय'),
  ('fin_hired_note', 'Заметка', 'Note', 'टिप्पणी')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
