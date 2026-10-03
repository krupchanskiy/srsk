-- 628: фаза 2, шаг 7а — начисления участника ретрита из шахматки (ВГ, 27.09 и 03.10.2026).
--
-- 1. Даты — по ВСЕМ записям шахматки гостя на этом ретрите (раньше: своя дата сделки
--    главнее, из шахматки — только первая запись, вторая терялась). Даты сделки — только
--    пока гость не размещён.
-- 2. Проживание — сумма по всем записям с комнатой, у каждой своя цена номера; ночь
--    переезда не считается дважды (ночи = выезд − заезд каждой записи).
-- 3. Питание — из eating_detail (та же формула, что у кухни: даты питания, завтрак/обед,
--    «без питания», пропуски). День, где гость ест и завтрак, и обед, — по цене дня
--    ретрита, как раньше; оставшиеся одиночные приёмы — по ценам «Завтрак» / «Обед» за
--    один приём из прайса ретрита (новые услуги ниже). Обычный гость без пропусков: N ночей
--    = N завтраков + N обедов = N дней по цене дня — сумма та же, что раньше.
--    Завтрак относится к прошедшей ночи, обед — к следующей: так дни «во время / вне
--    ретрита» делятся так же, как ночи.
-- 4. fin_sync_charges_from_crm(…, p_mode): new_only/preview — карточка оплаты
--    показывает «было → стало» и меняет начисления только по кнопке (автопересчёт больше
--    не правит начисления молча; первое создание — как раньше, сразу).

-- ---------- услуги: завтрак и обед за один приём ----------
insert into crm_services (code, name_ru, name_en, name_hi, category, unit, is_active, sort_order)
select v.code, v.ru, v.en, v.hi, 'meals', 'piece', true, v.so
  from (values ('meal_breakfast', 'Завтрак — за один приём', 'Breakfast — per meal', 'नाश्ता — एक बार', 21),
               ('meal_lunch', 'Обед — за один приём', 'Lunch — per meal', 'दोपहर का भोजन — एक बार', 22)) v(code, ru, en, hi, so)
 where not exists (select 1 from crm_services s where s.code = v.code);

-- ---------- расчёт участия ----------
create or replace function public.crm_calc_participation(p_deal uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
    d record;
    r record;
    rec record;
    v_price record;
    v_terms jsonb := '{}'::jsonb;
    t record;
    дни_ретрита int;
    заезд date; выезд date;
    ночей_всего int; ночей_во_время int; ночей_между int;
    дни_питания int;
    возраст int;
    blocks jsonb := '{}'::jsonb;
    v_block text;
    cur text;
    curs constant text[] := array['INR', 'RUB', 'USD', 'EUR'];
    -- записи шахматки
    v_records int := 0;
    -- первая запись с комнатой — для подписи в карточке
    v_has_room boolean := false; v_b_name text; v_room_no text; v_room_cap int;
    v_rooms jsonb := '[]'::jsonb;
    acc_in numeric[] := array[0, 0, 0, 0];
    acc_out numeric[] := array[0, 0, 0, 0];
    acc_unit numeric[];
    acc_units int := 0;
    acc_n_in int := 0; acc_n_out int := 0;
    acc_priced int := 0;
    acc_note text := null;
    acc_mixed boolean := false;
    n_all int; n_in int;
    v_cap int;
    -- питание
    v_day record; v_bf record; v_ln record;
    v_eat_from date; v_eat_to date;
    e_rows int := 0; b_in int := 0; b_all int := 0; l_in int := 0; l_all int := 0;
    days_in int; days_out int; eb_in int; el_in int; eb_out int; el_out int;
    meal_note text := null;
    по_приёмам boolean := false;
begin
    if not is_staff(auth.uid()) then
        return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    select * into d from crm_deals where id = p_deal;
    if not found or d.retreat_id is null then
        return jsonb_build_object('ok', false, 'error', 'deal_not_found');
    end if;
    select * into r from retreats where id = d.retreat_id;
    дни_ретрита := greatest(r.end_date - r.start_date, 1);

    -- Все записи шахматки гостя на этом ретрите (с комнатой и «самостоятельно»)
    select count(*), min(x.check_in), max(coalesce(x.check_out, r.end_date)),
           min(least(x.check_in, coalesce(x.meal_start_date, x.check_in))),
           max(greatest(coalesce(x.check_out, r.end_date), coalesce(x.meal_end_date, x.check_out, r.end_date)))
      into v_records, заезд, выезд, v_eat_from, v_eat_to
      from residents x
     where x.vaishnava_id = d.vaishnava_id
       and x.status in ('active', 'confirmed', 'checked_out')
       and (x.retreat_id = d.retreat_id or x.booking_id = d.booking_id and d.booking_id is not null);

    -- Шахматка главнее; даты сделки — только пока гость не размещён (ВГ, 03.10)
    if v_records = 0 then
        заезд := coalesce(d.stay_check_in::date, r.start_date);
        выезд := coalesce(d.stay_check_out::date, r.end_date);
    end if;
    ночей_всего := greatest(выезд - заезд, 0);
    ночей_во_время := greatest(least(выезд, r.end_date) - greatest(заезд, r.start_date), 0);
    ночей_между := ночей_всего - ночей_во_время;
    дни_питания := ночей_всего;

    select extract(year from age(r.start_date, v.birth_date))::int into возраст
      from vaishnavas v where v.id = d.vaishnava_id and v.birth_date is not null;

    for t in select * from crm_deal_terms where deal_id = p_deal loop
        v_terms := v_terms || jsonb_build_object(t.block, to_jsonb(t));
    end loop;

    -- ---------- проживание: каждая запись с комнатой по своей цене ----------
    for rec in
        select rm.building_id, rm.capacity, rm.number as room_number, b.name_ru as building_name,
               x.check_in, coalesce(x.check_out, r.end_date) as check_out
          from residents x
          join rooms rm on rm.id = x.room_id
          left join buildings b on b.id = rm.building_id
         where x.vaishnava_id = d.vaishnava_id
           and x.status in ('active', 'confirmed', 'checked_out')
           and (x.retreat_id = d.retreat_id or x.booking_id = d.booking_id and d.booking_id is not null)
         order by x.check_in
    loop
        if not v_has_room then
            v_has_room := true; v_b_name := rec.building_name; v_room_no := rec.room_number; v_room_cap := rec.capacity;
        end if;
        n_all := greatest(rec.check_out - rec.check_in, 0);
        n_in := greatest(least(rec.check_out, r.end_date) - greatest(rec.check_in, r.start_date), 0);
        -- Приоритет: совпадение шаблона номера → совпадение вместимости
        select p.*, s.room_capacity as svc_capacity into v_price from crm_retreat_prices p
          join crm_services s on s.id = p.service_id
         where p.retreat_id = d.retreat_id and s.category = 'accommodation'
           and s.building_id = rec.building_id
           and (s.room_capacity <= rec.capacity or s.room_capacity is null)
           and (s.room_number_pattern is null or rec.room_number ilike s.room_number_pattern)
         order by (s.room_number_pattern is not null and rec.room_number ilike s.room_number_pattern) desc,
                  (s.room_capacity = rec.capacity) desc,
                  s.room_capacity desc nulls last
         limit 1;
        v_rooms := v_rooms || jsonb_build_object('building', rec.building_name, 'room', rec.room_number,
            'check_in', rec.check_in, 'check_out', rec.check_out, 'nights', n_all, 'priced', found);
        if found then
            acc_priced := acc_priced + 1;
            acc_units := acc_units + n_all;
            acc_n_in := acc_n_in + n_in;
            acc_n_out := acc_n_out + (n_all - n_in);
            for i in 1..4 loop
                acc_in[i] := acc_in[i] + round(case i when 1 then v_price.price when 2 then v_price.price_rub
                    when 3 then v_price.price_usd else v_price.price_eur end / дни_ретрита * n_in, 2);
                acc_out[i] := acc_out[i] + round(case i when 1 then v_price.price when 2 then v_price.price_rub
                    when 3 then v_price.price_usd else v_price.price_eur end / дни_ретрита * (n_all - n_in), 2);
            end loop;
            if acc_unit is null then
                acc_unit := array[round(v_price.price / дни_ретрита, 2), round(v_price.price_rub / дни_ретрита, 2),
                                  round(v_price.price_usd / дни_ретрита, 2), round(v_price.price_eur / дни_ретрита, 2)];
            elsif acc_unit[1] is distinct from round(v_price.price / дни_ретрита, 2) then
                acc_mixed := true;
            end if;
            -- Вместимость не совпала точно: номер с доп. кроватью, тариф ближайшего меньшего типа
            v_cap := v_price.svc_capacity;
            if v_cap is not null and v_cap <> rec.capacity then
                acc_note := concat_ws(' · ', acc_note,
                    format('тариф %s-местного — в номере доп. кровать (оплачивается отдельно)', v_cap));
            end if;
        else
            acc_note := concat_ws(' · ', acc_note,
                'нет цены для здания «' || coalesce(rec.building_name, '?') || '», ' || rec.capacity || '-местный');
        end if;
    end loop;
    if not v_has_room then
        acc_note := 'размещение ещё не назначено';
    end if;

    -- ---------- питание: из eating_detail ----------
    select p.* into v_day from crm_retreat_prices p join crm_services s on s.id = p.service_id
     where p.retreat_id = d.retreat_id and s.category = 'meals'
       and s.code not in ('meal_breakfast', 'meal_lunch')
     order by s.sort_order limit 1;
    select p.* into v_bf from crm_retreat_prices p join crm_services s on s.id = p.service_id
     where p.retreat_id = d.retreat_id and s.code = 'meal_breakfast' limit 1;
    select p.* into v_ln from crm_retreat_prices p join crm_services s on s.id = p.service_id
     where p.retreat_id = d.retreat_id and s.code = 'meal_lunch' limit 1;

    -- окно дней: записи шахматки и даты питания, но не уже дат ретрита (незаселённые
    -- участники в eating_detail — по регистрации в пределах ретрита)
    v_eat_from := least(coalesce(v_eat_from, заезд), заезд, r.start_date);
    v_eat_to := greatest(coalesce(v_eat_to, выезд), выезд, r.end_date);
    select count(*),
           count(*) filter (where e.breakfast and e.d > r.start_date and e.d <= r.end_date),
           count(*) filter (where e.breakfast),
           count(*) filter (where e.lunch and e.d >= r.start_date and e.d < r.end_date),
           count(*) filter (where e.lunch)
      into e_rows, b_in, b_all, l_in, l_all
      from eating_detail(v_eat_from, v_eat_to) e
     where e.vaishnava_id = d.vaishnava_id and e.retreat_id = d.retreat_id
       -- размещённый — только по шахматке (регистрация вне её дат не в счёт)
       and (v_records = 0 or e.kind = 'resident');

    if e_rows > 0 then
        по_приёмам := true;
        -- пары «завтрак + обед» — за всё пребывание (заезд после обеда и обед в день выезда —
        -- одна пара), потом делятся на «во время / вне ретрита»
        days_out := least(b_all - b_in, l_all - l_in);
        days_in := least(b_all, l_all) - days_out;
        eb_in := greatest(b_in - days_in, 0);  el_in := greatest(l_in - days_in, 0);
        eb_out := (b_all - days_in - days_out) - eb_in;  el_out := (l_all - days_in - days_out) - el_in;
    elsif v_records > 0 then
        -- размещён, но в шахматке без питания
        по_приёмам := true;
        days_in := 0; days_out := 0; eb_in := 0; el_in := 0; eb_out := 0; el_out := 0;
        meal_note := 'в шахматке без питания';
    else
        -- ни шахматки, ни регистрации с датами — по ночам, как раньше
        days_in := ночей_во_время; days_out := ночей_между;
        eb_in := 0; el_in := 0; eb_out := 0; el_out := 0;
    end if;
    дни_питания := days_in + days_out;
    if eb_in + eb_out > 0 and v_bf.id is null then
        meal_note := concat_ws(' · ', meal_note,
            format('нет цены «Завтрак — за один приём» в прайсе: %s завтр. не начислено', eb_in + eb_out));
    end if;
    if el_in + el_out > 0 and v_ln.id is null then
        meal_note := concat_ws(' · ', meal_note,
            format('нет цены «Обед — за один приём» в прайсе: %s обед. не начислено', el_in + el_out));
    end if;

    for v_block in select unnest(array['org_fee', 'accommodation', 'meals']) loop
        declare
            std jsonb := null;
            фин jsonb := null;
            за_единицу jsonb := null;
            единиц numeric := 1;
            term jsonb := v_terms -> v_block;
            детский_процент int := null;
            примечание text := null;
            во_время jsonb := null; между jsonb := null;
            сумма_в numeric; сумма_м numeric; день numeric; зв numeric; об numeric;
        begin
            if v_block = 'org_fee' then
                select p.* into v_price from crm_retreat_prices p
                  join crm_services s on s.id = p.service_id
                 where p.retreat_id = d.retreat_id and s.code = 'org_fee' limit 1;
                if found then
                    std := jsonb_build_object('INR', v_price.price, 'RUB', v_price.price_rub,
                                              'USD', v_price.price_usd, 'EUR', v_price.price_eur);
                end if;
                единиц := 1;
            elsif v_block = 'meals' then
                if v_day.id is not null then
                    единиц := дни_питания;
                    во_время := jsonb_build_object('days', days_in, 'breakfasts', eb_in, 'lunches', el_in);
                    между := jsonb_build_object('days', days_out, 'breakfasts', eb_out, 'lunches', el_out);
                    за_единицу := '{}'::jsonb; std := '{}'::jsonb;
                    foreach cur in array curs loop
                        день := case cur when 'INR' then v_day.price when 'RUB' then v_day.price_rub
                                         when 'USD' then v_day.price_usd else v_day.price_eur end;
                        зв := case when v_bf.id is null then 0 else case cur when 'INR' then v_bf.price when 'RUB' then v_bf.price_rub
                                         when 'USD' then v_bf.price_usd else v_bf.price_eur end end;
                        об := case when v_ln.id is null then 0 else case cur when 'INR' then v_ln.price when 'RUB' then v_ln.price_rub
                                         when 'USD' then v_ln.price_usd else v_ln.price_eur end end;
                        сумма_в := round(день / дни_ретрита * days_in, 2)
                                 + case when eb_in > 0 then зв * eb_in else 0 end
                                 + case when el_in > 0 then об * el_in else 0 end;
                        сумма_м := round(день / дни_ретрита * days_out, 2)
                                 + case when eb_out > 0 then зв * eb_out else 0 end
                                 + case when el_out > 0 then об * el_out else 0 end;
                        во_время := во_время || jsonb_build_object(cur, сумма_в);
                        между := между || jsonb_build_object(cur, сумма_м);
                        за_единицу := за_единицу || jsonb_build_object(cur, round(день / дни_ретрита, 2));
                        std := std || jsonb_build_object(cur, сумма_в + сумма_м);
                    end loop;
                end if;
                примечание := meal_note;
            else
                if acc_priced > 0 then
                    единиц := acc_units;
                    во_время := jsonb_build_object('nights', acc_n_in);
                    между := jsonb_build_object('nights', acc_n_out);
                    std := '{}'::jsonb;
                    for i in 1..4 loop
                        во_время := во_время || jsonb_build_object(curs[i], acc_in[i]);
                        между := между || jsonb_build_object(curs[i], acc_out[i]);
                        std := std || jsonb_build_object(curs[i], acc_in[i] + acc_out[i]);
                    end loop;
                    -- цена за ночь одна на все записи — показываем; разные номера — нет
                    if not acc_mixed then
                        за_единицу := jsonb_build_object('INR', acc_unit[1], 'RUB', acc_unit[2],
                                                         'USD', acc_unit[3], 'EUR', acc_unit[4]);
                    end if;
                end if;
                примечание := acc_note;
            end if;

            if возраст is not null then
                детский_процент := case
                    when v_block = 'org_fee' then case when возраст < 7 then 100 when возраст < 14 then 50 else 0 end
                    when v_block = 'meals'   then case when возраст < 7 then 100 else 0 end
                    else null end;
            end if;

            -- Дни вне ретрита по своей цене (ТЗ 1.3 п.5): скидка только к «внешней» части
            if term is not null and (term->>'between_percent') is not null
               and между is not null and (между->>'INR')::numeric > 0 and std is not null then
                declare k numeric := 1 - (term->>'between_percent')::numeric / 100;
                begin
                    std := jsonb_build_object(
                        'INR', round((во_время->>'INR')::numeric + (между->>'INR')::numeric * k, 2),
                        'RUB', round((во_время->>'RUB')::numeric + (между->>'RUB')::numeric * k, 2),
                        'USD', round((во_время->>'USD')::numeric + (между->>'USD')::numeric * k, 2),
                        'EUR', round((во_время->>'EUR')::numeric + (между->>'EUR')::numeric * k, 2));
                    между := между || jsonb_build_object('discount_percent', (term->>'between_percent')::numeric);
                end;
            end if;

            if term is not null then
                case term->>'condition_type'
                    when 'free'     then фин := jsonb_build_object('INR', 0, 'RUB', 0, 'USD', 0, 'EUR', 0);
                    when 'donation' then фин := jsonb_build_object('INR', 0, 'RUB', 0, 'USD', 0, 'EUR', 0);
                    when 'self'     then фин := jsonb_build_object('INR', 0, 'RUB', 0, 'USD', 0, 'EUR', 0);
                    when 'tickets'  then фин := jsonb_build_object('INR', 0, 'RUB', 0, 'USD', 0, 'EUR', 0);
                    when 'fixed'    then фин := jsonb_build_object(coalesce(term->>'currency', 'INR'), (term->>'amount')::numeric);
                    when 'discount' then
                        if std is not null then
                            фин := jsonb_build_object(
                                'INR', round((std->>'INR')::numeric * (1 - coalesce((term->>'percent')::numeric, 0) / 100), 2),
                                'RUB', round((std->>'RUB')::numeric * (1 - coalesce((term->>'percent')::numeric, 0) / 100), 2),
                                'USD', round((std->>'USD')::numeric * (1 - coalesce((term->>'percent')::numeric, 0) / 100), 2),
                                'EUR', round((std->>'EUR')::numeric * (1 - coalesce((term->>'percent')::numeric, 0) / 100), 2));
                        end if;
                    when 'child' then
                        if std is not null then
                            фин := jsonb_build_object(
                                'INR', round((std->>'INR')::numeric * (1 - coalesce((term->>'percent')::numeric, детский_процент, 0) / 100), 2),
                                'RUB', round((std->>'RUB')::numeric * (1 - coalesce((term->>'percent')::numeric, детский_процент, 0) / 100), 2),
                                'USD', round((std->>'USD')::numeric * (1 - coalesce((term->>'percent')::numeric, детский_процент, 0) / 100), 2),
                                'EUR', round((std->>'EUR')::numeric * (1 - coalesce((term->>'percent')::numeric, детский_процент, 0) / 100), 2));
                        end if;
                    else фин := std;
                end case;
            else
                фин := std;
            end if;

            blocks := blocks || jsonb_build_object(v_block, jsonb_strip_nulls(jsonb_build_object(
                'standard', std,
                'final', фин,
                'per_unit', за_единицу,
                'units', единиц,
                'during', во_время,
                'between', между,
                'breakfast_price', case when v_block = 'meals' and v_bf.id is not null then jsonb_build_object(
                    'INR', v_bf.price, 'RUB', v_bf.price_rub, 'USD', v_bf.price_usd, 'EUR', v_bf.price_eur) end,
                'lunch_price', case when v_block = 'meals' and v_ln.id is not null then jsonb_build_object(
                    'INR', v_ln.price, 'RUB', v_ln.price_rub, 'USD', v_ln.price_usd, 'EUR', v_ln.price_eur) end,
                'by_meals', case when v_block = 'meals' then по_приёмам end,
                'term', case when term is null then null else jsonb_build_object(
                    'type', term->>'condition_type', 'percent', term->>'percent',
                    'amount', term->>'amount', 'currency', term->>'currency',
                    'reason', term->>'reason', 'manager_id', term->>'manager_id',
                    'between_percent', term->>'between_percent') end,
                'child_suggest_percent', детский_процент,
                'note', примечание)));
        end;
    end loop;

    return jsonb_build_object(
        'ok', true,
        'deal_id', d.id,
        'participant_id', d.vaishnava_id,
        'retreat_id', d.retreat_id,
        'dates', jsonb_build_object(
            'check_in', заезд, 'check_out', выезд,
            'source', case when v_records > 0 then 'timeline' when d.stay_check_in is not null or d.stay_check_out is not null then 'deal' else 'retreat' end,
            'retreat_start', r.start_date, 'retreat_end', r.end_date,
            'nights_total', ночей_всего, 'nights_during', ночей_во_время,
            'nights_between', ночей_между, 'meal_days', дни_питания,
            'building', v_b_name, 'room', v_room_no, 'capacity', v_room_cap,
            'rooms', v_rooms),
        'blocks', blocks);
end;
$function$;

-- ---------- синхронизация начислений: предпросмотр и подтверждение ----------
-- p_mode: 'apply' — как раньше, всё сразу (кнопка «Применить», смена валюты расчёта);
-- 'new_only' — недостающие блоки создаются, а изменения уже начисленного только
-- возвращаются в changes (открытие карточки, добавление человека в платёж);
-- 'preview' — ничего не пишет. Автопересчёт больше не меняет начисления молча (ВГ, 27.09).
drop function if exists public.fin_sync_charges_from_crm(uuid, uuid);
create or replace function public.fin_sync_charges_from_crm(p_participant uuid, p_retreat uuid, p_mode text default 'apply')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
v_actor uuid;
v_deal uuid;
v_obj uuid;
calc jsonb;
v_block text;
b jsonb;
v_cur text;
v_sym text;
v_gross numeric;
v_net numeric;
v_discount numeric;
v_qty numeric;
v_unit numeric;
v_desc text;
v_fix_cur text;
v_rate numeric;
v_extra text;
существующее record;
создано int := 0; обновлено int := 0; пропущено int := 0;
v_changes jsonb := '[]'::jsonb;
begin
if p_mode not in ('apply', 'new_only', 'preview') then
return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload', 'message', 'p_mode: apply | new_only | preview'));
end if;
v_actor := fin_actor();
if not fin_is_admin(v_actor) then
return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden',
'message', 'Синхронизация начислений доступна администратору финансов'));
end if;
if exists (select 1 from fin_accounting_objects
where retreat_id = p_retreat and legacy_inr_settlement) then
return jsonb_build_object('ok', true, 'result', jsonb_build_object(
'frozen', true, 'created', 0, 'updated', 0, 'kept_manual', 0), 'changes', '[]'::jsonb, 'warnings', '[]'::jsonb);
end if;
select id into v_deal from crm_deals
where vaishnava_id = p_participant and retreat_id = p_retreat and status <> 'cancelled'
order by updated_at desc nulls last limit 1;
if v_deal is null then
return jsonb_build_object('ok', true, 'result', jsonb_build_object(
'no_deal', true, 'created', 0, 'updated', 0), 'changes', '[]'::jsonb, 'warnings', '[]'::jsonb);
end if;
calc := crm_calc_participation(v_deal);
if not (calc->>'ok')::boolean then
return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'calc_failed', 'message', calc->>'error'));
end if;
select o_currency into v_cur from fin_private_settlement_currency(p_participant, p_retreat);
v_sym := case v_cur when 'INR' then '₹' when 'RUB' then '₽' when 'USD' then '$' when 'EUR' then '€' end;
select id into v_obj from fin_accounting_objects where retreat_id = p_retreat;
for v_block in select unnest(array['org_fee', 'accommodation', 'meals']) loop
b := calc->'blocks'->v_block;
v_gross := (b->'standard'->>v_cur)::numeric;
v_net := (b->'final'->>v_cur)::numeric;
v_rate := null;
if b->'term'->>'type' = 'fixed' then
v_fix_cur := coalesce(b->'term'->>'currency', 'INR');
if v_fix_cur = v_cur then
v_net := (b->'term'->>'amount')::numeric;
else
begin
v_rate := fin_private_retreat_rate(v_fix_cur, v_obj, current_date)
/ fin_private_retreat_rate(v_cur, v_obj, current_date);
exception when others then
v_rate := null;
end;
if v_rate is null then
пропущено := пропущено + 1;
continue;
end if;
v_net := round((b->'term'->>'amount')::numeric * v_rate, 2);
end if;
end if;
if v_net is null then continue; end if;
if v_gross is null or v_gross < v_net then v_gross := v_net; end if;
v_discount := round(v_gross - v_net, 2);
v_qty := greatest(coalesce((b->>'units')::numeric, 1), 1);
v_unit := round(v_gross / v_qty, 2);
-- разовые приёмы питания (628): «+ 1 обед × 450 ₹»
v_extra := '';
if v_block = 'meals' then
if coalesce((b->'during'->>'breakfasts')::int, 0) + coalesce((b->'between'->>'breakfasts')::int, 0) > 0
and b->'breakfast_price'->>v_cur is not null then
v_extra := v_extra || format(' + %s завтр. × %s %s',
coalesce((b->'during'->>'breakfasts')::int, 0) + coalesce((b->'between'->>'breakfasts')::int, 0),
b->'breakfast_price'->>v_cur, v_sym);
end if;
if coalesce((b->'during'->>'lunches')::int, 0) + coalesce((b->'between'->>'lunches')::int, 0) > 0
and b->'lunch_price'->>v_cur is not null then
v_extra := v_extra || format(' + %s обед. × %s %s',
coalesce((b->'during'->>'lunches')::int, 0) + coalesce((b->'between'->>'lunches')::int, 0),
b->'lunch_price'->>v_cur, v_sym);
end if;
end if;
v_desc := case v_block
when 'org_fee' then 'Оргвзнос'
when 'meals' then
case when b->'term'->>'type' = 'self' then 'Не кушает'
when b->'term'->>'type' = 'tickets' then 'Питание по талончикам'
else format('Питание %s — %s: %s дн. × %s %s',
to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'),
b->'during'->>'days', b->'per_unit'->>v_cur, v_sym)
|| case when coalesce((b->'between'->>'days')::int, 0) > 0
then format(' + %s дн. вне ретрита%s', b->'between'->>'days',
case when b->'between'->>'discount_percent' is not null then format(' (−%s%%)', b->'between'->>'discount_percent') else '' end)
else '' end
|| v_extra
|| coalesce(' · ' || (b->>'note'), '')
end
else
case when b->'term'->>'type' = 'self' then 'Самостоятельное размещение'
-- несколько записей шахматки (переезд) — каждая своей строкой в описании
when jsonb_array_length(coalesce(calc->'dates'->'rooms', '[]'::jsonb)) > 1 then
'Проживание ' || (select string_agg(format('%s%s %s — %s',
coalesce(x->>'building', '—'), case when x->>'room' is not null then ' №' || (x->>'room') else '' end,
to_char((x->>'check_in')::date, 'DD.MM'), to_char((x->>'check_out')::date, 'DD.MM')), ', ')
from jsonb_array_elements(calc->'dates'->'rooms') x)
|| format(': %s ноч.', b->>'units')
|| case when coalesce((b->'between'->>'nights')::int, 0) > 0
then format(', из них %s вне ретрита%s', b->'between'->>'nights',
case when b->'between'->>'discount_percent' is not null then format(' (−%s%%)', b->'between'->>'discount_percent') else '' end)
else '' end
|| coalesce(' · ' || (b->>'note'), '')
else format('Проживание %s%s, %s — %s: %s ноч. × %s %s',
coalesce(calc->'dates'->>'building', '—'),
case when calc->'dates'->>'room' is not null then ' №' || (calc->'dates'->>'room') else '' end,
to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'),
b->'during'->>'nights', b->'per_unit'->>v_cur, v_sym)
|| case when coalesce((b->'between'->>'nights')::int, 0) > 0
then format(' + %s ноч. вне ретрита%s', b->'between'->>'nights',
case when b->'between'->>'discount_percent' is not null then format(' (−%s%%)', b->'between'->>'discount_percent') else '' end)
else '' end
|| coalesce(' · ' || (b->>'note'), '')
end
end || case when b->'term' is not null
then format(' · инд. условия: %s', coalesce(b->'term'->>'reason', b->'term'->>'type'))
|| case when v_rate is not null
then format(' (%s %s по курсу ретрита)', b->'term'->>'amount', b->'term'->>'currency') else '' end
else '' end;
select * into существующее from fin_charges
where participant_id = p_participant and retreat_id = p_retreat
and kind = v_block::fin_charge_kind
order by created_at desc limit 1;
if found then
if существующее.is_cancelled then
пропущено := пропущено + 1;
continue;
end if;
if существующее.creation_reason is distinct from 'crm_auto' then
пропущено := пропущено + 1;
continue;
end if;
if существующее.currency_code = v_cur and существующее.amount = v_gross
and существующее.discount_amount = v_discount then
continue;
end if;
v_changes := v_changes || jsonb_build_object('kind', v_block, 'action', 'update',
'old_net', существующее.amount - существующее.discount_amount, 'old_currency', существующее.currency_code,
'old_description', существующее.description,
'new_net', v_net, 'currency', v_cur, 'new_description', v_desc);
обновлено := обновлено + 1;
if p_mode <> 'apply' then continue; end if;
update fin_charges
set is_cancelled = true, cancelled_at = now(), cancelled_by = v_actor,
cancelled_reason = format('Автопересчёт из CRM: было %s − %s %s, стало %s − %s %s',
существующее.amount, существующее.discount_amount, существующее.currency_code,
v_gross, v_discount, v_cur)
where id = существующее.id;
else
v_changes := v_changes || jsonb_build_object('kind', v_block, 'action', 'create',
'new_net', v_net, 'currency', v_cur, 'new_description', v_desc);
создано := создано + 1;
if p_mode = 'preview' then continue; end if;
end if;
insert into fin_charges (id, request_hash, participant_id, retreat_id, kind, description,
quantity, unit_price, amount, discount_amount, currency_code,
discount_reason, creation_reason, created_by, agreed_with)
values (gen_random_uuid(), md5(v_deal::text || v_block || v_cur || v_gross::text || v_discount::text || clock_timestamp()::text),
p_participant, p_retreat, v_block::fin_charge_kind, v_desc,
v_qty, v_unit, v_gross, v_discount, v_cur,
case when v_discount > 0 then coalesce(b->'term'->>'reason', b->'term'->>'type', 'условия CRM') end,
'crm_auto', v_actor,
(select coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''))
from vaishnavas v where v.id = nullif(b->'term'->>'manager_id', '')::uuid));
end loop;
return jsonb_build_object('ok', true,
'result', jsonb_build_object('created', создано, 'updated', обновлено, 'kept_manual', пропущено, 'currency', v_cur,
'mode', p_mode),
'changes', v_changes,
'calc', calc, 'warnings', '[]'::jsonb);
end;
$function$;
revoke all on function public.fin_sync_charges_from_crm(uuid, uuid, text) from public, anon;
grant execute on function public.fin_sync_charges_from_crm(uuid, uuid, text) to authenticated, service_role;
