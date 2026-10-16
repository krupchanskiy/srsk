-- Себестоимость своего выпуска.
--
-- У мурти нет себестоимости единицы: смолу и краску покупают впрок, роспись
-- оплачивают людям, и разложить это на конкретную фигуру нельзя. Но можно
-- посчитать иначе: взять всё, что потрачено на проекте «Мурти Госвами», и
-- поделить на всё, что с него выпущено. Получается средняя по мастерской.
--
-- Среднее берём накопительное, а не за период: смолы покупают на полгода,
-- и помесячное деление давало бы то заоблачную себестоимость, то нулевую.
-- Денежный взгляд при этом тоже показываем — «расход за период» отдельной
-- строкой, чтобы было видно, когда закупались.
--
-- Отсюда следствие для учёта: расходы мастерской должны попадать на объект
-- «Мурти Госвами». Роспись, проведённая зарплатной ведомостью, в объект не
-- попадает (в fin_payroll_accruals нет объекта) — её нужно проводить расходом.
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
    -- мастерская: что потрачено на проекте и сколько с него выпущено
    проект as (
        select
            coalesce(sum(p.amount_base) filter (where p.direction = 'out'), 0)      as расход_всего,
            coalesce(sum(p.amount_base) filter (where p.direction = 'out'
                     and op.occurred_on between p_from and p_to), 0)                as расход_период
        from fin_postings p
        join fin_operations op on op.id = p.operation_id and not op.is_reversed
        where p.object_id = (select id from fin_accounting_objects
                              where display_name = 'Мурти Госвами' limit 1)
    ),
    выпуск as (
        select
            coalesce(sum(b.qty_received), 0)                                        as всего,
            coalesce(sum(b.qty_received) filter (
                where b.received_on between p_from and p_to), 0)                    as период,
            coalesce(sum(b.qty_left), 0)                                            as на_полке
        from shop_batches b
        join shop_items i on i.id = b.item_id
        where i.source = 'own' and b.owner_id is null and b.origin = 'receipt'
    ),
    итоги as (
        select
            (select count(*) from продажи)                                           as чеков,
            (select coalesce(sum(items_total), 0) from продажи)                      as выручка_товары,
            (select coalesce(sum(donation_amount * rate_used), 0) from продажи)      as пожертвования,
            (select coalesce(sum(discount_amount), 0) from продажи)                  as скидки,
            (select coalesce(sum(qty * price), 0) from позиции where source <> 'own') as перепродажа,
            (select coalesce(sum(qty * price), 0) from позиции where source = 'own')  as свой_выпуск,
            (select coalesce(sum(qty), 0) from позиции where source = 'own')          as своих_штук,
            -- себестоимость чужого товара — та, по которой рассчитываемся с владельцем
            (select coalesce(sum(qty * cost_price), 0) from позиции where source <> 'own') as себестоимость,
            (select сумма from возвраты)                                              as возвращено
    ),
    мурти as (
        select
            пр.расход_всего, пр.расход_период, в.всего as выпущено_всего,
            в.период as выпущено_период, в.на_полке,
            -- средняя по мастерской: всё потраченное на всё выпущенное
            case when в.всего > 0 then round(пр.расход_всего / в.всего, 2) else 0 end as за_штуку
        from проект пр, выпуск в
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
        -- прибыль магазина целиком: перепродажа по себестоимости владельцев,
        -- свой выпуск по средней мастерской
        'себестоимость_своего', round(и.своих_штук * м.за_штуку, 2),
        'валовая_прибыль', round(и.перепродажа - и.себестоимость
                                 + и.свой_выпуск - и.своих_штук * м.за_штуку, 2),
        'возвращено', round(и.возвращено, 2),
        'мурти', jsonb_build_object(
            'продано_штук', и.своих_штук,
            'выручка', и.свой_выпуск,
            'за_штуку', м.за_штуку,
            'себестоимость_проданного', round(и.своих_штук * м.за_штуку, 2),
            'прибыль', round(и.свой_выпуск - и.своих_штук * м.за_штуку, 2),
            'расход_период', round(м.расход_период, 2),
            'расход_всего', round(м.расход_всего, 2),
            'выпущено_период', м.выпущено_период,
            'выпущено_всего', м.выпущено_всего,
            'на_полке', м.на_полке,
            'касса_проекта', round(и.свой_выпуск - м.расход_период, 2)),
        'топ', coalesce(т.список, '[]'::jsonb),
        'цели', coalesce(ц.список, '[]'::jsonb),
        'остаток', jsonb_build_object(
            'своё_штук', о.своё_штук,
            'чужое_штук', о.чужое_штук,
            'чужое_обязательства', о.чужое_сумма,
            'недостача', о.недостача),
        'лежалое', coalesce(л.список, '[]'::jsonb)
    ) into v
    from итоги и, топ т, остаток о, лежалое л, цели ц, мурти м;

    return v;
end $$;
