-- Оплата группой, шаг 2 (ВГ, 28.09.2026): у группы разные заезды по номерам, часть мест
-- может быть «не начисляем» (Махарадж — гость ашрама / пожертвование).
--   • строка листа: included=false + exclude_reason — остаётся в отчёте, в итог не идёт;
--   • fin_group_get: у места booking_id и заметка брони (там имена), список броней события
--     «мест в брони / в шахматке» — кого не хватает до начисления;
--   • «включить питание» в окнах гостя и группы снимает has_meals=false в шахматке —
--     кухня и начисление считают одинаково.

create or replace function fin_group_get(p_retreat uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
    v_sheet fin_group_sheets%rowtype;
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    select * into v_sheet from fin_group_sheets where retreat_id = p_retreat;
    return jsonb_build_object(
        'retreat', (select jsonb_build_object('id', id, 'name', name_ru, 'short_name', short_name,
                            'start_date', start_date, 'end_date', end_date, 'is_external', is_external)
                      from retreats where id = p_retreat and not is_system),
        'sheet', case when v_sheet.retreat_id is null then null else jsonb_build_object(
                    'payer_id', v_sheet.payer_id, 'lines', v_sheet.lines, 'totals', v_sheet.totals,
                    'updated_at', v_sheet.updated_at) end,
        'payer', (select jsonb_build_object('id', v.id, 'name', fin_private_person_name(v.id),
                          'phone', v.phone, 'email', v.email)
                    from vaishnavas v where v.id = v_sheet.payer_id),
        'places', coalesce((
            select jsonb_agg(jsonb_build_object(
                'resident_id', r.id,
                'vaishnava_id', r.vaishnava_id,
                'name', coalesce(nullif(fin_private_person_name(r.vaishnava_id), ''), nullif(r.guest_name, '')),
                'booking_name', bk.name,
                'booking_id', r.booking_id,
                'booking_notes', bk.notes,
                'check_in', r.check_in,
                'check_out', r.check_out,
                'has_meals', r.has_meals,
                'early_checkin', coalesce(r.early_checkin, false),
                'late_checkout', coalesce(r.late_checkout, false),
                'room_id', r.room_id,
                'room', rm.number,
                'capacity', rm.capacity,
                'building', b.name_ru,
                'building_id', rm.building_id,
                -- пик одновременно живущих в номере (все, не только группа)
                'roommates', (select max(cnt) from (
                    select count(*) cnt from generate_series(r.check_in, coalesce(r.check_out, r.check_in), interval '1 day') g(d)
                      join residents o on o.room_id = r.room_id and o.status in ('confirmed', 'checked_out')
                       and o.check_in <= g.d::date and coalesce(o.check_out, o.check_in) > g.d::date
                     group by g.d) x)
            ) order by b.name_ru, nullif(regexp_replace(rm.number, '\D', '', 'g'), '')::int nulls last, rm.number, r.check_in, r.id)
              from residents r
              left join rooms rm on rm.id = r.room_id
              left join buildings b on b.id = rm.building_id
              left join bookings bk on bk.id = r.booking_id
             where r.retreat_id = p_retreat
               and r.status in ('confirmed', 'checked_out')), '[]'::jsonb),
        'eaters', coalesce((
            select jsonb_agg(jsonb_build_object(
                'meal_group_id', mg.id, 'name', mg.name, 'people_count', mg.people_count,
                'start_date', mg.start_date, 'end_date', mg.end_date,
                'breakfast', coalesce(mg.breakfast, false), 'lunch', coalesce(mg.lunch, false)
            ) order by mg.start_date, mg.name)
              from meal_groups mg where mg.retreat_id = p_retreat), '[]'::jsonb),
        -- брони события: сколько мест в брони и сколько из них в шахматке — кого не хватает
        'bookings', coalesce((
            select jsonb_agg(jsonb_build_object(
                'id', bk.id, 'name', bk.name, 'notes', bk.notes, 'beds', bk.beds_count,
                'check_in', bk.check_in, 'check_out', bk.check_out,
                'placed', (select count(*) from residents r where r.booking_id = bk.id
                             and r.status in ('confirmed', 'checked_out'))
            ) order by bk.check_in, bk.name)
              from bookings bk where bk.retreat_id = p_retreat and bk.status <> 'cancelled'), '[]'::jsonb)
    );
end;
$$;

-- Сохранить лист и пересчитать итоги на карточке организатора.
-- payload: retreat_id, payer_id | new_person {spiritual_name, first_name, last_name, phone, email},
--          lines [{key, resident_id?, meal_group_id?, label?, nights, room_price, people,
--                  breakfasts, lunches, b_price, l_price, extra, meals?, check_in?, check_out?,
--                  early_checkin?, late_checkout?, note?}]
create or replace function fin_group_save(payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid; v_detail text; v_ret retreats%rowtype; v_obj uuid; v_legacy boolean;
    v_payer uuid; v_old_payer uuid; v_np jsonb; v_name text; v_phone text; v_email text;
    l jsonb; v_lines jsonb := '[]'::jsonb; v_rid uuid; v_gid uuid;
    v_acc numeric := 0; v_meals numeric := 0; v_extra numeric := 0;
    v_places int := 0; v_rooms int; v_bf numeric := 0; v_ln numeric := 0;
    v_cur text := 'INR'; v_rate numeric := 1;
    k text; v_target numeric; v_have numeric; v_desc text; v_changed text[] := '{}';
    c record; v_res jsonb; v_period text;
    c_mark constant text := 'Группа: по листу мест';
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Начисления группе делает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['retreat_id', 'payer_id', 'new_person', 'lines']);
    select * into v_ret from retreats where id = fin_private_get_uuid(payload, 'retreat_id', true) and not is_system;
    if not found then raise exception 'invalid_payload' using detail = 'Событие не найдено'; end if;
    select id, legacy_inr_settlement into v_obj, v_legacy from fin_accounting_objects where retreat_id = v_ret.id;
    if v_obj is null then raise exception 'invalid_payload' using detail = 'У события нет учётного объекта'; end if;

    -- ---------- плательщик ----------
    select payer_id into v_old_payer from fin_group_sheets where retreat_id = v_ret.id;
    v_payer := fin_private_get_uuid(payload, 'payer_id', false);
    v_np := payload->'new_person';
    if v_payer is not null then
        if not exists (select 1 from vaishnavas where id = v_payer and not coalesce(is_deleted, false)) then
            raise exception 'invalid_payload' using detail = 'Карточка организатора не найдена';
        end if;
    elsif v_np is not null and jsonb_typeof(v_np) = 'object' then
        perform fin_private_assert_keys(v_np, array['spiritual_name', 'first_name', 'last_name', 'phone', 'email']);
        v_name := nullif(trim(coalesce(v_np->>'spiritual_name', '') || coalesce(v_np->>'first_name', '')), '');
        v_phone := nullif(trim(coalesce(v_np->>'phone', '')), '');
        v_email := lower(nullif(trim(coalesce(v_np->>'email', '')), ''));
        if v_name is null then raise exception 'invalid_payload' using detail = 'Нужно имя организатора'; end if;
        if v_phone is null and v_email is null then
            raise exception 'contact_required' using detail = 'Для новой карточки нужен телефон или почта';
        end if;
        insert into vaishnavas (spiritual_name, first_name, last_name, phone, email, user_type, notes)
        values (nullif(trim(v_np->>'spiritual_name'), ''), nullif(trim(v_np->>'first_name'), ''),
                nullif(trim(v_np->>'last_name'), ''), v_phone, v_email, 'guest',
                'Заведён как организатор группы: ' || v_ret.name_ru)
        returning id into v_payer;
    else
        v_payer := v_old_payer;
    end if;
    if v_payer is null then raise exception 'invalid_payload' using detail = 'Выберите организатора — кто платит за группу'; end if;
    -- сменить плательщика можно, пока на прежнем нет итогов группы: иначе его оплаты повиснут
    if v_old_payer is not null and v_old_payer <> v_payer and exists (
        select 1 from fin_charges where participant_id = v_old_payer and retreat_id = v_ret.id
           and not is_cancelled and creation_reason like c_mark || '%') then
        raise exception 'payer_locked' using detail = format(
            'Группа уже начислена на %s. Сначала отмените начисления группы на его карточке', fin_private_person_name(v_old_payer));
    end if;

    -- ---------- строки: проверка и суммы в ₹ (та же формула, что в окне) ----------
    if jsonb_typeof(payload->'lines') <> 'array' then
        raise exception 'invalid_payload' using detail = 'lines: нужен массив строк';
    end if;
    for l in select x from jsonb_array_elements(payload->'lines') x loop
        perform fin_private_assert_keys(l, array['key', 'resident_id', 'meal_group_id', 'label', 'nights', 'room_price',
            'people', 'breakfasts', 'lunches', 'b_price', 'l_price', 'extra', 'meals', 'check_in', 'check_out',
            'early_checkin', 'late_checkout', 'note', 'persons', 'included', 'exclude_reason', 'booking_id', 'has_meals']);
        v_rid := fin_private_get_uuid(l, 'resident_id', false);
        v_gid := fin_private_get_uuid(l, 'meal_group_id', false);
        if v_rid is not null and not exists (select 1 from residents where id = v_rid and retreat_id = v_ret.id) then
            raise exception 'invalid_payload' using detail = 'Место не из этого события';
        end if;
        if v_gid is not null and not exists (select 1 from meal_groups where id = v_gid and retreat_id = v_ret.id) then
            raise exception 'invalid_payload' using detail = 'Группа питания не из этого события';
        end if;
        if coalesce((l->>'nights')::numeric, 0) < 0 or coalesce((l->>'room_price')::numeric, 0) < 0
           or coalesce((l->>'people')::numeric, 1) < 1 or coalesce((l->>'breakfasts')::numeric, 0) < 0
           or coalesce((l->>'lunches')::numeric, 0) < 0 or coalesce((l->>'b_price')::numeric, 0) < 0
           or coalesce((l->>'l_price')::numeric, 0) < 0 or coalesce((l->>'extra')::numeric, 0) < 0 then
            raise exception 'invalid_payload' using detail = 'Отрицательные числа в строке ' || coalesce(l->>'label', '');
        end if;
        -- «не начисляем» (гость ашрама, пожертвование): строка остаётся в листе и отчёте, в итог не идёт
        if not coalesce((l->>'included')::boolean, true) then
            if nullif(trim(coalesce(l->>'exclude_reason', '')), '') is null then
                raise exception 'invalid_payload' using detail = 'Укажите, почему не начисляем: ' || coalesce(l->>'label', 'место');
            end if;
            v_lines := v_lines || jsonb_build_array(l);
            continue;
        end if;
        v_acc := v_acc + round(coalesce((l->>'nights')::numeric, 0)
                     * round(coalesce((l->>'room_price')::numeric, 0) / coalesce(nullif((l->>'people')::numeric, 0), 1), 2), 2);
        v_meals := v_meals + round(coalesce((l->>'breakfasts')::numeric, 0) * coalesce((l->>'b_price')::numeric, 0)
                         + coalesce((l->>'lunches')::numeric, 0) * coalesce((l->>'l_price')::numeric, 0), 2);
        v_extra := v_extra + round(coalesce((l->>'extra')::numeric, 0), 2);
        v_bf := v_bf + coalesce((l->>'breakfasts')::numeric, 0);
        v_ln := v_ln + coalesce((l->>'lunches')::numeric, 0);
        if v_rid is not null and coalesce((l->>'nights')::numeric, 0) > 0 then v_places := v_places + 1; end if;
        -- края питания → шахматка (завтрак в день заезда / обед в день выезда), чтобы кухня
        -- посчитала так же, как начислено
        if v_rid is not null then
            -- has_meals=true — питание включили в окне (в шахматке было выключено по ошибке)
            update residents set
                early_checkin = case when l ? 'early_checkin' then (l->>'early_checkin')::boolean else early_checkin end,
                late_checkout = case when l ? 'late_checkout' then (l->>'late_checkout')::boolean else late_checkout end,
                has_meals = case when (l->>'has_meals')::boolean then null else has_meals end
             where id = v_rid
               and ((l ? 'early_checkin' and coalesce(early_checkin, false) <> (l->>'early_checkin')::boolean)
                 or (l ? 'late_checkout' and coalesce(late_checkout, false) <> (l->>'late_checkout')::boolean)
                 or (coalesce((l->>'has_meals')::boolean, false) and has_meals is not distinct from false));
        end if;
        v_lines := v_lines || jsonb_build_array(l);
    end loop;
    select count(distinct r.room_id) into v_rooms
      from jsonb_array_elements(v_lines) x join residents r on r.id = (x->>'resident_id')::uuid
     where coalesce((x->>'nights')::numeric, 0) > 0 and coalesce((x->>'included')::boolean, true);

    -- ---------- итоги на карточке организатора ----------
    if not v_legacy then
        select o_currency into v_cur from fin_private_settlement_currency(v_payer, v_ret.id);
    end if;
    v_rate := fin_private_retreat_rate(v_cur, v_obj, current_date);   -- нет курса события → понятная ошибка
    v_period := to_char(v_ret.start_date, 'DD.MM') || '–' || to_char(v_ret.end_date, 'DD.MM.YYYY');

    foreach k in array array['accommodation', 'meals', 'extra'] loop
        v_target := round(case k when 'accommodation' then v_acc when 'meals' then v_meals else v_extra end / v_rate, 2);
        select coalesce(sum(amount - discount_amount), 0) into v_have from fin_charges
         where participant_id = v_payer and retreat_id = v_ret.id and kind = k::fin_charge_kind
           and not is_cancelled and creation_reason like c_mark || '%';
        continue when abs(v_have - v_target) < 0.01
                  and not exists (select 1 from fin_charges where participant_id = v_payer and retreat_id = v_ret.id
                                    and kind = k::fin_charge_kind and not is_cancelled
                                    and creation_reason like c_mark || '%' and currency_code <> v_cur);
        for c in select id from fin_charges
                  where participant_id = v_payer and retreat_id = v_ret.id and kind = k::fin_charge_kind
                    and not is_cancelled and creation_reason like c_mark || '%' loop
            v_res := fin_cancel_charge(jsonb_build_object('charge_id', c.id, 'reason', 'Перерасчёт группы'));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_res->'error'->>'code', 'internal_error')
                    using detail = coalesce(v_res->'error'->>'message', 'Не удалось отменить прежний итог');
            end if;
        end loop;
        if v_target > 0 then
            v_desc := case k
                when 'accommodation' then format('Проживание группы %s: %s мест в %s номерах', v_period, v_places, v_rooms)
                when 'meals' then format('Питание группы %s: завтраков %s, обедов %s', v_period, v_bf, v_ln)
                else format('Дополнительно по группе %s', v_period) end;
            v_res := fin_create_charge(jsonb_build_object('rows', jsonb_build_array(jsonb_build_object(
                'id', gen_random_uuid(), 'participant_id', v_payer, 'retreat_id', v_ret.id, 'kind', k,
                'description', v_desc, 'quantity', 1, 'unit_price', v_target,
                'creation_reason', c_mark, 'occurred_on', v_ret.start_date))));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_res->'error'->>'code', 'internal_error')
                    using detail = coalesce(v_res->'error'->>'message', 'Не удалось начислить итог');
            end if;
        end if;
        v_changed := v_changed || k;
    end loop;

    insert into fin_group_sheets (retreat_id, payer_id, lines, totals, updated_at, updated_by)
    values (v_ret.id, v_payer, v_lines,
            jsonb_build_object('accommodation', v_acc, 'meals', v_meals, 'extra', v_extra,
                               'currency', v_cur, 'rate', v_rate), now(), v_actor)
    on conflict (retreat_id) do update
       set payer_id = excluded.payer_id, lines = excluded.lines, totals = excluded.totals,
           updated_at = now(), updated_by = excluded.updated_by;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object(
        'payer_id', v_payer, 'currency', v_cur, 'rate', v_rate, 'changed', to_jsonb(v_changed),
        'totals_inr', jsonb_build_object('accommodation', v_acc, 'meals', v_meals, 'extra', v_extra)),
        'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;


-- Окно гостя без события: «включить питание» тоже уходит в шахматку
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
    perform fin_private_assert_keys(payload, array['resident_id', 'vaishnava_id', 'new_person', 'early_checkin', 'late_checkout', 'has_meals']);
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
        late_checkout = case when payload ? 'late_checkout' then (payload->>'late_checkout')::boolean else late_checkout end,
        -- питание включили в окне начисления → и в шахматке (null = как у всех, по датам)
        has_meals = case when coalesce((payload->>'has_meals')::boolean, false) then null else has_meals end
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


revoke all on function fin_group_get(uuid) from public, anon;
revoke all on function fin_group_save(jsonb) from public, anon;
grant execute on function fin_group_get(uuid) to authenticated;
grant execute on function fin_group_save(jsonb) to authenticated;
