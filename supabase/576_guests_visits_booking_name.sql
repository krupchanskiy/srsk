-- Гости без события (ВГ, 28.09): у мест из брони группы в шахматке нет имени —
-- показываем название брони («Группа Говинда Махараджа») вместо прочерка;
-- building_id — для фильтра по корпусу в окне начисления.
create or replace function fin_list_no_event_visits(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
    v_ret uuid := fin_private_no_event_retreat();
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'resident_id', r.id,
            'vaishnava_id', r.vaishnava_id,
            'name', coalesce(nullif(fin_private_person_name(r.vaishnava_id), ''), nullif(r.guest_name, ''), bk.name, '—'),
            'booking_name', bk.name,
            'building_id', rm.building_id,
            'guest_name', r.guest_name,
            'guest_phone', r.guest_phone,
            'guest_email', r.guest_email,
            'check_in', r.check_in,
            'check_out', r.check_out,
            'status', r.status,
            'has_meals', r.has_meals,
            'early_checkin', coalesce(r.early_checkin, false),
            'late_checkout', coalesce(r.late_checkout, false),
            'room_id', r.room_id,
            'room', rm.number,
            'capacity', rm.capacity,
            'building', b.name_ru,
            -- сколько человек одновременно жили в номере (пик), включая самого гостя
            'roommates', (select max(cnt) from (
                select count(*) cnt from generate_series(r.check_in, coalesce(r.check_out, r.check_in), interval '1 day') g(d)
                  join residents o on o.room_id = r.room_id and o.status in ('confirmed', 'checked_out')
                   and o.check_in <= g.d::date and coalesce(o.check_out, o.check_in) > g.d::date
                 group by g.d) x),
            'charged', (select coalesce(sum(c.amount - c.discount_amount), 0) from fin_charges c
                         where c.resident_id = r.id and not c.is_cancelled),
            'charge_currency', (select min(c.currency_code) from fin_charges c
                                 where c.resident_id = r.id and not c.is_cancelled),
            'balance', case when r.vaishnava_id is not null
                            then fin_private_participant_balance_v2(r.vaishnava_id, v_ret) end
        ) order by r.check_in desc, r.guest_name)
          from residents r
          join resident_categories rc on rc.id = r.category_id and rc.slug = 'guest'
          left join rooms rm on rm.id = r.room_id
          left join buildings b on b.id = rm.building_id
          left join bookings bk on bk.id = r.booking_id
         where r.retreat_id is null
           and r.status in ('confirmed', 'checked_out')
           and r.check_in <= p_to and coalesce(r.check_out, r.check_in) >= p_from
    ), '[]'::jsonb);
end;
$$;
