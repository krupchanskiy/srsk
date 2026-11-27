-- 804: картотека поставщиков и фото образца (ВГ 19.11).
-- Поставщик — у кого ШРСК закупает товар (магазин ему ничего не должен: закупка
-- уже оплачена). При «Закупке ШРСК» его можно выбрать — в карточке поставщика
-- видно, что и почём у него брали, с фото, чтобы другой закупщик показал, что нужно.
-- Фото у товара два: photo_url — готовый товар, красиво (касса), sample_photo_url —
-- образец, как купили, до доработки (замачивание в масле и т.п.). Без доработки
-- образец не нужен — показываем фото товара.

create table if not exists shop_suppliers (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (btrim(name) <> ''),
    phone       text,
    contacts    text,
    address     text,
    map_url     text,
    goods_note  text,
    note        text,
    is_active   boolean not null default true,
    created_by  uuid default auth.uid(),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
comment on table shop_suppliers is 'Магазин: у кого ШРСК закупает товар (картотека, без долгов)';
comment on column shop_suppliers.map_url is 'Ссылка на карту (кнопка «Моё место» пишет координаты)';

alter table shop_suppliers enable row level security;
create policy "shop view"  on shop_suppliers for select using (shop_can_view());
create policy "shop write" on shop_suppliers for insert with check (abk_current_user_has_permission('shop_receive'));
create policy "shop edit"  on shop_suppliers for update using (abk_current_user_has_permission('shop_receive'))
                                                  with check (abk_current_user_has_permission('shop_receive'));
grant select, insert, update on shop_suppliers to authenticated;

alter table shop_receipts add column if not exists supplier_id uuid references shop_suppliers(id);
create index if not exists shop_receipts_supplier_idx on shop_receipts (supplier_id) where supplier_id is not null;

alter table shop_items add column if not exists sample_photo_url text;
comment on column shop_items.sample_photo_url is 'Фото образца, как купили (до доработки); photo_url — готовый товар';

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
    v_supplier uuid := nullif(payload->>'supplier_id', '')::uuid;
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
    if v_kind <> 'purchase' then v_supplier := null; end if;   -- поставщик — только у закупки
    if v_kind in ('own', 'purchase') then
        v_owner := null;
    elsif v_owner is null then
        raise exception 'Не указан владелец товара';
    end if;

    insert into shop_receipts (kind, owner_id, supplier_id, received_on, note, created_by)
    values (v_kind, v_owner, v_supplier, v_date, payload->>'note', auth.uid())
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
    ('nav_shop_suppliers', 'Поставщики', 'Suppliers', 'आपूर्तिकर्ता', 'shop')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
