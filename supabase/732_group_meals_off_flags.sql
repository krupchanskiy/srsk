-- 732: «Начислить группе» — «питание выключено» одинаково у всех, кого кухня не кормит (ВГ, 22.10).
-- В шахматке «не питается» бывает двумя способами: has_meals = false или has_meals пусто,
-- а галочки «Завтрак» и «Обед» сняты (так легли места групповой брони Дикши). Окно видело
-- только первый и у вторых писало «0 × цена». fin_group_get отдаёт галочки места;
-- fin_group_save по «включить» ставит и галочки — иначе кухня человека так и не считает.

CREATE OR REPLACE FUNCTION public.fin_group_get(p_retreat uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                    'payer_id', v_sheet.payer_id, 'lines', v_sheet.lines, 'totals', v_sheet.totals, 'prices', v_sheet.prices,
                    'updated_at', v_sheet.updated_at, 'draft', coalesce(v_sheet.draft_at > v_sheet.updated_at, false)) end,
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
                -- галочки шахматки: обе сняты — не питается, как has_meals = false (732)
                'breakfast', r.breakfast,
                'lunch', r.lunch,
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
                     group by g.d) x),
                -- пропущенные приёмы по дням (617)
                'skips', coalesce((select jsonb_agg(jsonb_build_object('d', s.d, 'b', s.breakfast, 'l', s.lunch) order by s.d)
                                     from resident_meal_skips s where s.resident_id = r.id), '[]'::jsonb)
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
              from bookings bk where bk.retreat_id = p_retreat and bk.status <> 'cancelled'), '[]'::jsonb),
        -- аванс группы: приходы «Предоплата/Аванс» на событие без человека (617)
        'advances', coalesce((
            select jsonb_agg(jsonb_build_object(
                'operation_id', o.id, 'date', o.occurred_on, 'amount', p.amount, 'currency', p.currency_code,
                'amount_inr', p.amount_base, 'comment', o.comment, 'account', a.name,
                'moved', p.participant_id is not null
            ) order by o.occurred_on, o.created_at)
              from fin_postings p
              join fin_operations o on o.id = p.operation_id
              join fin_accounting_objects ao on ao.id = p.object_id
              left join fin_accounts a on a.id = p.account_id
             where ao.retreat_id = p_retreat
               and ((p.category_id = '659c37b8-54dd-4bc1-a4be-ce2a771b6829' and p.participant_id is null)
                 or (o.type = 'payment' and o.reason = 'Аванс группы: перенесён на карточку организатора'))
               and p.direction = 'in'
               and not o.is_reversed and o.original_operation_id is null), '[]'::jsonb)
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.fin_group_save(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_actor uuid; v_detail text; v_ret retreats%rowtype; v_obj uuid; v_legacy boolean;
    v_payer uuid; v_old_payer uuid; v_np jsonb; v_name text; v_phone text; v_email text; v_prid uuid;
    l jsonb; v_lines jsonb := '[]'::jsonb; v_rid uuid; v_gid uuid; v_out date;
    v_acc numeric := 0; v_meals numeric := 0; v_extra numeric := 0;
    v_places int := 0; v_rooms int; v_bf numeric := 0; v_ln numeric := 0;
    v_cur text := 'INR'; v_rate numeric := 1;
    v_changed text[] := '{}'; v_period text;
    v_la numeric; v_lm numeric; v_le numeric; v_self uuid; v_selves uuid[] := '{}'; v_self_n int := 0;
    v_res jsonb; c record; v_in date;
    c_mark constant text := 'Группа: по листу мест';
    c_self constant text := 'Группа: платит сам';
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Начисления группе делает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['retreat_id', 'payer_id', 'payer_resident_id', 'new_person', 'lines', 'prices']);
    select * into v_ret from retreats where id = fin_private_get_uuid(payload, 'retreat_id', true) and not is_system;
    if not found then raise exception 'invalid_payload' using detail = 'Событие не найдено'; end if;
    select id, legacy_inr_settlement into v_obj, v_legacy from fin_accounting_objects where retreat_id = v_ret.id;
    if v_obj is null then raise exception 'invalid_payload' using detail = 'У события нет учётного объекта'; end if;
    if jsonb_typeof(payload->'lines') <> 'array' then
        raise exception 'invalid_payload' using detail = 'lines: нужен массив строк';
    end if;

    select payer_id into v_old_payer from fin_group_sheets where retreat_id = v_ret.id;
    v_payer := fin_private_get_uuid(payload, 'payer_id', false);
    v_prid := fin_private_get_uuid(payload, 'payer_resident_id', false);
    v_np := payload->'new_person';
    if v_payer is not null then
        if not exists (select 1 from vaishnavas where id = v_payer and not coalesce(is_deleted, false)) then
            raise exception 'invalid_payload' using detail = 'Карточка организатора не найдена';
        end if;
    elsif v_prid is not null then
        -- организатор живёт с группой — выбран из строки списка; нет карточки — заводим по имени
        if not exists (select 1 from residents where id = v_prid and retreat_id = v_ret.id) then
            raise exception 'invalid_payload' using detail = 'Организатор — место не из этого события';
        end if;
        v_payer := fin_private_group_person(v_prid,
            (select x->>'label' from jsonb_array_elements(payload->'lines') x where x->>'resident_id' = v_prid::text limit 1),
            v_ret, 'Заведён как организатор группы');
    elsif v_np is not null and jsonb_typeof(v_np) = 'object' then
        perform fin_private_assert_keys(v_np, array['spiritual_name', 'first_name', 'last_name', 'phone', 'email']);
        v_name := nullif(trim(coalesce(v_np->>'spiritual_name', '') || coalesce(v_np->>'first_name', '')), '');
        v_phone := nullif(trim(coalesce(v_np->>'phone', '')), '');
        v_email := lower(nullif(trim(coalesce(v_np->>'email', '')), ''));
        -- достаточно имени: кто придёт платить за группу — не важно (ВГ, 02.10)
        if v_name is null then raise exception 'invalid_payload' using detail = 'Нужно имя организатора'; end if;
        insert into vaishnavas (spiritual_name, first_name, last_name, phone, email, user_type, notes)
        values (nullif(trim(v_np->>'spiritual_name'), ''), nullif(trim(v_np->>'first_name'), ''),
                nullif(trim(v_np->>'last_name'), ''), v_phone, v_email, 'guest',
                'Заведён как организатор группы: ' || v_ret.name_ru)
        returning id into v_payer;
    else
        v_payer := v_old_payer;
    end if;
    if v_payer is null then raise exception 'invalid_payload' using detail = 'Выберите организатора — кто платит за группу'; end if;
    if v_old_payer is not null and v_old_payer <> v_payer and exists (
        select 1 from fin_charges where participant_id = v_old_payer and retreat_id = v_ret.id
           and not is_cancelled and creation_reason like c_mark || '%') then
        raise exception 'payer_locked' using detail = format(
            'Группа уже начислена на %s. Сначала отмените начисления группы на его карточке', fin_private_person_name(v_old_payer));
    end if;

    v_period := to_char(v_ret.start_date, 'DD.MM') || '–' || to_char(v_ret.end_date, 'DD.MM.YYYY');
    for l in select x from jsonb_array_elements(payload->'lines') x loop
        perform fin_private_assert_keys(l, array['key', 'resident_id', 'meal_group_id', 'label', 'nights', 'room_price',
            'people', 'breakfasts', 'lunches', 'b_price', 'l_price', 'extra', 'meals', 'check_in', 'check_out',
            'early_checkin', 'late_checkout', 'note', 'persons', 'included', 'exclude_reason', 'booking_id', 'has_meals',
            'extra_bed', 'extra_bed_price', 'depart_on', 'self_pay', 'skips', 'night_price', 'late_fee', 'departure_time']);
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
           or coalesce((l->>'l_price')::numeric, 0) < 0 or coalesce((l->>'extra')::numeric, 0) < 0
           or coalesce((l->>'extra_bed_price')::numeric, 0) < 0 or coalesce((l->>'night_price')::numeric, 0) < 0
           or coalesce((l->>'late_fee')::numeric, 0) < 0 then
            raise exception 'invalid_payload' using detail = 'Отрицательные числа в строке ' || coalesce(l->>'label', '');
        end if;
        -- «Уезжает в ~» из окна оплаты → место в шахматке (731)
        if v_rid is not null and l ? 'departure_time' then
            update residents set departure_time = nullif(l->>'departure_time', '')::time where id = v_rid;
        end if;
        -- уехал раньше: выезд из окна → шахматка (только раньше прежнего и не раньше заезда)
        if v_rid is not null and nullif(l->>'depart_on', '') is not null then
            update residents set check_out = (l->>'depart_on')::date
             where id = v_rid and (l->>'depart_on')::date >= check_in
               and (l->>'depart_on')::date < coalesce(check_out, 'infinity'::date);
        end if;
        -- пропуски питания по дням → кухня (617): заменяем целиком, только внутри проживания;
        -- завтрак дня заезда и обед дня выезда — галочки раннего заезда / позднего выезда
        if v_rid is not null and l ? 'skips' then
            select check_in, check_out into v_in, v_out from residents where id = v_rid;
            delete from resident_meal_skips where resident_id = v_rid;
            insert into resident_meal_skips (resident_id, d, breakfast, lunch, created_by)
            select v_rid, s.d, s.b, s.l, v_actor from (
                select (x->>'d')::date d,
                       coalesce((x->>'b')::boolean, false) and (x->>'d')::date <> v_in b,
                       coalesce((x->>'l')::boolean, false) and (x->>'d')::date is distinct from v_out l
                  from jsonb_array_elements(case when jsonb_typeof(l->'skips') = 'array' then l->'skips' else '[]'::jsonb end) x
            ) s
             where s.d >= v_in and (v_out is null or s.d <= v_out) and (s.b or s.l)
            on conflict (resident_id, d) do nothing;
        end if;
        if not coalesce((l->>'included')::boolean, true) then
            if nullif(trim(coalesce(l->>'exclude_reason', '')), '') is null then
                raise exception 'invalid_payload' using detail = 'Укажите, почему не начисляем: ' || coalesce(l->>'label', 'место');
            end if;
            v_lines := v_lines || jsonb_build_array(l);
            continue;
        end if;
        -- доп. кровать (3-местный = 2-местный + доп. кровать): за ночь — цена доп. кровати,
        -- иначе доля номера (618: целыми рупиями из окна, без неё — номер ÷ жильцов)
        v_la := round(coalesce((l->>'nights')::numeric, 0)
                     * case when coalesce((l->>'extra_bed')::boolean, false)
                            then coalesce((l->>'extra_bed_price')::numeric, 0)
                            else coalesce((l->>'night_price')::numeric,
                                          round(coalesce((l->>'room_price')::numeric, 0) / coalesce(nullif((l->>'people')::numeric, 0), 1), 2)) end, 2);
        -- поздний выезд (731) — в проживание
        v_la := v_la + round(coalesce((l->>'late_fee')::numeric, 0), 2);
        v_lm := round(coalesce((l->>'breakfasts')::numeric, 0) * coalesce((l->>'b_price')::numeric, 0)
                         + coalesce((l->>'lunches')::numeric, 0) * coalesce((l->>'l_price')::numeric, 0), 2);
        v_le := round(coalesce((l->>'extra')::numeric, 0), 2);
        if v_rid is not null then
            update residents set
                early_checkin = case when l ? 'early_checkin' then (l->>'early_checkin')::boolean else early_checkin end,
                late_checkout = case when l ? 'late_checkout' then (l->>'late_checkout')::boolean else late_checkout end,
                has_meals = case when (l->>'has_meals')::boolean then null else has_meals end,
                -- «включить» в окне группы: и галочки «Завтрак»/«Обед», иначе кухня так и не считает (732)
                breakfast = case when (l->>'has_meals')::boolean then true else breakfast end,
                lunch = case when (l->>'has_meals')::boolean then true else lunch end
             where id = v_rid
               and ((l ? 'early_checkin' and coalesce(early_checkin, false) <> (l->>'early_checkin')::boolean)
                 or (l ? 'late_checkout' and coalesce(late_checkout, false) <> (l->>'late_checkout')::boolean)
                 or (coalesce((l->>'has_meals')::boolean, false)
                     and (has_meals is not distinct from false or (breakfast is not distinct from false and lunch is not distinct from false))));
        end if;
        -- платит сам: место остаётся в группе, сумма — на его карточке (ВГ, 02.10)
        if v_rid is not null and coalesce((l->>'self_pay')::boolean, false) then
            v_self := fin_private_group_person(v_rid, l->>'label', v_ret, 'Заведён из группы (платит сам)');
            if v_self = v_payer then
                raise exception 'invalid_payload' using detail = 'Организатор не может «платить сам» — он платит за группу';
            end if;
            if v_self = any(v_selves) then
                raise exception 'invalid_payload' using detail = 'Один человек отмечен «платит сам» дважды: ' || coalesce(l->>'label', '');
            end if;
            v_selves := v_selves || v_self;
            v_self_n := v_self_n + 1;
            perform fin_private_group_sync(v_self, v_ret, v_obj, v_legacy, c_self, v_la, v_lm, v_le,
                format('Проживание %s: %s ноч.', v_period, coalesce(l->>'nights', '0')),
                format('Питание %s: завтраков %s, обедов %s', v_period, coalesce(l->>'breakfasts', '0'), coalesce(l->>'lunches', '0')),
                format('Дополнительно %s', v_period));
            v_lines := v_lines || jsonb_build_array(l || jsonb_build_object('self_payer_id', v_self));
            continue;
        end if;
        v_acc := v_acc + v_la; v_meals := v_meals + v_lm; v_extra := v_extra + v_le;
        v_bf := v_bf + coalesce((l->>'breakfasts')::numeric, 0);
        v_ln := v_ln + coalesce((l->>'lunches')::numeric, 0);
        if v_rid is not null and coalesce((l->>'nights')::numeric, 0) > 0 then v_places := v_places + 1; end if;
        v_lines := v_lines || jsonb_build_array(l);
    end loop;

    -- снята пометка «платит сам» — его отдельные начисления отменяем, сумма вернулась в группу
    for c in select id from fin_charges
              where retreat_id = v_ret.id and creation_reason = c_self and not is_cancelled
                and not (participant_id = any(v_selves)) loop
        v_res := fin_cancel_charge(jsonb_build_object('charge_id', c.id, 'reason', 'Платит в составе группы'));
        if not coalesce((v_res->>'ok')::boolean, false) then
            raise exception '%', coalesce(v_res->'error'->>'code', 'internal_error')
                using detail = coalesce(v_res->'error'->>'message', 'Не удалось отменить начисление');
        end if;
    end loop;

    select count(distinct r.room_id) into v_rooms
      from jsonb_array_elements(v_lines) x join residents r on r.id = (x->>'resident_id')::uuid
     where coalesce((x->>'nights')::numeric, 0) > 0 and coalesce((x->>'included')::boolean, true)
       and not coalesce((x->>'self_pay')::boolean, false);

    v_changed := fin_private_group_sync(v_payer, v_ret, v_obj, v_legacy, c_mark, v_acc, v_meals, v_extra,
        format('Проживание группы %s: %s мест в %s номерах', v_period, v_places, v_rooms),
        format('Питание группы %s: завтраков %s, обедов %s', v_period, v_bf, v_ln),
        format('Дополнительно по группе %s', v_period));
    -- аванс события → общий платёж организатора (630)
    declare
        c_adv constant text := 'Аванс группы: перенесён на карточку организатора';
        a record; v_r jsonb;
        v_sup text := current_setting('tg.suppress_chat_notify', true);
    begin
        -- деньги не двигаются: сообщения держателю счёта не нужны (631)
        perform set_config('tg.suppress_chat_notify', '1', true);
        for a in
            select o.id, o.type, o.occurred_on, o.comment, p.account_id, p.amount, p.payment_channel
              from fin_operations o
              join fin_postings p on p.operation_id = o.id
             where p.object_id = v_obj and p.direction = 'in' and not o.is_reversed
               and ((o.type = 'income' and o.original_operation_id is null and p.participant_id is null
                     and p.category_id = '659c37b8-54dd-4bc1-a4be-ce2a771b6829')
                 or (o.type = 'payment' and o.reason = c_adv and p.participant_id <> v_payer))
               and (select count(*) from fin_postings x where x.operation_id = o.id) = 1
             order by o.occurred_on, o.created_at
        loop
            v_r := fin_create_reversal(jsonb_build_object(
                'request_id', md5(a.id::text || ':' || v_payer::text || ':adv-rev')::uuid,
                'original_operation_id', a.id,
                'occurred_on_policy', 'same_as_original',
                'reason', case when a.type = 'payment'
                               then 'Перераспределение платежа: аванс группы — другой организатор'
                               else c_adv end));
            if not coalesce((v_r->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_r->'error'->>'code', 'internal_error')
                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось сторнировать');
            end if;
            v_r := fin_create_payment(jsonb_build_object(
                'request_id', md5(a.id::text || ':' || v_payer::text || ':adv-pay')::uuid,
                'occurred_on', a.occurred_on,
                'payer_contact_id', v_payer,
                'comment', a.comment,
                'reason', c_adv,
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', md5(a.id::text || ':' || v_payer::text || ':adv-row')::uuid,
                    'account_id', a.account_id, 'amount', a.amount,
                    'participant_id', v_payer, 'object_id', v_obj,
                    'participant_balance_kind', 'general',
                    'payment_channel', a.payment_channel))));
            if not coalesce((v_r->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_r->'error'->>'code', 'internal_error')
                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось провести платёж');
            end if;
        end loop;
        perform set_config('tg.suppress_chat_notify', coalesce(v_sup, ''), true);
    end;

    if not v_legacy then
        select o_currency into v_cur from fin_private_settlement_currency(v_payer, v_ret.id);
    end if;
    v_rate := fin_private_retreat_rate(v_cur, v_obj, current_date);

    insert into fin_group_sheets (retreat_id, payer_id, lines, totals, prices, updated_at, updated_by)
    values (v_ret.id, v_payer, v_lines,
            jsonb_build_object('accommodation', v_acc, 'meals', v_meals, 'extra', v_extra,
                               'currency', v_cur, 'rate', v_rate),
            case when jsonb_typeof(payload->'prices') = 'object' then payload->'prices' end, now(), v_actor)
    on conflict (retreat_id) do update
       set payer_id = excluded.payer_id, lines = excluded.lines, totals = excluded.totals,
           prices = coalesce(excluded.prices, fin_group_sheets.prices),
           updated_at = now(), updated_by = excluded.updated_by;

    return jsonb_build_object('ok', true, 'result', jsonb_build_object(
        'payer_id', v_payer, 'currency', v_cur, 'rate', v_rate, 'changed', to_jsonb(v_changed),
        'self_pay', v_self_n,
        'totals_inr', jsonb_build_object('accommodation', v_acc, 'meals', v_meals, 'extra', v_extra)),
        'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;
