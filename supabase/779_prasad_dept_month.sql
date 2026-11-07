-- 779: Питание по департаментам — итоги по месяцам в базе (ВГ 04.11, «Департаменты 5»)
--
-- Расчёт — тот же js/kitchen-cost.js (KitchenCost.byDepartment): точная цена каждого приёма пищи,
-- департамент места → история служения → «без департамента». Главы департаментов сами посчитать
-- не могут (цены и зарплаты кухни закрыты), поэтому сервер (функция prasad-dept-recalc) раз в час
-- считает месяцы, у которых изменились исходные данные, и пишет сюда. Кухня и финансисты — живой расчёт.
--
-- «Изменился ли месяц» — отпечаток (md5) всех исходных данных расчёта за месяц: меню, блюда, готовое,
-- снимки рецептов, цены, наборы посуды, накладные кухни, ведомость, детализация вкушающих
-- (за весь период накладных, задевающих месяц: ставка накладной делится на все её приёмы пищи),
-- департаменты мест и история служения. Отпечаток не изменился — месяц не пересчитывается.

-- ---------- итоги ----------
create table if not exists public.fin_prasad_dept_month (
  month date not null,                 -- 1-е число месяца
  dept_key text not null,              -- id департамента | 'none' (без департамента) | 'shrsk' | 'unmarked'
  department_id uuid references public.fin_departments(id) on delete set null,
  people int not null default 0,       -- сколько разных людей ело
  pm numeric not null default 0,       -- приёмов пищи
  cost numeric not null default 0,     -- ₹
  data jsonb not null,                 -- строка KitchenCost.deptSummary: people[], by_day{}
  primary key (month, dept_key)
);
alter table public.fin_prasad_dept_month enable row level security;   -- читать только через fin_dept_prasad

create table if not exists public.fin_prasad_dept_runs (
  month date primary key,
  fingerprint text,
  computed_at timestamptz,
  cost_total numeric,                  -- себестоимость кухни за месяц (проверка)
  detail_total numeric,                -- сумма по всем строкам детализации — должна совпасть
  code_matches_site boolean,           -- расчёт на сервере = js/kitchen-cost.js на сайте
  error text
);
alter table public.fin_prasad_dept_runs enable row level security;

-- ---------- сервер читает цены и зарплаты кухни ----------
-- service_role и так обходит RLS; функции кухни проверяют право явно — пускаем и его
create or replace function public.fin_kitchen_can_view()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select fin_kitchen_can_manage() or fin_can_read_all()
      or kitchen_has_permission(auth.uid(), 'view_prices')
      or kitchen_has_permission(auth.uid(), 'edit_archived_prices')
      or coalesce(auth.role(), '') = 'service_role'
$function$;

-- ---------- секрет вызова (как fin_cleanup_secret) ----------
select vault.create_secret(encode(gen_random_bytes(24), 'hex'), 'prasad_dept_secret')
 where not exists (select 1 from vault.secrets where name = 'prasad_dept_secret');

create or replace function public.fin_private_prasad_dept_secret()
 returns text language sql stable security definer set search_path to 'public' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'prasad_dept_secret'
$$;
revoke all on function public.fin_private_prasad_dept_secret() from public, anon, authenticated;
grant execute on function public.fin_private_prasad_dept_secret() to service_role;

-- ---------- отпечаток исходных данных месяца ----------
create or replace function public.fin_private_prasad_dept_fingerprint(p_month date)
 returns text language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_cf date; v_ct date; v_loc uuid;
  h text := '';
begin
  select id into v_loc from locations where slug = 'main';
  -- окно вкушающих, как в KitchenCost.load: месяц + периоды накладных
  select least(v_from, min(x.eff_from)), greatest(v_to, max(x.eff_to)) into v_cf, v_ct
    from fin_kitchen_overhead_items(v_from, v_to) x;
  v_cf := coalesce(v_cf, v_from); v_ct := coalesce(v_ct, v_to);

  h := h || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from fin_kitchen_overhead_items(v_from, v_to) x), '-');
  h := h || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from fin_kitchen_payroll(v_from, v_to) x), '-');
  h := h || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from eating_detail_cost(v_cf, v_ct) x), '-');
  -- меню: приёмы пищи, блюда, готовое, снимки рецептов прошедших дней
  h := h || coalesce((select md5(string_agg(concat_ws(',', m.id, m.date, m.meal_type, m.portions, m.is_fast), '|' order by m.id))
                        from menu_meals m where m.location_id = v_loc and m.date between v_from and v_to), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', d.id, d.recipe_id, d.portion_size), '|' order by d.id))
                        from menu_dishes d join menu_meals m on m.id = d.meal_id
                       where m.location_id = v_loc and m.date between v_from and v_to), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', x.id, x.amount, x.kind, x.per_person, x.name, x.comment), '|' order by x.id))
                        from menu_external_items x join menu_meals m on m.id = x.meal_id
                       where m.location_id = v_loc and m.date between v_from and v_to), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', s.menu_dish_id, s.output_amount, s.output_unit, s.portion_amount, s.ingredients), '|' order by s.menu_dish_id))
                        from kitchen_v_dish_snapshots s where s.location_id = v_loc and s.date between v_from and v_to), '-');
  -- живые рецепты блюд месяца (дни без снимка) и проверка «так и должно быть»
  h := h || coalesce((select md5(string_agg(concat_ws(',', r.id, r.output_amount, r.output_unit, r.portion_amount), '|' order by r.id))
                        from recipes r where r.id in (select d.recipe_id from menu_dishes d join menu_meals m on m.id = d.meal_id
                                                       where m.location_id = v_loc and m.date between v_from and v_to)), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', i.recipe_id, i.product_id, i.amount, i.unit), '|' order by i.recipe_id, i.product_id, i.amount))
                        from recipe_ingredients i where i.recipe_id in (select d.recipe_id from menu_dishes d join menu_meals m on m.id = d.meal_id
                                                       where m.location_id = v_loc and m.date between v_from and v_to)), '-');
  -- справочники: цены, посуда, продукты, плотности, единицы
  h := h || coalesce((select md5(string_agg(concat_ws(',', p.product_id, p.price, p.valid_from, p.valid_to), '|' order by p.product_id, p.valid_from))
                        from kitchen_prices p where p.location_id = v_loc and p.valid_from <= v_to), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', k.meal_type, k.product_id, k.quantity), '|' order by k.meal_type, k.product_id))
                        from kitchen_portion_kits k where k.location_id = v_loc), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', p.id, p.unit, p.waste_percent), '|' order by p.id)) from products p), '-');
  h := h || coalesce((select md5(string_agg(x::text, '|' order by x::text)) from product_densities x), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', u.code, u.type, u.to_base_ratio), '|' order by u.code)) from units u), '-');
  -- куда относится: департамент места и история служения
  h := h || coalesce((select md5(string_agg(concat_ws(',', r.id, r.department_id), '|' order by r.id))
                        from residents r where r.department_id is not null and r.check_in <= v_to and coalesce(r.check_out, v_to) >= v_from), '-');
  h := h || coalesce((select md5(string_agg(concat_ws(',', v.vaishnava_id, v.department_id, v.date_from, v.date_to), '|' order by v.vaishnava_id, v.date_from))
                        from vaishnava_departments v where coalesce(v.date_from, v_from) <= v_to and coalesce(v.date_to, v_to) >= v_from), '-');
  -- имена в списке людей
  h := h || coalesce((select md5(string_agg(concat_ws(',', v.id, v.spiritual_name, v.first_name, v.last_name), '|' order by v.id))
                        from vaishnavas v where v.department_id is not null or v.status in ('team', 'volunteer')), '-');
  -- текущий месяц: «предварительно» зависит от сегодняшней даты
  if v_to >= current_date then h := h || current_date::text; end if;
  return md5(h);
end $$;
revoke all on function public.fin_private_prasad_dept_fingerprint(date) from public, anon, authenticated;
grant execute on function public.fin_private_prasad_dept_fingerprint(date) to service_role;

-- ---------- запись итогов месяца (только сервер) ----------
-- p_rows: [{ key, people[], by_day{}, pm, cost, ... }] — строки KitchenCost.deptSummary
create or replace function public.fin_private_save_prasad_dept(p_month date, p_fingerprint text, p_rows jsonb, p_meta jsonb)
 returns void language plpgsql security definer set search_path to 'public' as $$
declare v_month date := date_trunc('month', p_month)::date;
begin
  delete from fin_prasad_dept_month where month = v_month;
  insert into fin_prasad_dept_month (month, dept_key, department_id, people, pm, cost, data)
  select v_month, r->>'key',
         case when r->>'key' ~ '^[0-9a-f-]{36}$' then (r->>'key')::uuid end,
         jsonb_array_length(coalesce(r->'people', '[]'::jsonb)),
         coalesce((r->>'pm')::numeric, 0), coalesce((r->>'cost')::numeric, 0), r
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  insert into fin_prasad_dept_runs (month, fingerprint, computed_at, cost_total, detail_total, code_matches_site, error)
  values (v_month, p_fingerprint, now(), (p_meta->>'cost_total')::numeric, (p_meta->>'detail_total')::numeric,
          (p_meta->>'code_matches_site')::boolean, p_meta->>'error')
  on conflict (month) do update set fingerprint = excluded.fingerprint, computed_at = excluded.computed_at,
    cost_total = excluded.cost_total, detail_total = excluded.detail_total,
    code_matches_site = excluded.code_matches_site, error = excluded.error;
end $$;
revoke all on function public.fin_private_save_prasad_dept(date, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.fin_private_save_prasad_dept(date, text, jsonb, jsonb) to service_role;

-- ошибка расчёта месяца — запомнить, прежние итоги не трогать
create or replace function public.fin_private_prasad_dept_error(p_month date, p_error text)
 returns void language sql security definer set search_path to 'public' as $$
  insert into fin_prasad_dept_runs (month, error, computed_at) values (date_trunc('month', p_month)::date, p_error, now())
  on conflict (month) do update set error = excluded.error, fingerprint = null
$$;
revoke all on function public.fin_private_prasad_dept_error(date, text) from public, anon, authenticated;
grant execute on function public.fin_private_prasad_dept_error(date, text) to service_role;

create or replace function public.fin_private_prasad_dept_runs()
 returns setof fin_prasad_dept_runs language sql stable security definer set search_path to 'public' as $$
  select * from fin_prasad_dept_runs
$$;
revoke all on function public.fin_private_prasad_dept_runs() from public, anon, authenticated;
grant execute on function public.fin_private_prasad_dept_runs() to service_role;

-- ---------- чтение: страница департамента ----------
-- Свой департамент — тем, кто его видит (те же права, что «Счёт» и «Аналитика»);
-- все строки (p_department null) — Кухне и финансистам.
create or replace function public.fin_dept_prasad(p_department text, p_from date, p_to date)
 returns table(month date, dept_key text, department_id uuid, people int, pm numeric, cost numeric, data jsonb, computed_at timestamptz)
 language plpgsql stable security definer set search_path to 'public' as $$
declare v_dept uuid; v_all boolean := fin_can_read_all() or fin_kitchen_can_view();
begin
  if p_department is not null then
    select d.id into v_dept from fin_departments d
     where d.code = p_department or d.name = p_department or d.id::text = p_department limit 1;
    if v_dept is null then return; end if;
    if not v_all and v_dept not in (select fin_user_department_ids()) then
      raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
  elsif not v_all then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;
  return query
  select m.month, m.dept_key, m.department_id, m.people, m.pm, m.cost, m.data, r.computed_at
    from fin_prasad_dept_month m
    left join fin_prasad_dept_runs r on r.month = m.month
   where m.month between date_trunc('month', p_from)::date and p_to
     and (v_dept is null or m.department_id = v_dept)
   order by m.month, m.cost desc;
end $$;
revoke all on function public.fin_dept_prasad(text, date, date) from public, anon;
grant execute on function public.fin_dept_prasad(text, date, date) to authenticated;

-- ---------- раз в час ----------
select cron.unschedule('prasad-dept-recalc') where exists (select 1 from cron.job where jobname = 'prasad-dept-recalc');
select cron.schedule('prasad-dept-recalc', '7 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://mymrijdfqeevoaocbzfy.supabase.co/functions/v1/prasad-dept-recalc',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-prasad-key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'prasad_dept_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 300000
  );
$cron$);
