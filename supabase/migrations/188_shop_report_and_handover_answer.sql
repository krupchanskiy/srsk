-- Отчёт считал валовую прибыль по разным базам: выручку брал только по чужому товару,
-- а себестоимость — по всему, включая свой выпуск. Чем больше продавалось мурти, тем
-- сильнее отчёт занижал прибыль, вплоть до минуса; при этом в списке товаров маржа по
-- каждой позиции считалась правильно — две цифры в одном отчёте противоречили друг другу.
--
-- Там же: «возвращено» считалось по прайсу и включало возвраты по отменённым чекам,
-- а остаток не видел непогашенную недостачу и потому завышал обязательства перед
-- владельцами. Добавлены пожертвования по целям — «сколько собрали на деревья»
-- спросят в первый же месяц.
create or replace function shop_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v jsonb;
begin
    if not abk_current_user_has_permission('shop_analytics') then
        raise exception 'Нет доступа к аналитике магазина' using errcode = '42501';
    end if;

    with продажи as (
        select s.id, s.items_total, s.donation_amount, s.donation_goal_id,
               s.discount_amount, s.currency_code, s.rate_used, s.sold_at
        from shop_sales s
        where s.status = 'posted' and s.sold_at::date between p_from and p_to
    ),
    позиции as (
        select si.item_id, i.name_ru, i.name_en, i.name_hi, i.source,
               si.qty, si.price, coalesce(si.cost_price, 0) as cost_price
        from shop_sale_items si
        join продажи p on p.id = si.sale_id
        join shop_items i on i.id = si.item_id
    ),
    возвраты as (
        -- по тому, что реально отдали из кассы, и только по живым чекам
        select coalesce(sum(r.refund_amount * coalesce(s.rate_used, 1)), 0) as сумма
        from shop_returns r
        join shop_sales s on s.id = r.sale_id and s.status = 'posted'
        where r.returned_on between p_from and p_to
    ),
    цели as (
        select jsonb_agg(x) as список from (
            select coalesce(g.name_ru, 'Без цели') as name_ru, g.name_en, g.name_hi,
                   sum(p.donation_amount * p.rate_used) as amount
            from продажи p
            left join shop_goals g on g.id = p.donation_goal_id
            where p.donation_amount > 0
            group by g.name_ru, g.name_en, g.name_hi
            order by sum(p.donation_amount * p.rate_used) desc
        ) x
    ),
    итоги as (
        select
            (select count(*) from продажи)                                           as чеков,
            (select coalesce(sum(items_total), 0) from продажи)                      as выручка_товары,
            (select coalesce(sum(donation_amount * rate_used), 0) from продажи)      as пожертвования,
            (select coalesce(sum(discount_amount), 0) from продажи)                  as скидки,
            (select coalesce(sum(qty * price), 0) from позиции where source <> 'own') as перепродажа,
            (select coalesce(sum(qty * price), 0) from позиции where source = 'own')  as свой_выпуск,
            -- себестоимость только чужого товара: у своего выпуска её нет по определению
            (select coalesce(sum(qty * cost_price), 0) from позиции where source <> 'own') as себестоимость,
            (select сумма from возвраты)                                              as возвращено
    ),
    топ as (
        select jsonb_agg(x) as список from (
            select name_ru, name_en, name_hi, source,
                   sum(qty) as qty, sum(qty * price) as amount,
                   sum(qty * price) - sum(qty * cost_price) as margin
            from позиции
            group by name_ru, name_en, name_hi, source
            order by sum(qty * price) desc
            limit 10
        ) x
    ),
    остаток as (
        select
            coalesce(sum(b.qty_left) filter (where b.owner_id is null), 0)     as своё_штук,
            coalesce(sum(b.qty_left) filter (where b.owner_id is not null), 0) as чужое_штук,
            coalesce(sum(b.qty_left * coalesce(b.cost_price, 0))
                     filter (where b.owner_id is not null), 0)                 as чужое_сумма,
            coalesce(sum(b.qty_left) filter (where b.qty_left < 0), 0)         as недостача
        from shop_batches b
        where b.qty_left <> 0      -- минус тоже учитываем: иначе обязательства завышены
    ),
    лежалое as (
        select jsonb_agg(x) as список from (
            select i.name_ru, i.name_en, i.name_hi,
                   sum(b.qty_left) as qty,
                   min(b.received_on) as since,
                   (p_to - min(b.received_on)) as days
            from shop_batches b
            join shop_items i on i.id = b.item_id
            where b.qty_left > 0
              and not exists (
                  select 1 from shop_sale_items si
                  join shop_sales s on s.id = si.sale_id and s.status = 'posted'
                  where si.item_id = b.item_id and s.sold_at::date > p_to - 90)
            group by i.name_ru, i.name_en, i.name_hi
            having min(b.received_on) < p_to - 90
            order by min(b.received_on)
            limit 10
        ) x
    )
    select jsonb_build_object(
        'период', jsonb_build_object('с', p_from, 'по', p_to),
        'чеков', и.чеков,
        'средний_чек', case when и.чеков > 0 then round(и.выручка_товары / и.чеков, 2) else 0 end,
        'выручка_товары', и.выручка_товары,
        'пожертвования', round(и.пожертвования, 2),
        'скидки', и.скидки,
        'перепродажа', и.перепродажа,
        'свой_выпуск', и.свой_выпуск,
        'себестоимость', и.себестоимость,
        'валовая_прибыль', и.перепродажа - и.себестоимость,
        'возвращено', round(и.возвращено, 2),
        'топ', coalesce(т.список, '[]'::jsonb),
        'цели', coalesce(ц.список, '[]'::jsonb),
        'остаток', jsonb_build_object(
            'своё_штук', о.своё_штук,
            'чужое_штук', о.чужое_штук,
            'чужое_обязательства', о.чужое_сумма,
            'недостача', о.недостача),
        'лежалое', coalesce(л.список, '[]'::jsonb)
    ) into v
    from итоги и, топ т, остаток о, лежалое л, цели ц;

    return v;
end $$;

-- Ответ приёма складывал рупии с долларами в одно число — казначей видел бессмыслицу.
create or replace function shop_accept_handover(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_id        uuid := (payload->>'handover_id')::uuid;
    v_on        date := coalesce((payload->>'occurred_on')::date, current_date);
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
    v_итоги     jsonb := '[]'::jsonb;
begin
    if not fin_is_admin() then
        raise exception 'Принять выручку может только администратор финансов' using errcode = '42501';
    end if;

    perform pg_advisory_xact_lock(hashtext('shop_accept_handover'));

    if not exists (select 1 from shop_handovers where id = v_id and status = 'pending' for update) then
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
                'comment', format('Выручка магазина, сдана %s', to_char(v_on, 'DD.MM.YYYY')),
                'rows', v_rows));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил выручку: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
            update shop_handover_lines set operation_id = (v_res#>>'{result,operation_id}')::uuid
             where id = v_line.id;
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

        -- итоги отдаём по валютам: складывать рупии с долларами бессмысленно
        v_итоги := v_итоги || jsonb_build_object(
            'валюта', v_line.currency_code,
            'выручка', round(v_line.goods_amount + v_line.murti_amount + v_line.donation_amount, 2),
            'расхождение', v_line.discrepancy);
    end loop;

    update shop_handovers
       set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
     where id = v_id;

    return jsonb_build_object('ok', true, 'handover_id', v_id, 'итоги', v_итоги);
end $$;
