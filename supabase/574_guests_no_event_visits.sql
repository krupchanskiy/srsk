-- Гости без события, шаг 2 (ВГ, 28.09.2026): окно начисления по визиту.
--   • fin_list_no_event_visits — визиты «Гость без ретрита» из шахматки за период;
--   • fin_guest_person_candidates — «тот же человек?»: карточки по имени, телефону, почте
--     с историей приездов;
--   • fin_guest_prepare_visit — привязать визит к карточке (существующей или новой)
--     и записать ранний заезд / поздний выезд, чтобы кухня и начисление не расходились;
--   • fin_v_charges отдаёт resident_id (к какому визиту начисление).

create or replace view fin_v_charges as
 select id, participant_id, fin_private_person_name(participant_id) as participant_name,
    retreat_id, kind, description, quantity, unit_price, amount, discount_amount,
    (amount - discount_amount) as net_amount, discount_reason, agreed_with, is_cancelled,
    cancelled_reason, creation_reason, created_at, occurred_on, currency_code, resident_id
   from fin_charges c
  where fin_can_read_all();

-- Визиты за период: только «Гость» без ретрита (категория guest), не отменённые
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
            'name', coalesce(nullif(fin_private_person_name(r.vaishnava_id), ''), r.guest_name, '—'),
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
         where r.retreat_id is null
           and r.status in ('confirmed', 'checked_out')
           and r.check_in <= p_to and coalesce(r.check_out, r.check_in) >= p_from
    ), '[]'::jsonb);
end;
$$;

-- «Тот же человек?» — совпадения по телефону (последние 9 цифр), почте и словам имени,
-- с историей: ретриты и визиты без события
create or replace function fin_guest_person_candidates(p_name text, p_phone text default null, p_email text default null)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
    v_words text[];
    v_phone text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
    v_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    -- значимые слова имени: без «дас», «деви», «даси», «д.д.» и коротких
    select array_agg(w) into v_words
      from regexp_split_to_table(lower(coalesce(p_name, '')), '[\s\.,]+') w
     where length(w) >= 3 and w not in ('дас', 'даси', 'деви', 'das', 'dasi', 'devi', 'прабху', 'матаджи');
    return coalesce((
        select jsonb_agg(x order by (x->>'score')::int desc, x->>'name') from (
            select jsonb_build_object(
                'id', v.id,
                'name', fin_private_person_name(v.id),
                'phone', v.phone,
                'email', v.email,
                'country', v.country,
                'score', (case when length(v_phone) >= 7 and right(regexp_replace(coalesce(v.phone, '') || ' ' || coalesce(v.indian_phone, ''), '\D', '', 'g'), 9) = v_phone then 3 else 0 end)
                       + (case when v_email is not null and lower(v.email) = v_email then 3 else 0 end)
                       + (case when v_words is not null and (select bool_and(
                                 lower(concat_ws(' ', v.spiritual_name, v.first_name, v.last_name)) like '%' || w || '%')
                                 from unnest(v_words) w) then 2 else 0 end),
                'events', coalesce((
                    select jsonb_agg(ev order by ev->>'from' desc) from (
                        select jsonb_build_object('name', coalesce(rt.short_name, rt.name_ru), 'from', rt.start_date) ev
                          from retreat_registrations rr join retreats rt on rt.id = rr.retreat_id and not rt.is_system
                         where rr.vaishnava_id = v.id and not rr.is_deleted and rr.status <> 'cancelled'
                        union all
                        select jsonb_build_object('name', 'Гость без события', 'from', rs.check_in, 'to', rs.check_out)
                          from residents rs
                         where rs.vaishnava_id = v.id and rs.retreat_id is null and rs.status in ('confirmed', 'checked_out')
                    ) h), '[]'::jsonb)
            ) x
              from vaishnavas v
             where not coalesce(v.is_deleted, false)
               and ((length(v_phone) >= 7 and right(regexp_replace(coalesce(v.phone, '') || ' ' || coalesce(v.indian_phone, ''), '\D', '', 'g'), 9) = v_phone)
                 or (v_email is not null and lower(v.email) = v_email)
                 or (v_words is not null and (select bool_and(
                        lower(concat_ws(' ', v.spiritual_name, v.first_name, v.last_name)) like '%' || w || '%')
                        from unnest(v_words) w)))
             limit 20
        ) c
    ), '[]'::jsonb);
end;
$$;

-- Привязать визит к карточке и поправить края питания.
-- payload: resident_id, vaishnava_id | new_person {spiritual_name, first_name, last_name, phone, email},
--          early_checkin?, late_checkout?
create or replace function fin_guest_prepare_visit(payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid; v_detail text; v_res residents%rowtype; v_pid uuid; v_np jsonb;
    v_name text; v_phone text; v_email text;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Оплату гостей проводит администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'vaishnava_id', 'new_person', 'early_checkin', 'late_checkout']);
    select * into v_res from residents where id = fin_private_get_uuid(payload, 'resident_id', true) for update;
    if not found then raise exception 'invalid_payload' using detail = 'Проживание (визит) не найдено'; end if;
    if v_res.retreat_id is not null then
        raise exception 'invalid_payload' using detail = 'Это проживание ретрита — оплата через ретрит';
    end if;

    v_pid := fin_private_get_uuid(payload, 'vaishnava_id', false);
    v_np := payload->'new_person';
    if v_pid is not null then
        if not exists (select 1 from vaishnavas where id = v_pid and not coalesce(is_deleted, false)) then
            raise exception 'invalid_payload' using detail = 'Карточка не найдена';
        end if;
    elsif v_np is not null and jsonb_typeof(v_np) = 'object' then
        perform fin_private_assert_keys(v_np, array['spiritual_name', 'first_name', 'last_name', 'phone', 'email']);
        v_name := nullif(trim(coalesce(v_np->>'spiritual_name', '') || coalesce(v_np->>'first_name', '')), '');
        v_phone := nullif(trim(coalesce(v_np->>'phone', '')), '');
        v_email := lower(nullif(trim(coalesce(v_np->>'email', '')), ''));
        if v_name is null then raise exception 'invalid_payload' using detail = 'Нужно имя (духовное или обычное)'; end if;
        -- без контакта карточка неотличима от тёзки — каталог превращается в свалку (ВГ, 28.09)
        if v_phone is null and v_email is null then
            raise exception 'contact_required' using detail = 'Для новой карточки нужен телефон или почта';
        end if;
        insert into vaishnavas (spiritual_name, first_name, last_name, phone, email, user_type, notes)
        values (nullif(trim(v_np->>'spiritual_name'), ''), nullif(trim(v_np->>'first_name'), ''),
                nullif(trim(v_np->>'last_name'), ''), v_phone, v_email, 'guest',
                'Заведён при оплате: гость без события')
        returning id into v_pid;
    elsif v_res.vaishnava_id is not null then
        v_pid := v_res.vaishnava_id;
    else
        raise exception 'invalid_payload' using detail = 'Выберите карточку или заведите новую';
    end if;

    if v_res.vaishnava_id is not null and v_res.vaishnava_id <> v_pid then
        raise exception 'invalid_payload' using detail = 'Проживание уже привязано к другой карточке';
    end if;

    update residents set
        vaishnava_id = v_pid,
        early_checkin = case when payload ? 'early_checkin' then (payload->>'early_checkin')::boolean else early_checkin end,
        late_checkout = case when payload ? 'late_checkout' then (payload->>'late_checkout')::boolean else late_checkout end
     where id = v_res.id;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object('vaishnava_id', v_pid), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

revoke all on function fin_list_no_event_visits(date, date) from public, anon;
revoke all on function fin_guest_person_candidates(text, text, text) from public, anon;
revoke all on function fin_guest_prepare_visit(jsonb) from public, anon;
grant execute on function fin_list_no_event_visits(date, date) to authenticated;
grant execute on function fin_guest_person_candidates(text, text, text) to authenticated;
grant execute on function fin_guest_prepare_visit(jsonb) to authenticated;

insert into translations (key, ru, en, hi, context) values
    ('fin_no_event_guests', 'Гости без события', 'Guests without event', 'बिना कार्यक्रम के अतिथि', 'Финансы'),
    ('fin_stay_tariffs', 'Тарифы', 'Rates', 'दरें', 'Финансы'),
    ('fin_new_guest_charge', 'Начислить гостю', 'Charge a guest', 'अतिथि को शुल्क', 'Финансы')
on conflict (key) do nothing;
