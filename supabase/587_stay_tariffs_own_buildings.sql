-- 587: «Тарифы» гостей и групп — только наши здания (ВГ, 29.09.2026).
-- «Мы отвечаем только за свои: Гостевой дом, Вайрагья-ашрам и коттеджи. Бхадур, Анийор и
-- другие — это к другому ретриту, их убрать». Наши = постоянные здания (buildings.is_temporary
-- = false); арендованные на время (Бхадур, Анийор, Бхагерия, Бридж-васундара, Нитья) —
-- в тарифы не попадают. Прайс ретритов в CRM это не затрагивает.

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
        -- номера наших (постоянных) зданий из справочника услуг CRM: здание, вместимость, цена
        'rooms', coalesce((
            select jsonb_agg(jsonb_build_object(
                'service_id', s.id, 'code', s.code, 'name', s.name_ru,
                'building_id', s.building_id, 'building', b.name_ru,
                'capacity', s.room_capacity, 'pattern', s.room_number_pattern,
                'price', p.price, 'from', p.effective_date)
                order by b.sort_order, b.name_ru, s.room_capacity, s.sort_order)
              from crm_services s
              join buildings b on b.id = s.building_id and not coalesce(b.is_temporary, false)
              left join lateral (select x.price, x.effective_date from fin_stay_room_prices x
                                  where x.service_id = s.id and x.effective_date <= p_on
                                  order by x.effective_date desc limit 1) p on true
             where s.category = 'accommodation' and s.is_active and s.room_capacity is not null), '[]'::jsonb));
end;
$$;
