-- 586: цены проживания по зданию и вместимости — как прайс ретритов в CRM (ВГ, 29.09.2026).
-- «Цена пока только за Гостевой дом (2-местный 3500, 4-местный 5500). Вайрагья-ашрам и
-- коттеджи — без цены, будем уточнять, скорее как 2-местный; внести в прейскурант по тому же
-- принципу — двухместное и четырехместное размещение, чтобы не возвращаться».
--   • в справочник услуг CRM (crm_services) добавлены номера Вайрагья-ашрама (2- и 4-местный),
--     Коттеджа 1 (2- и 4-местный: №2 на 5 мест — 4-местный + доп. кровать) и Коттеджа 2
--     (2-местный: №1, 4 на 3 места — 2-местный + доп. кровать). Цены к ним в ретритах — как обычно,
--     в прайсе ретрита; CRM берёт только услуги с ценой, пустые ни на что не влияют;
--   • fin_stay_room_prices — цены номеров для гостей без события и групп по тем же услугам,
--     с датой «действует с»; нет строки / пусто — цена не задана (окно просит вписать);
--   • room2_price / room4_price в fin_stay_tariffs больше не используются (цены Гостевого дома
--     перенесены в fin_stay_room_prices).

-- ==================== Услуги-номера ====================
insert into crm_services (code, name_ru, name_en, category, unit, is_active, sort_order, building_id, room_capacity, default_price)
select v.code, v.name_ru, v.name_en, 'accommodation', 'piece', true, v.sort_order, b.id, v.cap, 0
  from (values
    ('room_vairagya_double', 'Вайрагья-ашрам, 2-местный номер', 'Vairagya Ashram, double room', 'Вайрагья-ашрам', 2, 14),
    ('room_vairagya_quad',   'Вайрагья-ашрам, 4-местный номер', 'Vairagya Ashram, quad room',   'Вайрагья-ашрам', 4, 15),
    ('room_cottage1_double', 'Коттедж 1, 2-местный номер',      'Cottage 1, double room',       'Коттедж 1',      2, 16),
    ('room_cottage1_quad',   'Коттедж 1, 4-местный номер',      'Cottage 1, quad room',         'Коттедж 1',      4, 17),
    ('room_cottage2_double', 'Коттедж 2, 2-местный номер',      'Cottage 2, double room',       'Коттедж 2',      2, 18)
  ) v(code, name_ru, name_en, bld, cap, sort_order)
  join buildings b on b.name_ru = v.bld
 where not exists (select 1 from crm_services s where s.code = v.code);

-- ==================== Цены номеров для гостей и групп ====================
create table if not exists fin_stay_room_prices (
    id uuid primary key default gen_random_uuid(),
    effective_date date not null,
    service_id uuid not null references crm_services(id),
    price numeric(12, 2) check (price >= 0),          -- null — цена снята / не задана
    created_by uuid,
    created_at timestamptz not null default now(),
    unique (effective_date, service_id)
);
alter table fin_stay_room_prices enable row level security;
revoke all on fin_stay_room_prices from anon, authenticated;

insert into fin_stay_room_prices (effective_date, service_id, price)
select t.effective_date, s.id, case s.code when 'room_srsk_double' then t.room2_price else t.room4_price end
  from fin_stay_tariffs t
  join crm_services s on s.code in ('room_srsk_double', 'room_srsk_quad')
 where t.effective_date = (select min(effective_date) from fin_stay_tariffs)
on conflict (effective_date, service_id) do nothing;

alter table fin_stay_tariffs alter column room2_price drop not null, alter column room4_price drop not null;

-- Действующий тариф на дату + история + цены номеров по услугам
create or replace function fin_get_stay_tariffs(p_on date default current_date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    return jsonb_build_object(
        'current', (select to_jsonb(t) from fin_stay_tariffs t
                     where t.effective_date <= p_on order by t.effective_date desc limit 1),
        'history', coalesce((select jsonb_agg(to_jsonb(t) order by t.effective_date desc)
                               from fin_stay_tariffs t), '[]'::jsonb),
        -- номера из справочника услуг CRM: здание, вместимость, действующая цена
        'rooms', coalesce((
            select jsonb_agg(jsonb_build_object(
                'service_id', s.id, 'code', s.code, 'name', s.name_ru,
                'building_id', s.building_id, 'building', b.name_ru,
                'capacity', s.room_capacity, 'pattern', s.room_number_pattern,
                'price', p.price, 'from', p.effective_date)
                order by (b.name_ru = 'Гостевой дом') desc, b.name_ru, s.room_capacity, s.sort_order)
              from crm_services s
              join buildings b on b.id = s.building_id
              left join lateral (select x.price, x.effective_date from fin_stay_room_prices x
                                  where x.service_id = s.id and x.effective_date <= p_on
                                  order by x.effective_date desc limit 1) p on true
             where s.category = 'accommodation' and s.is_active and s.room_capacity is not null), '[]'::jsonb));
end;
$$;

-- Новый тариф с даты; та же дата — исправление. room_prices: [{service_id, price|null}] —
-- пишется только то, что изменилось относительно действующего на эту дату
create or replace function fin_set_stay_tariffs(payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid; v_detail text; v_row fin_stay_tariffs%rowtype; v_extra numeric; v_date date;
    r jsonb; v_sid uuid; v_price numeric; v_cur numeric; v_has boolean;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Тарифы меняет администратор финансов';
    end if;
    perform fin_private_assert_keys(payload,
        array['effective_date', 'room2_price', 'room4_price', 'breakfast_price', 'lunch_price', 'extra_bed_price', 'room_prices']);
    v_date := fin_private_get_date(payload, 'effective_date', true);
    v_extra := coalesce(fin_private_get_money(payload, 'extra_bed_price', false),
        (select extra_bed_price from fin_stay_tariffs order by effective_date desc limit 1));
    insert into fin_stay_tariffs (effective_date, breakfast_price, lunch_price, extra_bed_price, created_by)
    values (v_date,
            fin_private_get_money(payload, 'breakfast_price', true),
            fin_private_get_money(payload, 'lunch_price', true),
            v_extra, v_actor)
    on conflict (effective_date) do update
       set breakfast_price = excluded.breakfast_price, lunch_price = excluded.lunch_price,
           extra_bed_price = excluded.extra_bed_price,
           created_by = excluded.created_by, created_at = now()
    returning * into v_row;

    if jsonb_typeof(payload->'room_prices') = 'array' then
        for r in select x from jsonb_array_elements(payload->'room_prices') x loop
            perform fin_private_assert_keys(r, array['service_id', 'price']);
            v_sid := fin_private_get_uuid(r, 'service_id', true);
            if not exists (select 1 from crm_services where id = v_sid and category = 'accommodation') then
                raise exception 'invalid_payload' using detail = 'Номер (услуга) не найден';
            end if;
            v_price := nullif(r->>'price', '')::numeric;
            if v_price is not null and v_price < 0 then
                raise exception 'invalid_payload' using detail = 'Цена номера не может быть отрицательной';
            end if;
            select true, x.price into v_has, v_cur from fin_stay_room_prices x
             where x.service_id = v_sid and x.effective_date <= v_date
             order by x.effective_date desc limit 1;
            continue when coalesce(v_has, false) and v_cur is not distinct from v_price;
            continue when not coalesce(v_has, false) and v_price is null;
            insert into fin_stay_room_prices (effective_date, service_id, price, created_by)
            values (v_date, v_sid, round(v_price, 2), v_actor)
            on conflict (effective_date, service_id) do update
               set price = excluded.price, created_by = excluded.created_by, created_at = now();
            v_has := null; v_cur := null;
        end loop;
    end if;
    return jsonb_build_object('ok', true, 'result', to_jsonb(v_row), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;
