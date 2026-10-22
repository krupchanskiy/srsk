-- 731: доплата за поздний выезд и «Персональная договорённость» в окнах оплаты (ВГ 08–22.10.2026,
-- «Шахматка 13»). Шкала: выезд до 14:00 — без доплаты, 14:00–19:00 — ½ суток, после 19:00 — сутки;
-- цена суток = доля ночи человека. Доплата считается всегда, ВГ на месте снимает или меняет —
-- это договорённость. Ручное отличие от расчёта (доплата, делитель, цена номера) хранится по месту
-- (кто, когда, расчётное значение, своё, комментарий) и переживает «Пересчитать» и новые окна.

CREATE TABLE IF NOT EXISTS fin_stay_agreements (
    resident_id uuid NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
    field text NOT NULL CHECK (field IN ('late_fee', 'people', 'room_price')),
    calc_value numeric,
    value numeric NOT NULL CHECK (value >= 0),
    comment text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (resident_id, field)
);
COMMENT ON TABLE fin_stay_agreements IS 'Персональные договорённости в окнах оплаты (731): своё значение вместо расчётного, по месту шахматки';
-- как fin_no_charge_visits: RLS без политик — только через функции fin_*
ALTER TABLE fin_stay_agreements ENABLE ROW LEVEL SECURITY;

-- Договорённости мест: {resident_id: {field: {calc, value, comment, by, at}}}
CREATE OR REPLACE FUNCTION public.fin_stay_agreements_get(p_ids uuid[])
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    return coalesce((
        select jsonb_object_agg(rid, fields) from (
            select a.resident_id rid, jsonb_object_agg(a.field, jsonb_build_object(
                'calc', a.calc_value, 'value', a.value, 'comment', a.comment, 'at', a.created_at,
                'by', coalesce(nullif(btrim(v.spiritual_name), ''), nullif(btrim(concat_ws(' ', v.first_name, v.last_name)), ''), '—'))) fields
              from fin_stay_agreements a
              left join vaishnavas v on v.user_id = a.created_by
             where a.resident_id = any(p_ids)
             group by a.resident_id) z), '{}'::jsonb);
end;
$function$;

-- Поставить (value) или снять (value = null) договорённость
CREATE OR REPLACE FUNCTION public.fin_stay_agreement_set(payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
    v_actor uuid; v_detail text; v_rid uuid; v_field text;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Договорённость ставит администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'field', 'calc_value', 'value', 'comment']);
    v_rid := fin_private_get_uuid(payload, 'resident_id', true);
    if not exists (select 1 from residents where id = v_rid) then
        raise exception 'invalid_payload' using detail = 'Место в шахматке не найдено';
    end if;
    v_field := payload->>'field';
    if v_field is null or v_field not in ('late_fee', 'people', 'room_price') then
        raise exception 'invalid_payload' using detail = 'Неизвестное поле договорённости';
    end if;
    if payload->'value' is null or jsonb_typeof(payload->'value') = 'null' then
        delete from fin_stay_agreements where resident_id = v_rid and field = v_field;
    else
        if (payload->>'value')::numeric < 0 or (v_field = 'people' and (payload->>'value')::numeric < 1) then
            raise exception 'invalid_payload' using detail = 'Недопустимое значение';
        end if;
        insert into fin_stay_agreements (resident_id, field, calc_value, value, comment, created_by)
        values (v_rid, v_field, nullif(payload->>'calc_value', '')::numeric, (payload->>'value')::numeric,
                nullif(btrim(coalesce(payload->>'comment', '')), ''), v_actor)
        on conflict (resident_id, field) do update
           set calc_value = excluded.calc_value, value = excluded.value, comment = excluded.comment,
               created_by = excluded.created_by, created_at = now();
    end if;
    return jsonb_build_object('ok', true, 'result', fin_stay_agreements_get(array[v_rid]), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

-- Время выезда из окна оплаты → место в шахматке (то же поле, что «Уезжает в ~»; кухня считает по нему)
CREATE OR REPLACE FUNCTION public.fin_set_departure_time(payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
    v_actor uuid; v_detail text; v_rid uuid;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Меняет администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'departure_time']);
    v_rid := fin_private_get_uuid(payload, 'resident_id', true);
    update residents set departure_time = nullif(payload->>'departure_time', '')::time where id = v_rid;
    if not found then raise exception 'invalid_payload' using detail = 'Место в шахматке не найдено'; end if;
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('departure_time', payload->>'departure_time'), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;

REVOKE ALL ON FUNCTION public.fin_stay_agreements_get(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_stay_agreement_set(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_set_departure_time(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_stay_agreements_get(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_stay_agreement_set(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_set_departure_time(jsonb) TO authenticated, service_role;

-- Окно группы: доплата за поздний выезд (late_fee, ₹ за место) — в проживание; время выезда → шахматка
do $mig$
declare
    src text := pg_get_functiondef('public.fin_group_save(jsonb)'::regprocedure);
    k_old text := '''extra_bed'', ''extra_bed_price'', ''depart_on'', ''self_pay'', ''skips'', ''night_price'']);';
    k_new text := '''extra_bed'', ''extra_bed_price'', ''depart_on'', ''self_pay'', ''skips'', ''night_price'', ''late_fee'', ''departure_time'']);';
    neg_old text := 'or coalesce((l->>''extra_bed_price'')::numeric, 0) < 0 or coalesce((l->>''night_price'')::numeric, 0) < 0 then';
    neg_new text := 'or coalesce((l->>''extra_bed_price'')::numeric, 0) < 0 or coalesce((l->>''night_price'')::numeric, 0) < 0
           or coalesce((l->>''late_fee'')::numeric, 0) < 0 then';
    dep_old text := '        -- уехал раньше: выезд из окна → шахматка';
    dep_new text := '        -- «Уезжает в ~» из окна оплаты → место в шахматке (731)
        if v_rid is not null and l ? ''departure_time'' then
            update residents set departure_time = nullif(l->>''departure_time'', '''')::time where id = v_rid;
        end if;
        -- уехал раньше: выезд из окна → шахматка';
    la_old text := '        v_lm := round(coalesce((l->>''breakfasts'')::numeric, 0) * coalesce((l->>''b_price'')::numeric, 0)';
    la_new text := '        -- поздний выезд (731) — в проживание
        v_la := v_la + round(coalesce((l->>''late_fee'')::numeric, 0), 2);
        v_lm := round(coalesce((l->>''breakfasts'')::numeric, 0) * coalesce((l->>''b_price'')::numeric, 0)';
begin
    if position(k_old in src) = 0 or position(neg_old in src) = 0 or position(dep_old in src) = 0 or position(la_old in src) = 0 then
        raise exception 'fin_group_save: место правки не найдено — функция менялась, правьте миграцию';
    end if;
    execute replace(replace(replace(replace(src, k_old, k_new), neg_old, neg_new), dep_old, dep_new), la_old, la_new);
end
$mig$;

insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('arrival_hint_night', 'приезд ночью — заезд накануне: номер держится с вечера, ночь обычная, в день заезда не ест',
        'night arrival — check-in the day before: room held from the evening, an ordinary night, no meals on check-in day',
        'रात में आगमन — चेक-इन एक दिन पहले: कमरा शाम से रखा जाता है, सामान्य रात, चेक-इन के दिन भोजन नहीं'),
    ('arrival_night_suffix', '(ночью, на следующий день)', '(at night, next day)', '(रात में, अगले दिन)')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
