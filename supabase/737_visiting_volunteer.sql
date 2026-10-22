-- 737: «Приходящий волонтёр» (ВГ, 22.10.2026)
-- Волонтёр живёт не у нас. Если ест — платит за прасад сам, не департамент и не ашрам.
--   • категория места в шахматке visiting_volunteer — блок «Самостоятельное проживание → Команда»;
--   • кухня считает его как платящего гостя (eating_detail: ELSE → 'guests', правка не нужна);
--   • начисление — как «Гостю без события»: визиты, долги, окно «Начислить гостю»;
--   • цена завтрака/обеда — персональная договорённость по месту (fin_stay_agreements);
--   • начисление за промежуток: какие дни уже начислены — fin_visit_charge_periods.

-- 1. Категория
INSERT INTO resident_categories (slug, name_ru, name_en, name_hi, color, sort_order)
SELECT 'visiting_volunteer', 'Приходящий волонтёр', 'Visiting volunteer', 'आगंतुक स्वयंसेवक', '#0891b2', 4
WHERE NOT EXISTS (SELECT 1 FROM resident_categories WHERE slug = 'visiting_volunteer');

-- 2. Договорённость о цене завтрака и обеда
ALTER TABLE fin_stay_agreements DROP CONSTRAINT fin_stay_agreements_field_check;
ALTER TABLE fin_stay_agreements ADD CONSTRAINT fin_stay_agreements_field_check
    CHECK (field IN ('late_fee', 'people', 'room_price', 'breakfast_price', 'lunch_price'));

DO $$
DECLARE s text;
BEGIN
    s := pg_get_functiondef('public.fin_stay_agreement_set(jsonb)'::regprocedure);
    s := replace(s, $x$v_field not in ('late_fee', 'people', 'room_price')$x$,
                    $x$v_field not in ('late_fee', 'people', 'room_price', 'breakfast_price', 'lunch_price')$x$);
    IF position('breakfast_price' IN s) = 0 THEN RAISE EXCEPTION 'fin_stay_agreement_set: не найден список полей'; END IF;
    EXECUTE s;
END $$;

-- 3. Какие дни визита начислены: строка на начисление, отменённое начисление не в счёт
CREATE TABLE IF NOT EXISTS fin_visit_charge_periods (
    charge_id uuid PRIMARY KEY REFERENCES fin_charges(id) ON DELETE CASCADE,
    resident_id uuid NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
    d_from date NOT NULL,
    d_to date NOT NULL CHECK (d_to >= d_from)
);
CREATE INDEX IF NOT EXISTS fin_visit_charge_periods_resident ON fin_visit_charge_periods (resident_id);
COMMENT ON TABLE fin_visit_charge_periods IS 'Дни визита «без события», за которые выставлено начисление (737)';
ALTER TABLE fin_visit_charge_periods ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fin_visit_charge_period_set(payload jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
    v_actor uuid; v_detail text; v_rid uuid; v_from date; v_to date; v_ids uuid[];
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Начисляет администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'charge_ids', 'd_from', 'd_to']);
    v_rid := fin_private_get_uuid(payload, 'resident_id', true);
    v_from := (payload->>'d_from')::date;
    v_to := (payload->>'d_to')::date;
    if v_from is null or v_to is null or v_to < v_from then
        raise exception 'invalid_payload' using detail = 'Неверный период';
    end if;
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(payload->'charge_ids') x;
    if v_ids is null or exists (select 1 from unnest(v_ids) i
            where not exists (select 1 from fin_charges c where c.id = i and c.resident_id = v_rid)) then
        raise exception 'invalid_payload' using detail = 'Начисление не относится к этому визиту';
    end if;
    insert into fin_visit_charge_periods (charge_id, resident_id, d_from, d_to)
    select i, v_rid, v_from, v_to from unnest(v_ids) i
    on conflict (charge_id) do update set d_from = excluded.d_from, d_to = excluded.d_to;
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('d_from', v_from, 'd_to', v_to), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$function$;
REVOKE ALL ON FUNCTION public.fin_visit_charge_period_set(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_visit_charge_period_set(jsonb) TO authenticated, service_role;

-- 4. Визиты «без события»: гость и приходящий волонтёр; категория и «начислено по»
DO $$
DECLARE s text;
BEGIN
    s := pg_get_functiondef('public.fin_list_no_event_visits(date, date)'::regprocedure);
    s := replace(s, $x$rc.slug = 'guest'$x$, $x$rc.slug in ('guest', 'visiting_volunteer')$x$);
    s := replace(s, $x$'status', r.status,$x$,
                    $x$'status', r.status,
            'category', rc.slug,
            'charged_to', (select max(p.d_to) from fin_visit_charge_periods p
                             join fin_charges c on c.id = p.charge_id and not c.is_cancelled
                            where p.resident_id = r.id),$x$);
    IF position('visiting_volunteer' IN s) = 0 OR position('charged_to' IN s) = 0 THEN
        RAISE EXCEPTION 'fin_list_no_event_visits: не найдены места правки';
    END IF;
    EXECUTE s;

    s := pg_get_functiondef('public.fin_no_event_uncharged()'::regprocedure);
    s := replace(s, $x$rc.slug = 'guest'$x$, $x$rc.slug in ('guest', 'visiting_volunteer')$x$);
    IF position('visiting_volunteer' IN s) = 0 THEN RAISE EXCEPTION 'fin_no_event_uncharged: не найдена категория'; END IF;
    EXECUTE s;

    -- департамент у места приходящего волонтёра тоже ведёт карточка (кто где служит)
    s := pg_get_functiondef('public.resident_department_from_card(uuid, date)'::regprocedure);
    s := replace(s, $x$slug in ('team', 'volunteer')$x$, $x$slug in ('team', 'volunteer', 'visiting_volunteer')$x$);
    IF position('visiting_volunteer' IN s) = 0 THEN RAISE EXCEPTION 'resident_department_from_card: не найдена категория'; END IF;
    EXECUTE s;
END $$;
