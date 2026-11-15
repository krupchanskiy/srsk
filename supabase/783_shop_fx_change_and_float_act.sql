-- 783: касса магазина — сдача рупиями за валюту и размен «выдал — принял» (ВГ 15.11.2026)
--
-- 1. Оплата валютой, сдача рупиями. Чек в рупиях; покупатель даёт, например, $100.
--    По общему курсу казначея считаем рупии, сдача = (получено×курс − к оплате),
--    округлённая ВНИЗ до 50 ₹. В ящике: +$100 и −сдача в ₹. Ничего не конвертируем:
--    доллары сдаются долларами, рупии — рупиями (shop_sales.change_inr).
-- 2. Размен выдаёт только казначей — переводом на подотчёт «Магазин (₹)» без держателя
--    (кнопка «Выдать на сдачу» или «Перевод» в ДДС). Кассир, открывающий смену, видит
--    «выдано на сдачу ₹X» и подтверждает «Принял» или «Не сходится» — акт приёма.
--    Вписать размен сам кассир больше не может.
-- 3. Каждый вечер сдаётся вся касса: выручка — приходом, размен — переводом обратно
--    с подотчёта магазина в кассу казначея (как у кафе, 709). Утром казначей выдаёт заново.

-- ── схема ────────────────────────────────────────────────────────────────
alter table public.shop_sales
    add column if not exists change_inr numeric not null default 0;
do $$ begin
    alter table public.shop_sales add constraint shop_sales_change_inr_check check (change_inr >= 0);
exception when duplicate_object then null; end $$;
comment on column public.shop_sales.change_inr is
    'Сдача рупиями при оплате валютой: paid_amount — сколько валюты дали, change_inr — сколько ₹ выдано из ящика';

alter table public.shop_handover_lines
    add column if not exists change_amount numeric not null default 0;
comment on column public.shop_handover_lines.change_amount is
    'Выдано сдачи рупиями за валютную оплату (уже вычтено из goods/murti этой строки)';

alter table public.shop_handovers
    add column if not exists float_amount numeric not null default 0,
    add column if not exists float_operation_id uuid;
comment on column public.shop_handovers.float_amount is
    'Размен смен пакета: возвращается с подотчёта магазина в кассу при приёме';

create table if not exists public.shop_float_receipts (
    id          uuid primary key default gen_random_uuid(),
    shift_id    uuid not null references public.shop_shifts(id),
    issued      numeric not null,
    counted     numeric not null,
    accepted    boolean not null,
    reason      text,
    created_by  uuid default auth.uid(),
    created_at  timestamptz not null default now()
);
comment on table public.shop_float_receipts is
    'Акт приёма размена кассиром: принял выданное казначеем или насчитал другое (783)';
create index if not exists shop_float_receipts_created_idx on public.shop_float_receipts (created_at desc);
alter table public.shop_float_receipts enable row level security;
drop policy if exists "shop view" on public.shop_float_receipts;
create policy "shop view" on public.shop_float_receipts for select to authenticated
    using ((select shop_can_view()) or (select fin_is_admin()));
revoke all on table public.shop_float_receipts from anon;
revoke insert, update, delete, truncate, references, trigger on table public.shop_float_receipts from authenticated;

-- казначей видит смены и пакеты магазина и без прав магазина: плашка в ДДС
drop policy if exists "fin admin view" on public.shop_shifts;
create policy "fin admin view" on public.shop_shifts for select to authenticated using ((select fin_is_admin()));
drop policy if exists "fin admin view" on public.shop_handovers;
create policy "fin admin view" on public.shop_handovers for select to authenticated using ((select fin_is_admin()));
drop policy if exists "fin admin view" on public.shop_handover_lines;
create policy "fin admin view" on public.shop_handover_lines for select to authenticated using ((select fin_is_admin()));

insert into public.fin_categories (code, name, direction, visible_to_departments, is_active)
select 'shop_fx_change', 'Сдача рупиями за валютную оплату', 'out', true, true
where not exists (select 1 from public.fin_categories where code = 'shop_fx_change');

-- ── размен: где лежит и сколько ждёт приёма ─────────────────────────────
create or replace function public.shop_float_account()
returns uuid
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
    select fin_private_float_account((select id from fin_departments where code = 'shop'), 'INR')
$$;
revoke all on function public.shop_float_account() from public, anon, authenticated;

-- выдано казначеем на подотчёт магазина и ещё не принято ни одной сменой
create or replace function public.shop_float_pending()
returns numeric
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_на_счёте numeric;
    v_в_сменах numeric;
begin
    if not (shop_can_view() or fin_is_admin()) then return null; end if;
    select coalesce(sum(case direction when 'in' then amount else -amount end), 0) into v_на_счёте
      from fin_postings where account_id = shop_float_account() and holder_person_id is null;
    -- размен смен, ещё не вернувшийся в кассу (смена не сдана или пакет не принят)
    select coalesce(sum(s.float_amount), 0) into v_в_сменах
      from shop_shifts s left join shop_handovers h on h.id = s.handover_id
     where s.handover_id is null or h.status = 'pending';
    return greatest(round(v_на_счёте - v_в_сменах, 2), 0);
end $$;
grant execute on function public.shop_float_pending() to authenticated;

-- акт приёма: «Принял» добавляет выданное в размен открытой смены (смену открывает сам),
-- «Не сходится» — запись с тем, что насчитал, и причиной; размен не меняется, казначей разбирается
create or replace function public.shop_receive_float(p_ok boolean, p_counted numeric default null, p_reason text default null)
returns numeric
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_смена shop_shifts%rowtype;
    v_выдано numeric;
    v_было numeric;
begin
    if not abk_current_user_has_permission('shop_sell') then
        raise exception 'Нет права принимать размен' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('shop_open_shift'));

    v_выдано := shop_float_pending();
    if coalesce(v_выдано, 0) <= 0 then
        raise exception 'Нового размена нет — казначей ещё ничего не выдал';
    end if;

    select * into v_смена from shop_shifts where status = 'open' order by opened_at desc limit 1 for update;
    if not found then
        insert into shop_shifts (opened_by, float_amount) values (auth.uid(), 0) returning * into v_смена;
    end if;

    if p_ok then
        v_было := coalesce(v_смена.float_amount, 0);
        update shop_shifts set float_amount = v_было + v_выдано where id = v_смена.id;
        insert into shop_float_log (shift_id, old_amount, new_amount, after_sales, changed_by)
        values (v_смена.id, v_было, v_было + v_выдано,
                exists (select 1 from shop_sales where shift_id = v_смена.id), auth.uid());
        insert into shop_float_receipts (shift_id, issued, counted, accepted)
        values (v_смена.id, v_выдано, v_выдано, true);
    else
        if p_counted is null or p_counted < 0 then
            raise exception 'Укажите, сколько насчитали';
        end if;
        if p_counted = v_выдано then
            raise exception 'Насчитали столько же, сколько выдано, — нажмите «Принял»';
        end if;
        if nullif(trim(coalesce(p_reason, '')), '') is null then
            raise exception 'Напишите, что не так, — казначей увидит это в ДДС';
        end if;
        insert into shop_float_receipts (shift_id, issued, counted, accepted, reason)
        values (v_смена.id, v_выдано, p_counted, false, trim(p_reason));
    end if;
    return v_выдано;
end $$;
grant execute on function public.shop_receive_float(boolean, numeric, text) to authenticated;

-- казначей выдаёт размен: перевод из кассы на подотчёт магазина без держателя
create or replace function public.shop_issue_float(p_amount numeric, p_account uuid)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_acc fin_accounts%rowtype;
    v_res jsonb;
begin
    if not fin_is_admin() then
        raise exception 'Выдать размен может только казначей' using errcode = '42501';
    end if;
    if coalesce(p_amount, 0) <= 0 then raise exception 'Сумма размена должна быть больше нуля'; end if;
    select * into v_acc from fin_accounts where id = p_account;
    if not found or not v_acc.is_active then raise exception 'Касса не найдена или закрыта'; end if;
    if v_acc.currency_code <> 'INR' or coalesce(v_acc.group_name, '') <> 'Касса' then
        raise exception 'Размен выдаётся из кассы в рупиях, а «%» — не она', v_acc.name;
    end if;
    if shop_float_account() is null then
        raise exception 'У Магазина нет подотчётного счёта в ₹';
    end if;
    v_res := fin_create_transfer(jsonb_build_object(
        'request_id', gen_random_uuid(),
        'occurred_on', current_date,
        'source_account_id', p_account, 'target_account_id', shop_float_account(),
        'source_amount', p_amount, 'target_amount', p_amount,
        'comment', 'Выдано на сдачу в магазин'));
    if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception '%', coalesce(v_res#>>'{error,message}', 'не удалось выдать размен');
    end if;
    return v_res;
end $$;
grant execute on function public.shop_issue_float(numeric, uuid) to authenticated;

-- смену открывают без размена: размен приходит только актом приёма
create or replace function public.shop_open_shift(p_float numeric default 0)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_id uuid;
begin
    if not abk_current_user_has_permission('shop_sell') then
        raise exception 'Нет права на продажу' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('shop_open_shift'));
    select id into v_id from shop_shifts where status = 'open' order by opened_at desc limit 1;
    if v_id is not null then return v_id; end if;
    insert into shop_shifts (opened_by, float_amount) values (auth.uid(), 0) returning id into v_id;
    return v_id;
end $$;

create or replace function public.shop_set_float(p_shift uuid, p_amount numeric)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
begin
    raise exception 'Размен выдаёт казначей, а кассир подтверждает «Принял» на странице смены';
end $$;

-- ── ожидаемое в ящике: сдача рупиями уходит из ₹ ─────────────────────────
create or replace function public.shop_shift_expected(p_shift uuid)
returns table(currency_code text, expected numeric)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
    with дв as (
        select s.currency_code as вал, s.paid_amount as сумма from shop_sales s
         where s.shift_id = p_shift and s.status = 'posted'
        union all
        select 'INR', -s.change_inr from shop_sales s
         where s.shift_id = p_shift and s.status = 'posted' and s.change_inr > 0
        union all
        select rs.currency_code, -r.refund_amount from shop_returns r
          join shop_sales rs on rs.id = r.sale_id and rs.status = 'posted'
         where r.shift_id = p_shift
        union all
        select 'INR', coalesce((select float_amount from shop_shifts where id = p_shift), 0)
    )
    select c.code, coalesce(sum(дв.сумма), 0)
    from fin_currencies c
    join дв on дв.вал = c.code
    where c.is_active and shop_can_view()
    group by c.code
    -- валюта нужна в пересчёте, если в ней было хоть какое-то движение, даже если в сумме ноль
    having bool_or(дв.сумма <> 0)
$function$;

-- ── продажа: «получено» в валюте → сдача рупиями ────────────────────────
do $$
declare
    тело text := pg_get_functiondef('public.shop_post_sale(jsonb)'::regprocedure);
    я1 text := E'    v_shortfall  uuid;\nbegin';
    в1 text := E'    v_shortfall  uuid;\n    v_получено   numeric := nullif(payload->>''tendered'', '''')::numeric;\n'
            || E'    v_нужно_р    numeric;\n    v_сдача_р    numeric := 0;\n    v_в_ящике    numeric;\nbegin';
    я2 text := E'    update shop_sales set items_total = v_итого, paid_amount = v_к_оплате + v_donation\n     where id = v_sale_id;';
    в2 text := E'    -- оплата валютой: всё полученное остаётся в ящике в валюте, сдача — рупиями\n'
            || E'    -- по общему курсу, округлённая вниз до 50 ₹ (ВГ 15.11)\n'
            || E'    if v_currency <> ''INR'' and v_получено is not null then\n'
            || E'        v_нужно_р := v_итого + v_donation * v_rate;\n'
            || E'        if v_получено * v_rate < v_нужно_р - 0.005 then\n'
            || E'            raise exception ''Не хватает: получено % % (₹%), а к оплате ₹%'',\n'
            || E'                v_получено, v_currency, round(v_получено * v_rate), round(v_нужно_р);\n'
            || E'        end if;\n'
            || E'        v_сдача_р := greatest(floor(round(v_получено * v_rate - v_нужно_р, 2) / 50) * 50, 0);\n'
            || E'        -- сдача выдаётся из рупий этой смены: больше, чем лежит в ящике, не выдать\n'
            || E'        select coalesce(sum(expected), 0) into v_в_ящике\n'
            || E'          from shop_shift_expected(v_shift_id) where currency_code = ''INR'';\n'
            || E'        if v_сдача_р > v_в_ящике then\n'
            || E'            raise exception ''Сдача ₹% рупиями, а в ящике смены только ₹%. Попросите размен у казначея'',\n'
            || E'                v_сдача_р, round(v_в_ящике);\n'
            || E'        end if;\n'
            || E'        update shop_sales set items_total = v_итого, paid_amount = v_получено, change_inr = v_сдача_р\n'
            || E'         where id = v_sale_id;\n'
            || E'        return v_sale_id;\n'
            || E'    end if;\n\n'
            || я2;
begin
    if position(я1 in тело) = 0 or position(я2 in тело) = 0 then
        raise exception 'shop_post_sale изменилась — правку надо переписать';
    end if;
    execute replace(replace(тело, я1, в1), я2, в2);
end $$;

-- возврат по валютному чеку: товарная часть без выданной рупиями сдачи
do $$
declare
    тело text := pg_get_functiondef('public.shop_return_sale(jsonb)'::regprocedure);
    я text := E'    v_товарная := v_sale.paid_amount - v_sale.donation_amount;';
    в text := E'    v_товарная := v_sale.paid_amount - v_sale.donation_amount\n'
           || E'                  - coalesce(v_sale.change_inr, 0) / nullif(v_sale.rate_used, 0);';
begin
    if position(я in тело) = 0 then raise exception 'shop_return_sale изменилась'; end if;
    execute replace(тело, я, в);
end $$;

-- ── пакет сдачи: сдача рупиями вычитается из ₹, размен смен идёт отдельно ──
create or replace function public.shop_prepare_handover(p_note text default null)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_id uuid;
    v_размен numeric;
begin
    if not abk_current_user_has_permission('shop_settle') then
        raise exception 'Нет права сдавать выручку' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtext('shop_prepare_handover'));

    if exists (select 1 from shop_handovers where status = 'pending') then
        raise exception 'Предыдущий пакет ещё не принят казначеем';
    end if;
    if not exists (select 1 from shop_shifts where status = 'closed' and handover_id is null) then
        raise exception 'Нечего сдавать: закрытых несданных смен нет';
    end if;

    select coalesce(sum(float_amount), 0) into v_размен
      from shop_shifts where status = 'closed' and handover_id is null;

    insert into shop_handovers (created_by, note, float_amount)
    values (auth.uid(), p_note, v_размен) returning id into v_id;

    insert into shop_handover_lines (handover_id, currency_code, goods_amount, murti_amount,
                                     donation_amount, discrepancy, change_amount)
    with продажи as (
        select s.*, coalesce(д.доля_своего, 0) as доля
        from shop_sales s
        join shop_shifts sh on sh.id = s.shift_id and sh.status = 'closed' and sh.handover_id is null
        left join lateral (
            select case when sum(si.qty * si.price) > 0
                        then sum(si.qty * si.price) filter (where i.source = 'own') / sum(si.qty * si.price)
                        else 0 end as доля_своего
            from shop_sale_items si join shop_items i on i.id = si.item_id
            where si.sale_id = s.id
        ) д on true
        where s.status = 'posted'
    ), в as (
        select x.вал as currency_code, sum(x.товарная) as товарная, sum(x.мурти) as мурти,
               sum(x.дары) as дары, sum(x.сдача) as сдача
        from (
            select currency_code as вал, paid_amount - donation_amount as товарная,
                   (paid_amount - donation_amount) * доля as мурти, donation_amount as дары, 0::numeric as сдача
              from продажи
            union all
            -- сдача рупиями за валюту: уменьшает рупии ящика в той же пропорции товар/мурти
            select 'INR', -change_inr, -change_inr * доля, 0, change_inr
              from продажи where change_inr > 0
        ) x
        group by x.вал
    )
    select v_id,
           coalesce(в.currency_code, р.currency_code, воз.currency_code) as валюта,
           -- товарная часть магазина: чужой товар за вычетом его возвратов
           round(coalesce(в.товарная, 0) - coalesce(в.мурти, 0)
                 - (coalesce(воз.возвращено, 0) - coalesce(воз.возвращено_своего, 0)), 2),
           -- своё (мурти): продажи своего за вычетом его же возвратов
           round(coalesce(в.мурти, 0) - coalesce(воз.возвращено_своего, 0), 2),
           round(coalesce(в.дары, 0), 2),
           coalesce(р.расхождение, 0),
           round(coalesce(в.сдача, 0), 2)
    from в
    full join (
        select c.currency_code, sum(c.actual - c.expected) as расхождение
        from shop_cash_counts c
        join shop_shifts sh on sh.id = c.shift_id and sh.status = 'closed' and sh.handover_id is null
        group by c.currency_code
    ) р on р.currency_code = в.currency_code
    full join (
        select s.currency_code,
               sum(r.refund_amount) as возвращено,
               sum(r.refund_amount) filter (where i.source = 'own') as возвращено_своего
        from shop_returns r
        join shop_sales s on s.id = r.sale_id and s.status = 'posted'
        join shop_sale_items si on si.id = r.sale_item_id
        join shop_items i on i.id = si.item_id
        join shop_shifts sh on sh.id = r.shift_id and sh.status = 'closed' and sh.handover_id is null
        group by s.currency_code
    ) воз on воз.currency_code = coalesce(в.currency_code, р.currency_code)
    where coalesce(в.товарная, 0) + coalesce(в.дары, 0) <> 0
       or coalesce(в.сдача, 0) <> 0
       or coalesce(р.расхождение, 0) <> 0
       or coalesce(воз.возвращено, 0) <> 0;

    if v_размен = 0 and not exists (select 1 from shop_handover_lines where handover_id = v_id) then
        raise exception 'Сдавать нечего: в закрытых сменах не было ни выручки, ни размена';
    end if;

    update shop_shifts set handover_id = v_id where status = 'closed' and handover_id is null;
    return v_id;
end $function$;

-- ── приём: выручка приходом, минус от сдачи — своей статьёй, размен — обратно в кассу ──
create or replace function public.shop_accept_handover(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_id        uuid := (payload->>'handover_id')::uuid;
    v_on        date := coalesce((payload->>'occurred_on')::date, current_date);
    v_пакет     shop_handovers%rowtype;
    v_line      record;
    v_account   uuid;
    v_acc       fin_accounts%rowtype;
    v_rows      jsonb;
    v_res       jsonb;
    v_obj_shop  uuid;
    v_obj_murti uuid;
    v_cat_goods uuid;
    v_cat_murti uuid;
    v_cat_gift  uuid;
    v_cat_short uuid;
    v_cat_surp  uuid;
    v_cat_minus uuid;
    v_src       uuid;
    v_есть      numeric;
    v_итоги     jsonb := '[]'::jsonb;
begin
    if not fin_is_admin() then
        raise exception 'Принять выручку может только администратор финансов' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtext('shop_accept_handover'));

    select * into v_пакет from shop_handovers where id = v_id and status = 'pending' for update;
    if not found then
        raise exception 'Пакет не найден или уже принят';
    end if;

    select id into v_obj_shop  from fin_accounting_objects where display_name = 'Магазин';
    select id into v_obj_murti from fin_accounting_objects where display_name = 'Мурти Госвами';
    select id into v_cat_goods from fin_categories where code = 'shop_cash';
    select id into v_cat_murti from fin_categories where code = 'murti';
    select id into v_cat_gift  from fin_categories where code = 'shop_donation';
    select id into v_cat_short from fin_categories where code = 'shop_cash_shortage';
    select id into v_cat_surp  from fin_categories where code = 'shop_cash_surplus';

    for v_line in select * from shop_handover_lines where handover_id = v_id loop
        v_account := (payload#>>array['accounts', v_line.currency_code])::uuid;
        if v_account is null then
            raise exception 'Не выбран счёт для валюты %', v_line.currency_code;
        end if;
        select * into v_acc from fin_accounts where id = v_account;
        if not found or not v_acc.is_active then raise exception 'Счёт не найден или закрыт'; end if;
        if v_acc.currency_code <> v_line.currency_code then
            raise exception 'Счёт «%» ведётся в %, а сдаются %',
                v_acc.name, v_acc.currency_code, v_line.currency_code;
        end if;
        if coalesce(v_acc.group_name, '') <> 'Касса' then
            raise exception 'Наличная выручка принимается только в кассу, а «%» — это %',
                v_acc.name, coalesce(v_acc.group_name, 'счёт вне групп');
        end if;

        v_rows := '[]'::jsonb;
        if v_line.goods_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-goods'),
                'account_id', v_account, 'amount', round(v_line.goods_amount, 2),
                'category_id', v_cat_goods, 'object_id', v_obj_shop, 'payment_channel', 'cash');
        end if;
        if v_line.murti_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-murti'),
                'account_id', v_account, 'amount', round(v_line.murti_amount, 2),
                'category_id', v_cat_murti, 'object_id', v_obj_murti, 'payment_channel', 'cash');
        end if;
        if v_line.donation_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-donation'),
                'account_id', v_account, 'amount', round(v_line.donation_amount, 2),
                'category_id', v_cat_gift, 'object_id', v_obj_shop, 'payment_channel', 'cash');
        end if;

        if jsonb_array_length(v_rows) > 0 then
            v_res := fin_create_income(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-handover'),
                'occurred_on', v_on,
                'comment', format('Выручка магазина, сдана %s', to_char(v_on, 'DD.MM.YYYY'))
                           || case when v_line.change_amount > 0
                                   then format(' · за вычетом сдачи рупиями за валюту ₹%s', round(v_line.change_amount))
                                   else '' end,
                'rows', v_rows));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил выручку: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
            update shop_handover_lines set operation_id = (v_res#>>'{result,operation_id}')::uuid
             where id = v_line.id;
        end if;

        -- минус в строке: деньги, выданные из ящика, — сдача рупиями за валюту или возвраты
        if v_line.goods_amount < 0 or v_line.murti_amount < 0 then
            v_cat_minus := (select id from fin_categories
                             where code = case when v_line.change_amount > 0 then 'shop_fx_change' else 'shop_refund' end);
            v_rows := '[]'::jsonb;
            if v_line.goods_amount < 0 then
                v_rows := v_rows || jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-refund-goods'),
                    'account_id', v_account, 'amount', round(abs(v_line.goods_amount), 2),
                    'category_id', v_cat_minus, 'object_id', v_obj_shop, 'payment_channel', 'cash');
            end if;
            if v_line.murti_amount < 0 then
                v_rows := v_rows || jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-refund-murti'),
                    'account_id', v_account, 'amount', round(abs(v_line.murti_amount), 2),
                    'category_id', v_cat_minus, 'object_id', v_obj_murti, 'payment_channel', 'cash');
            end if;
            v_res := fin_create_expense(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-refund'),
                'occurred_on', v_on,
                'comment', case when v_line.change_amount > 0
                                then format('Сдача рупиями за валютную оплату в магазине за %s', to_char(v_on, 'DD.MM.YYYY'))
                                else format('Возвраты покупателям магазина за %s', to_char(v_on, 'DD.MM.YYYY')) end,
                'rows', v_rows));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил минус по кассе: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        end if;

        if v_line.discrepancy < 0 then
            v_res := fin_create_expense(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-shortage'),
                'occurred_on', v_on,
                'comment', format('Недостача кассы магазина за %s', to_char(v_on, 'DD.MM.YYYY')),
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-shortage-row'),
                    'account_id', v_account, 'amount', round(abs(v_line.discrepancy), 2),
                    'category_id', v_cat_short, 'object_id', v_obj_shop, 'payment_channel', 'cash'))));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил недостачу: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        elsif v_line.discrepancy > 0 then
            v_res := fin_create_income(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-surplus'),
                'occurred_on', v_on,
                'comment', format('Излишек кассы магазина за %s', to_char(v_on, 'DD.MM.YYYY')),
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-surplus-row'),
                    'account_id', v_account, 'amount', round(v_line.discrepancy, 2),
                    'category_id', v_cat_surp, 'object_id', v_obj_shop, 'payment_channel', 'cash'))));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил излишек: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        end if;

        v_итоги := v_итоги || jsonb_build_object(
            'валюта', v_line.currency_code,
            'выручка', round(v_line.goods_amount + v_line.murti_amount + v_line.donation_amount, 2),
            'расхождение', v_line.discrepancy);
    end loop;

    -- размен сдан вместе с ящиком: возвращаем его с подотчёта магазина в кассу
    if v_пакет.float_amount > 0 then
        v_account := (payload#>>'{accounts,INR}')::uuid;
        select * into v_acc from fin_accounts where id = v_account;
        if not found or not v_acc.is_active or v_acc.currency_code <> 'INR'
           or coalesce(v_acc.group_name, '') <> 'Касса' then
            raise exception 'Выберите кассу в ₹, куда вернётся размен ₹%', round(v_пакет.float_amount);
        end if;
        v_src := shop_float_account();
        select coalesce(sum(case direction when 'in' then amount else -amount end), 0) into v_есть
          from fin_postings where account_id = v_src and holder_person_id is null;
        if round(v_есть, 2) < round(v_пакет.float_amount, 2) then
            raise exception 'В сменах размен ₹%, а казначей выдавал магазину ₹% — сначала разберите размен',
                round(v_пакет.float_amount), round(v_есть);
        end if;
        perform set_config('tg.suppress_chat_notify', '1', true);
        v_res := fin_create_transfer(jsonb_build_object(
            'request_id', fin_private_child_uuid(v_id, 'shop-float-return'),
            'occurred_on', v_on,
            'source_account_id', v_src, 'target_account_id', v_account,
            'source_amount', v_пакет.float_amount, 'target_amount', v_пакет.float_amount,
            'comment', 'Размен магазина вернулся вместе с выручкой'));
        perform set_config('tg.suppress_chat_notify', '', true);
        if not coalesce((v_res->>'ok')::boolean, false) then
            raise exception 'Финмодуль не вернул размен: %', coalesce(v_res#>>'{error,message}', v_res::text);
        end if;
        update shop_handovers set float_operation_id = (v_res#>>'{result,operation_id}')::uuid where id = v_id;
    end if;

    update shop_handovers
       set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
     where id = v_id;

    return jsonb_build_object('ok', true, 'handover_id', v_id, 'итоги', v_итоги,
                              'размен', v_пакет.float_amount);
end $function$;

-- ── переводы новых строк ─────────────────────────────────────────────────
insert into public.translations (key, ru, en, hi, page) values
    ('shop_change_inr',        'Сдача рупиями',                 'Change in rupees',              'रुपये में छुट्टे', 'shop'),
    ('shop_float_issued',      'Казначей выдал на сдачу',       'Treasurer issued float',        'कोषाध्यक्ष ने खुले पैसे दिए', 'shop'),
    ('shop_float_recount',     'Пересчитайте и подтвердите.',   'Count it and confirm.',         'गिनकर पुष्टि करें।', 'shop'),
    ('shop_float_got',         'Принял',                        'Received',                      'प्राप्त किया', 'shop'),
    ('shop_float_mismatch',    'Не сходится',                   'Does not match',                'मेल नहीं खाता', 'shop'),
    ('shop_float_counted',     'Сколько насчитали, ₹',          'Counted, ₹',                    'गिना, ₹', 'shop'),
    ('shop_float_what_wrong',  'Что не так',                    'What is wrong',                 'क्या गलत है', 'shop'),
    ('shop_float_send',        'Отправить казначею',            'Send to treasurer',             'कोषाध्यक्ष को भेजें', 'shop'),
    ('shop_float_none',        'Размен не выдан',               'No float issued',               'खुले पैसे नहीं दिए', 'shop'),
    ('shop_float_in_drawer',   'В ящике размена',               'Float in drawer',               'दराज़ में खुले पैसे', 'shop'),
    ('shop_float_rejected',    'Кассир не принял размен',       'Cashier did not accept float',  'कैशियर ने खुले पैसे नहीं लिए', 'shop'),
    ('shop_float_issue',       'Выдать на сдачу',               'Issue float',                   'खुले पैसे दें', 'shop'),
    ('shop_float_returns',     'Размен вернётся в кассу',       'Float returns to cash',         'खुले पैसे कैश में लौटेंगे', 'shop')
on conflict (key) do nothing;
