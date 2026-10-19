-- Магазин: четыре ошибки, на которых расходились деньги (аудит 19.10.2026,
-- каждая воспроизведена в откате). Решение Адриана: «правь ошибки».

-- ── К1 + К2. Отмена чека ────────────────────────────────────────────────
-- К1: после возврата тот же чек можно было ещё и отменить — товар
--     возвращался на полку второй раз, ожидаемая касса считала возврат
--     по отменённому чеку, а пакет выручки — нет.
-- К2: отмена чека, ушедшего «в минус», после того как недостачу погасила
--     приёмка от владельца, возвращала товар в ничью партию недостачи:
--     следующая продажа шла без владельца, его долг терялся.
--     Возврат (shop_return_sale) этот случай уже обрабатывал — делаем так же.
-- Заодно: отмена требует права продавать; строка смены блокируется,
-- чтобы отмена не проскочила в смену, которую в эту секунду закрывают.
create or replace function public.shop_cancel_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_sale  shop_sales%rowtype;
    v_shift shop_shifts%rowtype;
    v_стр   record;
    v_партия shop_batches%rowtype;
    v_последний uuid;
begin
    if not (abk_current_user_has_permission('shop_sell') or abk_current_user_has_permission('shop_manage')) then
        raise exception 'Нет права отменять чеки' using errcode = '42501';
    end if;

    select * into v_sale from shop_sales where id = p_sale_id for update;
    if not found then raise exception 'Чек не найден'; end if;
    if v_sale.status = 'cancelled' then return; end if;

    select * into v_shift from shop_shifts where id = v_sale.shift_id for update;

    if v_shift.status <> 'open' then
        raise exception 'Смена уже закрыта и пересчитана — оформите возврат покупателю, а не отмену чека';
    end if;

    if exists (select 1 from shop_returns where sale_id = p_sale_id) then
        raise exception 'По чеку уже был возврат — отменить его нельзя. Оформите возврат остального';
    end if;

    if not abk_current_user_has_permission('shop_manage') then
        if v_sale.seller_id is distinct from auth.uid() then
            raise exception 'Чужой чек отменяет заведующий' using errcode = '42501';
        end if;
        select id into v_последний from shop_sales
         where shift_id = v_sale.shift_id and status = 'posted'
         order by sold_at desc limit 1;
        if v_последний is distinct from p_sale_id then
            raise exception 'Отменить можно только последний чек — дальше нужен заведующий'
                using errcode = '42501';
        end if;
    end if;

    for v_стр in select * from shop_sale_items where sale_id = p_sale_id loop
        if v_стр.batch_id is null then continue; end if;
        select * into v_партия from shop_batches where id = v_стр.batch_id;
        if v_партия.origin = 'shortfall' and v_стр.owner_id is not null then
            -- недостачу погасил владелец: книга снова его, а не ничья
            insert into shop_batches (item_id, owner_id, qty_received, qty_left, cost_price,
                                      received_on, origin)
            values (v_стр.item_id, v_стр.owner_id, v_стр.qty, v_стр.qty, v_стр.cost_price,
                    current_date, 'return');
        else
            update shop_batches set qty_left = qty_left + v_стр.qty where id = v_стр.batch_id;
        end if;
    end loop;

    update shop_sales
       set status = 'cancelled', cancel_reason = p_reason,
           cancelled_at = now(), cancelled_by = auth.uid()
     where id = p_sale_id;
end $function$;

-- Возврат: чек блокируется — два одновременных возврата (двойной щелчок,
-- две вкладки) оба проходили проверку «не больше проданного»
do $$
declare
    тело text := pg_get_functiondef('public.shop_return_sale(jsonb)'::regprocedure);
    было text := $q$select * into v_sale from shop_sales where id = (payload->>'sale_id')::uuid;$q$;
begin
    if position(было in тело) = 0 then raise exception 'shop_return_sale изменилась'; end if;
    execute replace(тело, было, replace(было, '::uuid;', '::uuid for update;'));
end $$;

-- Ожидаемая касса: возврат по отменённому чеку не вычитается (как и в пакете)
create or replace function public.shop_shift_expected(p_shift uuid)
returns table(currency_code text, expected numeric)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
    select c.code,
           coalesce(sum(s.paid_amount), 0)
         - coalesce((select sum(r.refund_amount)
                       from shop_returns r
                       join shop_sales rs on rs.id = r.sale_id and rs.status = 'posted'
                      where r.shift_id = p_shift and rs.currency_code = c.code), 0)
         + case when c.code = 'INR'
                then coalesce((select float_amount from shop_shifts where id = p_shift), 0)
                else 0 end
    from fin_currencies c
    left join shop_sales s
           on s.shift_id = p_shift and s.status = 'posted' and s.currency_code = c.code
    where c.is_active and shop_can_view()
    group by c.code
    having coalesce(sum(s.paid_amount), 0) <> 0
        or (c.code = 'INR' and coalesce((select float_amount from shop_shifts where id = p_shift), 0) <> 0)
        or exists (select 1 from shop_returns r
                     join shop_sales rs on rs.id = r.sale_id and rs.status = 'posted'
                    where r.shift_id = p_shift and rs.currency_code = c.code)
$function$;

-- ── К3. Возвраты в пакете выручки ───────────────────────────────────────
-- а) возврат своего товара (мурти) вычитался из товарной части магазина,
--    а доля мурти считалась по продажам без возвратов: деньги уходили
--    не тому объекту. Теперь возврат раскладывается по тому, чей товар вернули.
create or replace function public.shop_prepare_handover(p_note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_id uuid;
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

    insert into shop_handovers (created_by, note) values (auth.uid(), p_note) returning id into v_id;

    insert into shop_handover_lines (handover_id, currency_code, goods_amount, murti_amount,
                                     donation_amount, discrepancy)
    select v_id,
           coalesce(в.currency_code, р.currency_code, воз.currency_code) as валюта,
           -- товарная часть магазина: чужой товар за вычетом его возвратов
           round(coalesce(в.товарная, 0) - coalesce(в.мурти, 0)
                 - (coalesce(воз.возвращено, 0) - coalesce(воз.возвращено_своего, 0)), 2),
           -- своё (мурти): продажи своего за вычетом его же возвратов
           round(coalesce(в.мурти, 0) - coalesce(воз.возвращено_своего, 0), 2),
           round(coalesce(в.дары, 0), 2),
           coalesce(р.расхождение, 0)
    from (
        select s.currency_code,
               sum(s.paid_amount - s.donation_amount) as товарная,
               sum((s.paid_amount - s.donation_amount) * coalesce(д.доля_своего, 0)) as мурти,
               sum(s.donation_amount) as дары
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
        group by s.currency_code
    ) в
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
       or coalesce(р.расхождение, 0) <> 0
       or coalesce(воз.возвращено, 0) <> 0;

    if not exists (select 1 from shop_handover_lines where handover_id = v_id) then
        raise exception 'Сдавать нечего: в закрытых сменах не было выручки';
    end if;

    update shop_shifts set handover_id = v_id where status = 'closed' and handover_id is null;
    return v_id;
end $function$;

-- б) если возвратов в периоде больше, чем продаж, часть пакета уходит
--    в минус — а приём проводил только суммы больше нуля. Пакет становился
--    «принят», а деньги, выданные из кассы покупателям, нигде не отражались.
--    Теперь минус проводится расходом «Возврат покупателю магазина».
insert into public.fin_categories (code, name, direction, visible_to_departments, is_active)
select 'shop_refund', 'Возврат покупателю магазина', 'out', true, true
where not exists (select 1 from public.fin_categories where code = 'shop_refund');

do $$
declare
    тело text := pg_get_functiondef('public.shop_accept_handover(jsonb)'::regprocedure);
    якорь text := E'        if v_line.discrepancy < 0 then';
    вставка text := E'        -- возвратов больше, чем продаж: минус — это деньги, выданные из кассы\n'
        || E'        if v_line.goods_amount < 0 or v_line.murti_amount < 0 then\n'
        || E'            v_rows := ''[]''::jsonb;\n'
        || E'            if v_line.goods_amount < 0 then\n'
        || E'                v_rows := v_rows || jsonb_build_object(\n'
        || E'                    ''id'', fin_private_child_uuid(v_line.id, ''shop-refund-goods''),\n'
        || E'                    ''account_id'', v_account, ''amount'', round(abs(v_line.goods_amount), 2),\n'
        || E'                    ''category_id'', (select id from fin_categories where code = ''shop_refund''),\n'
        || E'                    ''object_id'', v_obj_shop, ''payment_channel'', ''cash'');\n'
        || E'            end if;\n'
        || E'            if v_line.murti_amount < 0 then\n'
        || E'                v_rows := v_rows || jsonb_build_object(\n'
        || E'                    ''id'', fin_private_child_uuid(v_line.id, ''shop-refund-murti''),\n'
        || E'                    ''account_id'', v_account, ''amount'', round(abs(v_line.murti_amount), 2),\n'
        || E'                    ''category_id'', (select id from fin_categories where code = ''shop_refund''),\n'
        || E'                    ''object_id'', v_obj_murti, ''payment_channel'', ''cash'');\n'
        || E'            end if;\n'
        || E'            v_res := fin_create_expense(jsonb_build_object(\n'
        || E'                ''request_id'', fin_private_child_uuid(v_line.id, ''shop-refund''),\n'
        || E'                ''occurred_on'', v_on,\n'
        || E'                ''comment'', format(''Возвраты покупателям магазина за %s'', to_char(v_on, ''DD.MM.YYYY'')),\n'
        || E'                ''rows'', v_rows));\n'
        || E'            if not coalesce((v_res->>''ok'')::boolean, false) then\n'
        || E'                raise exception ''Финмодуль отклонил возвраты: %'',\n'
        || E'                    coalesce(v_res#>>''{error,message}'', v_res::text);\n'
        || E'            end if;\n'
        || E'        end if;\n\n'
        || E'        if v_line.discrepancy < 0 then';
begin
    if position(якорь in тело) = 0 then raise exception 'shop_accept_handover изменилась'; end if;
    execute replace(тело, якорь, вставка);
end $$;

-- ── К4. Разменный фонд ──────────────────────────────────────────────────
-- Размен можно было менять в любой момент смены без следа: забрать из
-- ящика 500 и уменьшить размен на 500 — расхождения нет. Теперь каждое
-- изменение пишется в журнал, а уменьшать размен после первого чека
-- может только заведующий. Увеличивать можно всегда: «открыл кассу
-- с нулём, потом вписал размен» — обычный порядок, а не хитрость.
create table if not exists public.shop_float_log (
    id          uuid primary key default gen_random_uuid(),
    shift_id    uuid not null references public.shop_shifts(id),
    old_amount  numeric not null,
    new_amount  numeric not null,
    after_sales boolean not null,
    changed_by  uuid,
    changed_at  timestamptz not null default now()
);
create index if not exists shop_float_log_shift_idx on public.shop_float_log (shift_id);
alter table public.shop_float_log enable row level security;
drop policy if exists "shop view" on public.shop_float_log;
create policy "shop view" on public.shop_float_log for select to authenticated using ((select shop_can_view()));
revoke all on table public.shop_float_log from anon;
revoke insert, update, delete, truncate, references, trigger on table public.shop_float_log from authenticated;

create or replace function public.shop_set_float(p_shift uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_смена shop_shifts%rowtype;
    v_новое numeric := coalesce(p_amount, 0);
    v_после boolean;
begin
    if not abk_current_user_has_permission('shop_sell') then
        raise exception 'Нет права менять разменный фонд' using errcode = '42501';
    end if;
    if v_новое < 0 then
        raise exception 'Разменный фонд не может быть отрицательным';
    end if;

    select * into v_смена from shop_shifts where id = p_shift and status = 'open' for update;
    if not found then
        raise exception 'Смена закрыта — разменный фонд уже не изменить';
    end if;
    if v_смена.opened_by is distinct from auth.uid() and not abk_current_user_has_permission('shop_manage') then
        raise exception 'Это смена другого продавца' using errcode = '42501';
    end if;
    if v_новое = coalesce(v_смена.float_amount, 0) then return; end if;

    v_после := exists (select 1 from shop_sales where shift_id = p_shift);
    if v_после and v_новое < coalesce(v_смена.float_amount, 0)
       and not abk_current_user_has_permission('shop_manage') then
        raise exception 'Уменьшить размен после первого чека может только заведующий'
            using errcode = '42501';
    end if;

    insert into shop_float_log (shift_id, old_amount, new_amount, after_sales, changed_by)
    values (p_shift, coalesce(v_смена.float_amount, 0), v_новое, v_после, auth.uid());

    update shop_shifts set float_amount = v_новое where id = p_shift;
end $function$;
