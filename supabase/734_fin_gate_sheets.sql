-- =============================================================
-- «Оплаты с проходной» (ВГ, 22.10.2026). Месячный лист от плательщика —
-- сейчас стройка (Дина Харидас), потом может быть наша касса: кто-то заплатил
-- людям и поставщикам за месяц и прислал список. Лист вставляется из Excel,
-- каждая строка разносится: что это (статья) и чьё — один департамент,
-- «не наше» (хранится для сверки, не проводится) или по долям (этап 2,
-- таблица долей заложена сразу).
--
-- «Провести» лист = по каждому департаменту перевод с плательщика на счёт
-- департамента + расход строками листа, дата — последний день месяца.
-- Плательщик «Стройка (₹)» — это взаимозачёт: перевод уменьшает её долг перед нами.
-- Строки «Оплата труда» с именем привязываются к наёмному рабочему (733):
-- рабочий заводится сам при проводке, выплата ложится в fin_hired_payments —
-- ведомость наёмных и себестоимость кухни за месяц работы.
-- =============================================================

create table if not exists public.fin_gate_sheets (
  id               uuid primary key default gen_random_uuid(),
  period           date not null check (period = date_trunc('month', period)::date),
  payer_account_id uuid not null references public.fin_accounts(id),
  sheet_total      numeric(14,2),           -- итог, как написан в листе (для сверки)
  note             text,
  status           text not null default 'draft' check (status in ('draft', 'posted')),
  posted_at        timestamptz,
  posted_by        uuid,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  updated_at       timestamptz not null default now(),
  unique (period, payer_account_id)
);
alter table public.fin_gate_sheets enable row level security;

create table if not exists public.fin_gate_rows (
  id            uuid primary key default gen_random_uuid(),
  sheet_id      uuid not null references public.fin_gate_sheets(id) on delete cascade,
  position      int not null,
  section       text,                     -- раздел листа («SALARY FOR KITCHEN OF AUG»)
  name          text not null check (btrim(name) <> ''),
  days          numeric(5,1),
  hours         numeric(6,1),
  rate          numeric(12,2),
  advance       numeric(12,2),            -- для справки: в итог не входит
  amount        numeric(14,2) not null,   -- к выплате (колонка TOTAL)
  category_id   uuid references public.fin_categories(id),
  -- dept — один департамент; not_ours — не наше, только для сверки; split — по долям
  alloc         text check (alloc in ('dept', 'not_ours', 'split')),
  department_id uuid references public.fin_departments(id),
  note          text,
  worker_id     uuid references public.fin_hired_workers(id),
  posting_id    uuid unique references public.fin_postings(id),
  check (alloc is distinct from 'dept' or department_id is not null)
);
create index if not exists fin_gate_rows_sheet_idx on public.fin_gate_rows (sheet_id, position);
alter table public.fin_gate_rows enable row level security;

-- Доли строки по департаментам (этап 2: офис, охрана, электричество)
create table if not exists public.fin_gate_row_shares (
  row_id        uuid not null references public.fin_gate_rows(id) on delete cascade,
  department_id uuid not null references public.fin_departments(id),
  share_pct     numeric(5,2) not null check (share_pct > 0 and share_pct <= 100),
  posting_id    uuid unique references public.fin_postings(id),
  primary key (row_id, department_id)
);
alter table public.fin_gate_row_shares enable row level security;

create or replace view public.fin_v_gate_sheets as
  select s.id, s.period, s.payer_account_id, a.name as payer_account_name, a.currency_code,
         s.sheet_total, s.note, s.status, s.posted_at, s.created_at, s.updated_at
    from fin_gate_sheets s
    join fin_accounts a on a.id = s.payer_account_id
   where fin_is_admin();

create or replace view public.fin_v_gate_rows as
  select r.id, r.sheet_id, r.position, r.section, r.name, r.days, r.hours, r.rate, r.advance, r.amount,
         r.category_id, c.name as category_name, r.alloc, r.department_id, d.name as department_name,
         r.note, r.worker_id, r.posting_id
    from fin_gate_rows r
    left join fin_categories c on c.id = r.category_id
    left join fin_departments d on d.id = r.department_id
   where fin_is_admin();

grant select on public.fin_v_gate_sheets, public.fin_v_gate_rows to authenticated;

-- ---------- лист: сохранить черновик (строки заменяются целиком) ----------
-- payload: id (нет — новый), period, payer_account_id, sheet_total, note,
--   rows: [{section, name, days, hours, rate, advance, amount, category_id, alloc, department_id, note}]
create or replace function public.fin_gate_sheet_save(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
  v_period date;
  v_payer uuid;
  v_r jsonb;
  v_pos int := 0;
  v_alloc text;
  v_detail text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['id', 'period', 'payer_account_id', 'sheet_total', 'note', 'rows']);

  v_id     := fin_private_get_uuid(payload, 'id', false);
  v_period := date_trunc('month', fin_private_get_date(payload, 'period', true))::date;
  v_payer  := fin_private_get_uuid(payload, 'payer_account_id', true);
  if not exists (select 1 from fin_accounts where id = v_payer and is_active) then
    raise exception 'invalid_payload' using detail = 'Плательщик не найден';
  end if;

  if v_id is null then
    if exists (select 1 from fin_gate_sheets where period = v_period and payer_account_id = v_payer) then
      raise exception 'invalid_payload' using detail = 'Лист этого плательщика за этот месяц уже есть — откройте его';
    end if;
    insert into fin_gate_sheets (period, payer_account_id, sheet_total, note)
    values (v_period, v_payer, nullif(payload->>'sheet_total', '')::numeric,
            nullif(btrim(coalesce(payload->>'note', '')), ''))
    returning id into v_id;
  else
    select status into v_status from fin_gate_sheets where id = v_id for update;
    if v_status is null then
      raise exception 'invalid_payload' using detail = 'Лист не найден';
    end if;
    if v_status <> 'draft' then
      raise exception 'invalid_payload' using detail = 'Лист уже проведён — менять нельзя';
    end if;
    update fin_gate_sheets set
      period = v_period, payer_account_id = v_payer,
      sheet_total = nullif(payload->>'sheet_total', '')::numeric,
      note = nullif(btrim(coalesce(payload->>'note', '')), ''),
      updated_at = now()
    where id = v_id;
    delete from fin_gate_rows where sheet_id = v_id;
  end if;

  for v_r in select * from jsonb_array_elements(coalesce(payload->'rows', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_alloc := nullif(v_r->>'alloc', '');
    if v_alloc = 'dept' and nullif(v_r->>'department_id', '') is null then
      v_alloc := null;
    end if;
    insert into fin_gate_rows (sheet_id, position, section, name, days, hours, rate, advance, amount,
                               category_id, alloc, department_id, note)
    values (v_id, v_pos, nullif(btrim(coalesce(v_r->>'section', '')), ''), btrim(v_r->>'name'),
            nullif(v_r->>'days', '')::numeric, nullif(v_r->>'hours', '')::numeric,
            nullif(v_r->>'rate', '')::numeric, nullif(v_r->>'advance', '')::numeric,
            coalesce(nullif(v_r->>'amount', '')::numeric, 0),
            nullif(v_r->>'category_id', '')::uuid, v_alloc,
            case when v_alloc = 'dept' then nullif(v_r->>'department_id', '')::uuid end,
            nullif(btrim(coalesce(v_r->>'note', '')), ''));
  end loop;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id, 'count', v_pos));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

-- ---------- лист: удалить черновик ----------
create or replace function public.fin_gate_sheet_delete(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
  v_detail text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['id']);
  v_id := fin_private_get_uuid(payload, 'id', true);
  delete from fin_gate_sheets where id = v_id and status = 'draft';
  if not found then
    raise exception 'invalid_payload' using detail = 'Черновик не найден (проведённый лист не удаляется)';
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

-- ---------- лист: провести ----------
-- payload: sheet_id, request_id (uuid формы — повторное нажатие ничего не задвоит)
-- Все строки должны быть разнесены. По каждому департаменту: перевод плательщик →
-- счёт департамента (если это не он сам) и расход строками листа.
create or replace function public.fin_gate_sheet_post(payload jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_req uuid;
  v_sheet fin_gate_sheets%rowtype;
  v_payer_cur text;
  v_payer_name text;
  v_on date;
  v_labor uuid;
  v_dept record;
  v_acc uuid;
  v_comment text;
  v_res jsonb;
  v_r fin_gate_rows%rowtype;
  v_worker uuid;
  v_accrued numeric;
  v_kind text;
  v_rate numeric;
  v_hour numeric;
  v_total numeric := 0;
  v_ndept int := 0;
  v_bad text;
  v_detail text;
begin
  if not fin_is_admin() then
    raise exception 'forbidden' using detail = 'Только администратор финансов';
  end if;
  perform fin_private_assert_keys(payload, array['sheet_id', 'request_id']);
  v_req := fin_private_get_uuid(payload, 'request_id', true);

  select * into v_sheet from fin_gate_sheets where id = fin_private_get_uuid(payload, 'sheet_id', true) for update;
  if v_sheet.id is null then
    raise exception 'invalid_payload' using detail = 'Лист не найден';
  end if;
  if v_sheet.status <> 'draft' then
    raise exception 'invalid_payload' using detail = 'Лист уже проведён';
  end if;

  select string_agg(format('%s. %s', position, name), ', ' order by position) into v_bad
    from fin_gate_rows where sheet_id = v_sheet.id and alloc is null;
  if v_bad is not null then
    raise exception 'invalid_payload' using detail = 'Не разнесены строки: ' || v_bad;
  end if;
  if exists (select 1 from fin_gate_rows where sheet_id = v_sheet.id and alloc = 'split') then
    raise exception 'invalid_payload' using detail = 'Доли пока не проводятся — разнесите строку на один департамент или «не наше»';
  end if;
  select string_agg(format('%s. %s', position, name), ', ' order by position) into v_bad
    from fin_gate_rows where sheet_id = v_sheet.id and alloc = 'dept' and (amount < 0 or category_id is null);
  if v_bad is not null then
    raise exception 'invalid_payload' using detail = 'Нет статьи или сумма меньше нуля: ' || v_bad;
  end if;

  select currency_code, name into v_payer_cur, v_payer_name from fin_accounts where id = v_sheet.payer_account_id;
  v_on := (v_sheet.period + interval '1 month - 1 day')::date;
  select id into v_labor from fin_categories where code = 'dept_labor';

  -- суммы зарплат в чаты не уходят (как в ведомостях 683/733)
  perform set_config('tg.suppress_chat_notify', '1', true);

  for v_dept in
    select r.department_id, d.name, sum(r.amount) as total, count(*) as n
      from fin_gate_rows r join fin_departments d on d.id = r.department_id
     where r.sheet_id = v_sheet.id and r.alloc = 'dept' and r.amount > 0
     group by r.department_id, d.name order by d.name
  loop
    v_acc := fin_dept_account(v_dept.department_id, v_payer_cur);
    v_comment := format('Оплаты с проходной: лист %s за %s — %s', v_payer_name, to_char(v_sheet.period, 'MM.YYYY'), v_dept.name);

    if v_sheet.payer_account_id <> v_acc then
      v_res := fin_create_transfer(jsonb_build_object(
        'request_id', fin_private_child_uuid(v_req, 'gate-transfer-' || v_dept.department_id::text),
        'occurred_on', v_on,
        'source_account_id', v_sheet.payer_account_id, 'target_account_id', v_acc,
        'source_amount', v_dept.total, 'target_amount', null,
        'comment', v_comment));
      if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception 'internal_error' using detail = coalesce(v_res#>>'{error,message}', 'не удалось передать сумму');
      end if;
    end if;

    v_res := fin_create_expense(jsonb_build_object(
      'request_id', fin_private_child_uuid(v_req, 'gate-expense-' || v_dept.department_id::text),
      'occurred_on', v_on,
      'comment', v_comment,
      'rows', (select jsonb_agg(jsonb_build_object(
                 'id', fin_private_child_uuid(v_req, 'gate-row-' || r.id::text),
                 'account_id', v_acc, 'amount', r.amount, 'category_id', r.category_id,
                 'note', r.name
                   || coalesce(' · ' || trim_scale(nullif(r.days, 0))::text || ' дн.', '')
                   || coalesce(' · ' || trim_scale(nullif(r.hours, 0))::text || ' ч', '')
                   || coalesce(' · аванс ' || trim_scale(nullif(r.advance, 0))::text, ''))
                 order by r.position)
                 from fin_gate_rows r
                where r.sheet_id = v_sheet.id and r.alloc = 'dept' and r.amount > 0
                  and r.department_id = v_dept.department_id)));
    if not coalesce((v_res->>'ok')::boolean, false) then
      raise exception 'internal_error' using detail = coalesce(v_res#>>'{error,message}', 'не удалось провести расход');
    end if;

    v_total := v_total + v_dept.total;
    v_ndept := v_ndept + 1;
  end loop;

  -- связь строк с проводками и наёмными рабочими
  for v_r in
    select * from fin_gate_rows
     where sheet_id = v_sheet.id and alloc = 'dept' and amount > 0 order by position
  loop
    v_worker := null;
    if v_r.category_id = v_labor then
      select id into v_worker from fin_hired_workers
       where department_id = v_r.department_id and lower(btrim(name)) = lower(btrim(v_r.name))
         and currency_code = v_payer_cur
       order by is_active desc, created_at limit 1;
      if v_worker is null then
        -- способ оплаты угадываем по листу; поправить можно в ведомости наёмных
        v_accrued := v_r.amount + coalesce(v_r.advance, 0);
        v_hour := null;
        if v_r.rate is not null and abs(v_accrued - v_r.rate) < 1 then
          v_kind := 'month'; v_rate := v_r.rate;
        elsif coalesce(v_r.days, 0) > 0 then
          v_kind := 'day';
          if coalesce(v_r.hours, 0) > 0 and v_r.rate is not null and v_r.rate * v_r.days < v_accrued then
            v_rate := v_r.rate;
            v_hour := round((v_accrued - v_r.rate * v_r.days) / v_r.hours, 2);
          else
            v_rate := round(v_accrued / v_r.days, 2);
          end if;
        else
          v_kind := 'month'; v_rate := nullif(v_r.rate, 0);
        end if;
        insert into fin_hired_workers (name, department_id, pay_kind, rate, hour_rate, currency_code)
        values (initcap(lower(btrim(v_r.name))), v_r.department_id, v_kind, nullif(v_rate, 0), nullif(v_hour, 0), v_payer_cur)
        returning id into v_worker;
      end if;
      insert into fin_hired_payments (worker_id, period, days, hours, accrued, advance, source_account_id, posting_id)
      values (v_worker, v_sheet.period, v_r.days, v_r.hours, v_r.amount + coalesce(v_r.advance, 0),
              coalesce(v_r.advance, 0), v_sheet.payer_account_id, fin_private_child_uuid(v_req, 'gate-row-' || v_r.id::text))
      on conflict (posting_id) do nothing;
    end if;
    update fin_gate_rows set posting_id = fin_private_child_uuid(v_req, 'gate-row-' || v_r.id::text),
                             worker_id = v_worker
     where id = v_r.id;
  end loop;

  update fin_gate_sheets set status = 'posted', posted_at = now(), posted_by = auth.uid(), updated_at = now()
   where id = v_sheet.id;

  return jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_sheet.id, 'total', v_total, 'departments', v_ndept));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  if sqlerrm ~ '^[a-z_]{3,60}$' then
    return jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  end if;
  return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

revoke all on function public.fin_gate_sheet_save(jsonb), public.fin_gate_sheet_delete(jsonb), public.fin_gate_sheet_post(jsonb) from public, anon;
grant execute on function public.fin_gate_sheet_save(jsonb), public.fin_gate_sheet_delete(jsonb), public.fin_gate_sheet_post(jsonb) to authenticated;

insert into translations (key, ru, en, hi) values
  ('nav_fin_gate', 'Оплаты с проходной', 'Gate payments', 'गेट भुगतान'),
  ('fin_page_title_gate', 'Оплаты с проходной — Финансы — ШРСК', 'Gate payments — Finance — SRSK', 'गेट भुगतान — वित्त — SRSK'),
  ('fin_gate_new_sheet', 'Новый лист', 'New sheet', 'नई शीट'),
  ('fin_gate_payer', 'Плательщик', 'Payer', 'भुगतानकर्ता'),
  ('fin_gate_month', 'Месяц', 'Month', 'महीना'),
  ('fin_gate_sheet_total', 'Итог в листе', 'Sheet total', 'शीट का कुल'),
  ('fin_gate_paste', 'Вставьте таблицу из Excel', 'Paste the table from Excel', 'Excel से तालिका चिपकाएँ'),
  ('fin_gate_paste_hint', 'Выделите в Excel весь лист (Ctrl+A), скопируйте и вставьте сюда. Разделы, имена, дни, ставка, аванс и «к выплате» разберутся сами.', 'Select the whole sheet in Excel (Ctrl+A), copy and paste here. Sections, names, days, rate, advance and total are recognised automatically.', 'Excel में पूरी शीट चुनें (Ctrl+A), कॉपी करें और यहाँ चिपकाएँ।'),
  ('fin_gate_parse', 'Разобрать', 'Parse', 'पार्स करें'),
  ('fin_gate_section', 'Раздел', 'Section', 'अनुभाग'),
  ('fin_gate_what', 'Статья', 'Category', 'मद'),
  ('fin_gate_whose', 'Чьё', 'Whose', 'किसका'),
  ('fin_gate_not_ours', 'Не наше', 'Not ours', 'हमारा नहीं'),
  ('fin_gate_split', 'По долям', 'Split', 'हिस्सों में'),
  ('fin_gate_unallocated', 'Не разнесено', 'Not allocated', 'आवंटित नहीं'),
  ('fin_gate_ours', 'Наше', 'Ours', 'हमारा'),
  ('fin_gate_debt_before', 'Долг до', 'Debt before', 'पहले का ऋण'),
  ('fin_gate_debt_after', 'Долг после', 'Debt after', 'बाद का ऋण'),
  ('fin_gate_rows_sum', 'Сумма строк', 'Rows sum', 'पंक्तियों का योग'),
  ('fin_gate_post', 'Провести лист', 'Post sheet', 'शीट दर्ज करें'),
  ('fin_gate_posted', 'Лист проведён', 'Sheet posted', 'शीट दर्ज'),
  ('fin_gate_status_draft', 'Черновик', 'Draft', 'मसौदा'),
  ('fin_gate_status_posted', 'Проведён', 'Posted', 'दर्ज'),
  ('fin_gate_no_sheets', 'Листов пока нет', 'No sheets yet', 'अभी कोई शीट नहीं'),
  ('fin_gate_print', 'Распечатать', 'Print', 'प्रिंट'),
  ('fin_gate_all_section', 'весь раздел', 'whole section', 'पूरा अनुभाग'),
  ('fin_gate_by_dept', 'По департаментам', 'By department', 'विभाग अनुसार'),
  ('fin_gate_delete', 'Удалить черновик', 'Delete draft', 'मसौदा हटाएँ')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
