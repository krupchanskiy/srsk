-- 392: расчёт стоимости участия (ТЗ 4.1а) и автоначисления в финмодуле (п. 3.1)
--
-- crm_calc_participation(deal): единая точка расчёта — базовые цены ретрита
-- (по фактическому зданию/вместимости номера) × фактические дни (во время /
-- между ретритами раздельно), поверх — индивидуальные условия и детская
-- формула. Все четыре валюты считаются параллельно и независимо, как заданы
-- в прайсе (не по курсу).
--
-- fin_sync_charges_from_crm(participant, retreat): материализует расчёт в
-- fin_charges. Автоначисления помечены creation_reason='crm_auto'; ручные
-- начисления и ручные правки не перезаписываются. Изменение суммы — отмена
-- старой строки с причиной и новая строка: «было → стало» видно в истории.

create or replace function public.crm_calc_participation(p_deal uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    d record;
    r record;
    res record;
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

    -- Фактическое размещение: приоритет living-записи этого ретрита
    select rm.building_id, rm.capacity, res_in.check_in, res_in.check_out, b.name_ru as building_name
      into res
      from residents res_in
      join rooms rm on rm.id = res_in.room_id
      left join buildings b on b.id = rm.building_id
     where res_in.vaishnava_id = d.vaishnava_id
       and res_in.status in ('active', 'confirmed')
       and (res_in.retreat_id = d.retreat_id
            or res_in.booking_id = d.booking_id and d.booking_id is not null)
     order by (res_in.retreat_id = d.retreat_id) desc, res_in.check_in
     limit 1;

    -- Даты пребывания: свои даты из чек-листа → размещение → рамки ретрита (ТЗ 4.3)
    заезд := coalesce(d.stay_check_in::date, res.check_in, r.start_date);
    выезд := coalesce(d.stay_check_out::date, res.check_out, r.end_date);
    ночей_всего := greatest(выезд - заезд, 0);
    ночей_во_время := greatest(least(выезд, r.end_date) - greatest(заезд, r.start_date), 0);
    ночей_между := ночей_всего - ночей_во_время;
    дни_питания := ночей_всего;   -- редактируется вручную в финмодуле (ТЗ 3.4)

    -- Возраст на первый день ретрита — для детской формулы (Приложение Б)
    select extract(year from age(r.start_date, v.birth_date))::int into возраст
      from vaishnavas v where v.id = d.vaishnava_id and v.birth_date is not null;

    -- Индивидуальные условия
    for t in select * from crm_deal_terms where deal_id = p_deal loop
        v_terms := v_terms || jsonb_build_object(t.block, to_jsonb(t));
    end loop;

    -- ===== По блокам =====
    for v_block in select unnest(array['org_fee', 'accommodation', 'meals']) loop
        declare
            std jsonb := null;        -- стандартная цена, 4 валюты
            фин jsonb := null;        -- итог после условий
            за_единицу jsonb := null;
            единиц numeric := 1;
            term jsonb := v_terms -> v_block;
            детский_процент int := null;
            примечание text := null;
            во_время jsonb := null; между jsonb := null;
        begin
            -- Стандартная цена из прайса
            if v_block = 'org_fee' then
                select p.* into v_price from crm_retreat_prices p
                  join crm_services s on s.id = p.service_id
                 where p.retreat_id = d.retreat_id and s.code = 'org_fee' limit 1;
                if found then
                    std := jsonb_build_object('INR', v_price.price, 'RUB', v_price.price_rub,
                                              'USD', v_price.price_usd, 'EUR', v_price.price_eur);
                end if;
                единиц := 1;   -- оргвзнос фиксирован датами ретрита (ТЗ 3.4)
            elsif v_block = 'meals' then
                select p.* into v_price from crm_retreat_prices p
                  join crm_services s on s.id = p.service_id
                 where p.retreat_id = d.retreat_id and s.category = 'meals' limit 1;
                if found then
                    единиц := дни_питания;
                    -- Цена в прайсе за весь ретрит → за день, дальше × фактические дни
                    за_единицу := jsonb_build_object(
                        'INR', round(v_price.price / дни_ретрита, 2), 'RUB', round(v_price.price_rub / дни_ретрита, 2),
                        'USD', round(v_price.price_usd / дни_ретрита, 2), 'EUR', round(v_price.price_eur / дни_ретрита, 2));
                    std := jsonb_build_object(
                        'INR', round(v_price.price / дни_ретрита * единиц, 2), 'RUB', round(v_price.price_rub / дни_ретрита * единиц, 2),
                        'USD', round(v_price.price_usd / дни_ретрита * единиц, 2), 'EUR', round(v_price.price_eur / дни_ретрита * единиц, 2));
                end if;
            else  -- accommodation: цена по фактическому зданию и вместимости (ТЗ 3.5)
                if res.building_id is not null then
                    select p.* into v_price from crm_retreat_prices p
                      join crm_services s on s.id = p.service_id
                     where p.retreat_id = d.retreat_id and s.category = 'accommodation'
                       and s.building_id = res.building_id
                       and (s.room_capacity = res.capacity or s.room_capacity is null)
                     order by (s.room_capacity = res.capacity) desc limit 1;
                    if found then
                        единиц := ночей_всего;
                        за_единицу := jsonb_build_object(
                            'INR', round(v_price.price / дни_ретрита, 2), 'RUB', round(v_price.price_rub / дни_ретрита, 2),
                            'USD', round(v_price.price_usd / дни_ретрита, 2), 'EUR', round(v_price.price_eur / дни_ретрита, 2));
                        -- Раздельно: во время ретрита и между (ТЗ 4.1а)
                        во_время := jsonb_build_object(
                            'nights', ночей_во_время,
                            'INR', round(v_price.price / дни_ретрита * ночей_во_время, 2),
                            'RUB', round(v_price.price_rub / дни_ретрита * ночей_во_время, 2),
                            'USD', round(v_price.price_usd / дни_ретрита * ночей_во_время, 2),
                            'EUR', round(v_price.price_eur / дни_ретрита * ночей_во_время, 2));
                        между := jsonb_build_object(
                            'nights', ночей_между,
                            'INR', round(v_price.price / дни_ретрита * ночей_между, 2),
                            'RUB', round(v_price.price_rub / дни_ретрита * ночей_между, 2),
                            'USD', round(v_price.price_usd / дни_ретрита * ночей_между, 2),
                            'EUR', round(v_price.price_eur / дни_ретрита * ночей_между, 2));
                        std := jsonb_build_object(
                            'INR', round(v_price.price / дни_ретрита * единиц, 2), 'RUB', round(v_price.price_rub / дни_ретрита * единиц, 2),
                            'USD', round(v_price.price_usd / дни_ретрита * единиц, 2), 'EUR', round(v_price.price_eur / дни_ретрита * единиц, 2));
                    else
                        примечание := 'нет цены для здания «' || coalesce(res.building_name, '?') || '», ' || res.capacity || '-местный';
                    end if;
                else
                    примечание := 'размещение ещё не назначено';
                end if;
            end if;

            -- Детская подсказка (Приложение Б) — применяется автоматически,
            -- только если условие «Ребёнок» выбрано в терминах
            if возраст is not null then
                детский_процент := case
                    when v_block = 'org_fee' then case when возраст < 7 then 100 when возраст < 14 then 50 else 0 end
                    when v_block = 'meals'   then case when возраст < 7 then 100 else 0 end
                    else null end;
            end if;

            -- Итог с условиями (ТЗ 4.2: приоритет над стандартной ценой)
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
                'term', case when term is null then null else jsonb_build_object(
                    'type', term->>'condition_type', 'percent', term->>'percent',
                    'amount', term->>'amount', 'currency', term->>'currency',
                    'reason', term->>'reason', 'manager_id', term->>'manager_id') end,
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
            'retreat_start', r.start_date, 'retreat_end', r.end_date,
            'nights_total', ночей_всего, 'nights_during', ночей_во_время,
            'nights_between', ночей_между, 'meal_days', дни_питания,
            'building', res.building_name, 'capacity', res.capacity),
        'blocks', blocks);
end;
$$;

revoke execute on function public.crm_calc_participation(uuid) from public, anon;
grant execute on function public.crm_calc_participation(uuid) to authenticated, service_role;

-- Материализация расчёта в начисления финмодуля (ТЗ 3.1, сценарий 1)
create or replace function public.fin_sync_charges_from_crm(p_participant uuid, p_retreat uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_actor uuid;
    v_deal uuid;
    calc jsonb;
    v_block text;
    b jsonb;
    v_amount numeric;
    v_currency text;
    v_qty numeric;
    v_unit numeric;
    v_desc text;
    v_std numeric;
    существующее record;
    создано int := 0; обновлено int := 0; пропущено int := 0;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'forbidden',
            'message', 'Синхронизация начислений доступна администратору финансов'));
    end if;

    select id into v_deal from crm_deals
     where vaishnava_id = p_participant and retreat_id = p_retreat and status <> 'cancelled'
     order by updated_at desc nulls last limit 1;
    if v_deal is null then
        return jsonb_build_object('ok', true, 'result', jsonb_build_object(
            'no_deal', true, 'created', 0, 'updated', 0), 'warnings', '[]'::jsonb);
    end if;

    calc := crm_calc_participation(v_deal);
    if not (calc->>'ok')::boolean then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'calc_failed', 'message', calc->>'error'));
    end if;

    for v_block in select unnest(array['org_fee', 'accommodation', 'meals']) loop
        b := calc->'blocks'->v_block;
        -- Валюта начисления: INR по умолчанию; фикс-условие задаёт свою (ТЗ 3.1)
        if b->'term'->>'type' = 'fixed' then
            v_currency := coalesce(b->'term'->>'currency', 'INR');
        else
            v_currency := 'INR';
        end if;
        v_amount := (b->'final'->>v_currency)::numeric;
        if v_amount is null then continue; end if;   -- нет цены — нечего начислять

        v_std := coalesce((b->'standard'->>v_currency)::numeric, v_amount);
        v_qty := coalesce((b->>'units')::numeric, 1);
        v_unit := case when v_qty > 0 then round(v_std / v_qty, 2) else v_std end;
        v_desc := case v_block
            when 'org_fee' then 'Оргвзнос'
            when 'meals' then format('Питание, %s дн. (%s — %s)', calc->'dates'->>'meal_days',
                                     to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'))
            else format('Проживание, %s ноч. (%s — %s%s)', calc->'dates'->>'nights_total',
                        to_char((calc->'dates'->>'check_in')::date, 'DD.MM'), to_char((calc->'dates'->>'check_out')::date, 'DD.MM'),
                        case when (calc->'dates'->>'nights_between')::int > 0
                             then format(', из них %s вне ретрита', calc->'dates'->>'nights_between') else '' end)
        end || case when b->'term' is not null
                    then format(' · инд. условия: %s', coalesce(b->'term'->>'reason', b->'term'->>'type')) else '' end;

        -- Ручное начисление того же блока не трогаем (ТЗ 3.1: правки поверх)
        select * into существующее from fin_charges
         where participant_id = p_participant and retreat_id = p_retreat
           and kind = v_block::fin_charge_kind and not is_cancelled
         order by created_at desc limit 1;

        if found then
            if существующее.creation_reason is distinct from 'crm_auto' then
                пропущено := пропущено + 1;   -- админ вводил руками — его слово главнее
                continue;
            end if;
            if существующее.amount = v_amount and существующее.currency_code = v_currency then
                continue;   -- ничего не изменилось
            end if;
            -- Автопересчёт: отмена старой строки + новая = видимый лог «было → стало»
            update fin_charges
               set is_cancelled = true, cancelled_at = now(), cancelled_by = v_actor,
                   cancelled_reason = format('Автопересчёт из CRM: было %s %s, стало %s %s',
                                             существующее.amount, существующее.currency_code, v_amount, v_currency)
             where id = существующее.id;
            обновлено := обновлено + 1;
        else
            создано := создано + 1;
        end if;

        insert into fin_charges (id, request_hash, participant_id, retreat_id, kind, description,
                                 quantity, unit_price, amount, discount_amount, currency_code,
                                 discount_reason, creation_reason, created_by, agreed_with)
        values (gen_random_uuid(), md5(v_deal::text || v_block || v_amount::text || clock_timestamp()::text),
                p_participant, p_retreat, v_block::fin_charge_kind, v_desc,
                v_qty, v_unit, v_amount, greatest(round(v_std - v_amount, 2), 0), v_currency,
                b->'term'->>'reason', 'crm_auto', v_actor,
                nullif(b->'term'->>'manager_id', '')::uuid);
    end loop;

    return jsonb_build_object('ok', true,
        'result', jsonb_build_object('created', создано, 'updated', обновлено, 'kept_manual', пропущено),
        'calc', calc, 'warnings', '[]'::jsonb);
end;
$$;

revoke execute on function public.fin_sync_charges_from_crm(uuid, uuid) from public, anon;
grant execute on function public.fin_sync_charges_from_crm(uuid, uuid) to authenticated, service_role;
