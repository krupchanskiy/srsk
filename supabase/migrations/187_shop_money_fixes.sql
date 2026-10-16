-- Денежный прогон. Главное: сдачу выручки можно было заблокировать навсегда.

-- 3.1 КРИТИЧНО. В пакете валюта бралась со стороны продаж, а продажи и акты пересчёта
-- сшиты полным соединением. Если по валюте есть акт, но нет чеков (смена с разменом
-- без продаж, все чеки отменены, пересчитали валюту, которой не было) — вставка падала
-- на NOT NULL, смена навсегда оставалась закрытой и несданной, и каждая следующая
-- попытка сдать выручку падала вместе с ней. Расшить можно было только через базу.
--
-- 3.2. Возвраты не вычитались из пакета: в журнал уходила выручка, которой не было,
-- и такая же «недостача кассы» — статья, которая по смыслу обвиняет продавца.
create or replace function shop_prepare_handover(p_note text default null)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
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
           -- товарная часть за вычетом возвращённого покупателям
           round(coalesce(в.товарная, 0) - coalesce(воз.возвращено, 0), 2)
             - round(coalesce(в.мурти, 0), 2),
           round(coalesce(в.мурти, 0), 2),
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
        select s.currency_code, sum(r.refund_amount) as возвращено
        from shop_returns r
        join shop_sales s on s.id = r.sale_id and s.status = 'posted'
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
end $$;

-- 1.1 КРИТИЧНО. Расчёт с владельцем не был идемпотентным: ключ операции считался от
-- свежесозданной строки, поэтому двойной клик или повтор сети платил владельцу дважды,
-- и случайно спасала только проверка «больше долга» при полной оплате.
alter table shop_settlements add column if not exists client_uid text unique;

create or replace function shop_settle_owner(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_owner    uuid := (payload->>'owner_id')::uuid;
    v_amount   numeric := round((payload->>'amount')::numeric, 2);
    v_account  uuid := nullif(payload->>'account_id', '')::uuid;
    v_on       date := coalesce((payload->>'occurred_on')::date, current_date);
    v_uid      text := nullif(payload->>'client_uid', '');
    v_acc      fin_accounts%rowtype;
    v_долг     numeric;
    v_contr    uuid;
    v_имя      text;
    v_res      jsonb;
    v_id       uuid;
begin
    if not fin_is_admin() then
        raise exception 'Рассчитаться с владельцем может только администратор финансов'
            using errcode = '42501';
    end if;

    if v_uid is not null then
        select id into v_id from shop_settlements where client_uid = v_uid;
        if v_id is not null then
            return jsonb_build_object('ok', true, 'settlement_id', v_id, 'повтор', true,
                'осталось', round(coalesce((select debt from shop_v_owner_debt where owner_id = v_owner), 0), 2));
        end if;
    end if;

    select o.contractor_id, c.name, round(coalesce(d.debt, 0), 2)
      into v_contr, v_имя, v_долг
      from shop_owners o
      join fin_contractors c on c.id = o.contractor_id
      left join shop_v_owner_debt d on d.owner_id = o.id
     where o.id = v_owner;
    if not found then raise exception 'Владелец не найден'; end if;

    if v_amount is null or v_amount <= 0 then
        raise exception 'Сумма расчёта должна быть больше нуля';
    end if;
    if v_amount > v_долг then
        raise exception 'Больше долга: владельцу должны %, а платят %', v_долг, v_amount;
    end if;

    select * into v_acc from fin_accounts where id = v_account;
    if not found or not v_acc.is_active then raise exception 'Счёт не найден или закрыт'; end if;
    if v_acc.currency_code <> 'INR' then
        raise exception 'С владельцами рассчитываемся в рупиях, а «%» ведётся в %',
            v_acc.name, v_acc.currency_code;
    end if;

    insert into shop_settlements (owner_id, period_from, period_to, amount, note, client_uid, created_by)
    values (v_owner,
            (select min(s.sold_at::date) from shop_sale_items si
               join shop_sales s on s.id = si.sale_id and s.status = 'posted'
              where si.owner_id = v_owner),
            v_on, v_amount, nullif(payload->>'note',''), v_uid, auth.uid())
    returning id into v_id;

    v_res := fin_create_expense(jsonb_build_object(
        'request_id', fin_private_child_uuid(v_id, 'shop-settlement'),
        'occurred_on', v_on,
        'comment', format('Расчёт с владельцем товара: %s', v_имя),
        'rows', jsonb_build_array(jsonb_build_object(
            'id', fin_private_child_uuid(v_id, 'shop-settlement-row'),
            'account_id', v_account,
            'amount', v_amount,
            'category_id', (select id from fin_categories where code = 'shop_settlement'),
            'object_id', (select id from fin_accounting_objects where display_name = 'Магазин'),
            'contractor_id', v_contr,
            'payment_channel', case when v_acc.reconciliation_mode = 'cash_count'
                                    then 'cash' else 'bank_transfer' end))));

    if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception 'Финмодуль отклонил расчёт: %',
            coalesce(v_res#>>'{error,message}', v_res::text);
    end if;

    update shop_settlements set operation_id = (v_res#>>'{result,operation_id}')::uuid where id = v_id;

    return jsonb_build_object('ok', true, 'settlement_id', v_id,
                              'осталось', round(v_долг - v_amount, 2));
end $$;

-- 3.3. Отмена чека между закрытием смены и сдачей не пересчитывала акт пересчёта:
-- деньги оставались в ящике, но не числились нигде. После закрытия смены — только возврат.
create or replace function shop_cancel_sale(p_sale_id uuid, p_reason text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_sale  shop_sales%rowtype;
    v_shift shop_shifts%rowtype;
    v_стр   record;
    v_последний uuid;
begin
    select * into v_sale from shop_sales where id = p_sale_id for update;
    if not found then raise exception 'Чек не найден'; end if;
    if v_sale.status = 'cancelled' then return; end if;

    select * into v_shift from shop_shifts where id = v_sale.shift_id;

    if v_shift.status <> 'open' then
        raise exception 'Смена уже закрыта и пересчитана — оформите возврат покупателю, а не отмену чека';
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
        if v_стр.batch_id is not null then
            update shop_batches set qty_left = qty_left + v_стр.qty where id = v_стр.batch_id;
        end if;
    end loop;

    update shop_sales
       set status = 'cancelled', cancel_reason = p_reason,
           cancelled_at = now(), cancelled_by = auth.uid()
     where id = p_sale_id;
end $$;
