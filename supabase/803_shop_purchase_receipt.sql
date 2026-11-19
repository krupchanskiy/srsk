-- 803: приём товара «Закупка ШРСК» (жалоба продавщицы 18.11, решения ВГ 19.11).
-- Товар куплен на деньги ШРСК (с доработкой или без): владельца нет, долга при
-- продаже нет, выручка — в магазин (shop_cash), а не в мурти (там только source = 'own').
-- В строке: цена закупки по прайсу поставщика, скидка поставщика в %, себестоимость
-- = прайс × (1 − скидка); цена продажи (у товара из справочника — правится здесь же).

alter table shop_items drop constraint shop_items_source_check;
alter table shop_items add constraint shop_items_source_check
    check (source = any (array['consignment', 'own', 'purchase']));

-- владелец обязателен только у реализации
alter table shop_receipts drop constraint shop_receipts_check;
alter table shop_receipts add constraint shop_receipts_check
    check ((kind = 'consignment' and owner_id is not null)
        or (kind in ('own', 'purchase') and owner_id is null));

alter table shop_receipt_items
    add column if not exists list_price   numeric check (list_price >= 0),
    add column if not exists discount_pct numeric check (discount_pct >= 0 and discount_pct < 100);

comment on column shop_receipt_items.list_price   is 'Закупка ШРСК: цена поставщика за штуку до скидки';
comment on column shop_receipt_items.discount_pct is 'Закупка ШРСК: скидка поставщика, %; cost_price = list_price × (1 − %/100)';

create or replace function public.shop_receive_goods(payload jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
    v_receipt uuid;
    v_kind    text := coalesce(payload->>'kind', 'consignment');
    v_owner   uuid := nullif(payload->>'owner_id', '')::uuid;
    v_date    date := coalesce((payload->>'received_on')::date, current_date);
    v_стр     jsonb;
    v_item    uuid;
    v_qty     numeric;
    v_cost    numeric;
    v_прайс   numeric;
    v_скидка  numeric;
    v_цена    numeric;
    v_погашено numeric;
begin
    if not abk_current_user_has_permission('shop_receive') then
        raise exception 'Нет права на приём товара' using errcode = '42501';
    end if;

    if v_kind not in ('consignment', 'own', 'purchase') then
        raise exception 'Неизвестный вид поступления: %', v_kind;
    end if;
    if v_kind in ('own', 'purchase') then
        v_owner := null;
    elsif v_owner is null then
        raise exception 'Не указан владелец товара';
    end if;

    insert into shop_receipts (kind, owner_id, received_on, note, created_by)
    values (v_kind, v_owner, v_date, payload->>'note', auth.uid())
    returning id into v_receipt;

    for v_стр in select * from jsonb_array_elements(coalesce(payload->'items', '[]'::jsonb))
    loop
        v_item   := (v_стр->>'item_id')::uuid;
        v_qty    := (v_стр->>'qty')::numeric;
        v_cost   := nullif(v_стр->>'cost_price', '')::numeric;
        v_прайс  := null;
        v_скидка := null;
        v_цена   := nullif(v_стр->>'price', '')::numeric;

        if v_qty is null or v_qty <= 0 then
            raise exception 'Некорректное количество в строке приёмки';
        end if;

        if v_kind = 'purchase' then
            v_прайс  := nullif(v_стр->>'list_price', '')::numeric;
            v_скидка := coalesce(nullif(v_стр->>'discount_pct', '')::numeric, 0);
            if v_прайс is null or v_прайс <= 0 then
                raise exception 'Не указана цена закупки';
            end if;
            if v_скидка < 0 or v_скидка >= 100 then
                raise exception 'Скидка поставщика — от 0 до 99%%';
            end if;
            v_cost := round(v_прайс * (1 - v_скидка / 100), 2);
        elsif v_kind = 'consignment' then
            if v_cost is null or v_cost < 0 then
                raise exception 'Не указана цена расчёта с владельцем';
            end if;
        else
            v_cost := null;
        end if;

        -- новая цена продажи (доработка, переоценка) — сразу в карточку товара
        if v_цена is not null then
            if v_цена <= 0 then raise exception 'Цена продажи должна быть больше нуля'; end if;
            update shop_items set price = v_цена where id = v_item and price is distinct from v_цена;
        end if;

        insert into shop_receipt_items (receipt_id, item_id, qty, cost_price, list_price, discount_pct)
        values (v_receipt, v_item, v_qty, v_cost, v_прайс, nullif(v_скидка, 0));

        -- гасим недостачу только когда есть кому начислить долг
        v_погашено := case when v_owner is not null
                           then shop_settle_shortfall(v_item, v_owner, v_cost, v_qty)
                           else 0 end;

        if v_qty - v_погашено > 0 then
            insert into shop_batches (item_id, receipt_id, owner_id, qty_received, qty_left,
                                      cost_price, received_on, origin)
            values (v_item, v_receipt, v_owner, v_qty - v_погашено, v_qty - v_погашено,
                    v_cost, v_date, 'receipt');
        end if;
    end loop;

    if not exists (select 1 from shop_receipt_items where receipt_id = v_receipt) then
        raise exception 'Пустая приёмка';
    end if;

    return v_receipt;
end $function$;

insert into translations (key, ru, en, hi, page) values
    ('shop_purchase_kind', 'Закупка ШРСК', 'SRSK purchase', 'SRSK खरीद', 'shop'),
    ('shop_purchase_src', 'Куплено на деньги ШРСК', 'Bought with SRSK money', 'SRSK के पैसे से खरीदा', 'shop'),
    ('shop_sale_price_col', 'Цена продажи, ₹', 'Selling price, ₹', 'विक्रय मूल्य, ₹', 'shop'),
    ('shop_list_price_col', 'Цена закупки, ₹', 'Purchase price, ₹', 'खरीद मूल्य, ₹', 'shop'),
    ('shop_discount_pct_col', 'Скидка поставщика, %', 'Supplier discount, %', 'आपूर्तिकर्ता छूट, %', 'shop'),
    ('shop_net_cost_col', 'Себестоимость, ₹', 'Unit cost, ₹', 'प्रति नग लागत, ₹', 'shop'),
    ('shop_purchase_needs', 'Для «%s» укажите цену закупки', 'For «%s» enter the purchase price', '«%s» के लिए खरीद मूल्य बताएँ', 'shop'),
    ('shop_purchase_total_hint', '%s шт · себестоимость %s', '%s pcs · cost %s', '%s नग · लागत %s', 'shop'),
    ('shop_purchase_received', 'Закупка принята', 'Purchase received', 'खरीद दर्ज हुई', 'shop'),
    ('shop_purchase_hint', 'Товар куплен на деньги ШРСК (в том числе доработанный): владельца нет, выручка идёт в магазин. Если после доработки цена другая — поправьте её в строке.',
        'Goods bought with SRSK money (including reworked ones): no owner, revenue goes to the shop. If the price changed after rework, correct it in the row.',
        'SRSK के पैसे से खरीदा सामान (सुधारा हुआ भी): कोई मालिक नहीं, आय दुकान को जाती है। सुधार के बाद मूल्य बदला हो तो पंक्ति में ठीक करें।', 'shop')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;

update translations set
    ru = 'Владелец — тот, кому магазин заплатит за каждую проданную штуку. Указывайте только настоящего хозяина, который сдал товар на реализацию. Товар, купленный на деньги ШРСК или на выданные на закупку, — не чужой: не ставьте владельцем себя или того, кто покупал, иначе магазин заплатит за него второй раз. Такой товар принимайте через «Закупка ШРСК».',
    en = 'The owner is the person the shop pays for every item sold. Choose only the real owner who gave the goods for sale. Goods bought with SRSK money or with money given for purchasing are not someone else''s: do not set yourself or the buyer as the owner, or the shop will pay for them twice. Receive such goods via «SRSK purchase».',
    hi = 'मालिक वह है जिसे दुकान हर बिके सामान का पैसा देगी। केवल असली मालिक चुनें जिसने सामान बेचने के लिए दिया है। SRSK के पैसे से या खरीद के लिए दिए पैसे से खरीदा सामान पराया नहीं है: खुद को या खरीदने वाले को मालिक न बनाएं, वरना दुकान उसका दोबारा भुगतान करेगी। ऐसा सामान «SRSK खरीद» से दर्ज करें।'
where key = 'shop_owner_warning';
