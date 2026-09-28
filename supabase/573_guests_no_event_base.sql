-- Гости без события, шаг 1 (ВГ, 28.09.2026): оплата проживания и питания от гостей,
-- приехавших не на ретрит. Финансы ведут долг по паре «участник + ретрит», поэтому
-- для таких гостей заводится служебный ретрит-контейнер «Гости без события»:
--   • скрыт от всех страниц через RLS (видят его только функции финансов);
--   • курс — общий на дату, а не курс ретрита;
--   • начисление помнит визит (residents.id), к которому относится;
--   • тарифы (номер 2/4-местный, завтрак, обед) — с датой «действует с».

-- ==================== Контейнер ====================
alter table retreats add column if not exists is_system boolean not null default false;

-- Ограничивающая политика: складывается по И со всеми остальными, так что служебные
-- ретриты не видны и не меняются через API ни у кого. SECURITY DEFINER-функции её обходят.
drop policy if exists "Hide system retreats" on retreats;
create policy "Hide system retreats" on retreats as restrictive for all
    to anon, authenticated
    using (not is_system) with check (not is_system);

insert into retreats (name_ru, name_en, name_hi, slug, start_date, end_date,
                      is_system, is_public, registration_open, cafe_eligible)
select 'Гости без события', 'Guests without event', 'बिना कार्यक्रम के अतिथि', 'no-event',
       date '2000-01-01', date '2000-01-01', true, false, false, false
where not exists (select 1 from retreats where slug = 'no-event');
-- учётный объект создаёт триггер trg_fin_sync_retreat_object

create or replace function fin_private_no_event_retreat()
returns uuid language sql stable security definer set search_path to 'public' as $$
    select id from retreats where slug = 'no-event' and is_system;
$$;

create or replace function fin_get_no_event_retreat()
returns uuid language plpgsql stable security definer set search_path to 'public' as $$
begin
    if not fin_can_read_all() then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    return fin_private_no_event_retreat();
end;
$$;

-- ==================== Курс ====================
-- Для служебного контейнера своего курса нет — берётся общий курс на дату
create or replace function public.fin_private_retreat_rate(p_currency text, p_object uuid, p_on date)
 returns numeric
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_rate numeric;
begin
  if p_currency = 'INR' then return 1; end if;
  select rate into v_rate from fin_exchange_rates
   where from_currency = p_currency and object_id = p_object and effective_date <= p_on
   order by effective_date desc limit 1;
  if v_rate is null and exists (
      select 1 from fin_accounting_objects o join retreats r on r.id = o.retreat_id
       where o.id = p_object and r.is_system) then
    return fin_private_get_rate(p_currency, null, p_on);
  end if;
  if v_rate is null then
    raise exception 'retreat_rate_missing'
      using detail = format('Нет курса ретрита %s→INR на %s — заведите курс ретрита', p_currency, p_on);
  end if;
  return v_rate;
end;
$function$;

-- Курсы для карточки: у контейнера — последние общие
create or replace function public.fin_get_retreat_rates(p_retreat uuid)
 returns table(currency_code text, rate numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
    select distinct on (r.from_currency) r.from_currency::text, r.rate
      from fin_exchange_rates r
      left join fin_accounting_objects o on o.id = r.object_id
     where o.retreat_id = p_retreat
        or (r.object_id is null
            and not exists (select 1 from fin_accounting_objects e
                              join retreats rt on rt.id = e.retreat_id
                             where e.retreat_id = p_retreat and not e.legacy_inr_settlement
                               and not rt.is_system))
     order by r.from_currency, (o.retreat_id = p_retreat) desc nulls last, r.effective_date desc;
$function$;

-- ==================== Тарифы ====================
create table if not exists fin_stay_tariffs (
    id uuid primary key default gen_random_uuid(),
    effective_date date not null unique,
    room2_price numeric(12, 2) not null check (room2_price >= 0),
    room4_price numeric(12, 2) not null check (room4_price >= 0),
    breakfast_price numeric(12, 2) not null check (breakfast_price >= 0),
    lunch_price numeric(12, 2) not null check (lunch_price >= 0),
    currency_code text not null default 'INR',
    created_by uuid,
    created_at timestamptz not null default now()
);
alter table fin_stay_tariffs enable row level security;
revoke all on fin_stay_tariffs from anon, authenticated;

insert into fin_stay_tariffs (effective_date, room2_price, room4_price, breakfast_price, lunch_price)
values (date '2026-09-28', 3500, 5500, 250, 500)
on conflict (effective_date) do nothing;

-- Действующий тариф на дату + история
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
                               from fin_stay_tariffs t), '[]'::jsonb));
end;
$$;

-- Новый тариф с даты; та же дата — исправление. На сделанные начисления не влияет:
-- цена копируется в начисление в момент расчёта
create or replace function fin_set_stay_tariffs(payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid; v_detail text; v_row fin_stay_tariffs%rowtype;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Тарифы меняет администратор финансов';
    end if;
    perform fin_private_assert_keys(payload,
        array['effective_date', 'room2_price', 'room4_price', 'breakfast_price', 'lunch_price']);
    insert into fin_stay_tariffs (effective_date, room2_price, room4_price, breakfast_price, lunch_price, created_by)
    values (fin_private_get_date(payload, 'effective_date', true),
            fin_private_get_money(payload, 'room2_price', true),
            fin_private_get_money(payload, 'room4_price', true),
            fin_private_get_money(payload, 'breakfast_price', true),
            fin_private_get_money(payload, 'lunch_price', true),
            v_actor)
    on conflict (effective_date) do update
       set room2_price = excluded.room2_price, room4_price = excluded.room4_price,
           breakfast_price = excluded.breakfast_price, lunch_price = excluded.lunch_price,
           created_by = excluded.created_by, created_at = now()
    returning * into v_row;
    return jsonb_build_object('ok', true, 'result', to_jsonb(v_row), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

-- ==================== Начисление → визит ====================
alter table fin_charges add column if not exists resident_id uuid references residents(id) on delete set null;
create index if not exists fin_charges_resident_idx on fin_charges(resident_id) where resident_id is not null;

-- fin_create_charge: необязательный resident_id (визит). В хеш идемпотентности
-- попадает только когда передан — хеши прежних начислений не меняются
create or replace function public.fin_create_charge(payload jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
v_actor uuid; v_rows jsonb; r jsonb; v_id uuid; v_participant uuid; v_retreat uuid; v_kind fin_charge_kind;
v_qty numeric; v_price numeric; v_amount numeric; v_discount numeric; v_description text; v_agreed text; v_hash text;
v_existing fin_charges%ROWTYPE; v_lock record; v_creation_reason text; v_results jsonb := '[]'::jsonb;
v_retreats uuid[] := '{}'; v_detail text; v_cur text; v_resident uuid; v_hash_src jsonb;
BEGIN
v_actor := fin_actor();
IF NOT fin_is_admin(v_actor) THEN RAISE EXCEPTION 'forbidden' USING DETAIL = 'Начисления создаёт только администратор финансов'; END IF;
PERFORM fin_private_assert_keys(payload, ARRAY['rows']);
v_rows := payload->'rows';
IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив начислений'; END IF;
SELECT array_agg(DISTINCT (x->>'retreat_id')::uuid) INTO v_retreats FROM jsonb_array_elements(v_rows) x;
PERFORM 1 FROM fin_accounting_objects WHERE retreat_id = ANY (v_retreats) ORDER BY id FOR UPDATE;
FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val) ORDER BY lower(x.val->>'id') LOOP
PERFORM fin_private_assert_keys(r, ARRAY['id', 'participant_id', 'retreat_id', 'kind', 'description',
'quantity', 'unit_price', 'discount_amount', 'discount_reason', 'creation_reason', 'agreed_with', 'occurred_on', 'resident_id']);
v_id := fin_private_get_uuid(r, 'id', true);
v_participant := fin_private_get_uuid(r, 'participant_id', true);
v_retreat := fin_private_get_uuid(r, 'retreat_id', true);
v_resident := fin_private_get_uuid(r, 'resident_id', false);
v_description := NULLIF(trim(COALESCE(r->>'description', '')), '');
IF v_description IS NULL THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Описание начисления обязательно'; END IF;
BEGIN v_kind := (r->>'kind')::fin_charge_kind;
EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'kind: org_fee | accommodation | meals | extra'; END;
BEGIN v_qty := (r->>'quantity')::numeric; v_price := round((r->>'unit_price')::numeric, 2);
v_discount := round(COALESCE(NULLIF(r->>'discount_amount', ''), '0')::numeric, 2);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Некорректные quantity/unit_price/discount_amount'; END;
IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'quantity должно быть > 0'; END IF;
IF v_price IS NULL OR v_price < 0 THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'unit_price должно быть >= 0'; END IF;
v_amount := round(v_qty * v_price, 2);
IF v_discount < 0 OR v_discount > v_amount THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Скидка должна быть в пределах 0..amount'; END IF;
IF v_discount > 0 AND NULLIF(trim(COALESCE(r->>'discount_reason', '')), '') IS NULL THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Скидка требует причины'; END IF;
IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_participant) THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Участник не найден'; END IF;
IF NOT EXISTS (SELECT 1 FROM retreats WHERE id = v_retreat) THEN RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ретрит не найден'; END IF;
IF v_resident IS NOT NULL AND NOT EXISTS (SELECT 1 FROM residents WHERE id = v_resident) THEN
RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Проживание (визит) не найдено'; END IF;
v_agreed := NULLIF(trim(COALESCE(r->>'agreed_with', '')), '');
v_hash_src := jsonb_build_object('command', 'create_charge', 'participant_id', lower(v_participant::text),
'retreat_id', lower(v_retreat::text), 'kind', v_kind, 'description', trim(COALESCE(r->>'description', '')),
'quantity', v_qty::text, 'unit_price', fin_private_norm_money(v_price), 'discount_amount', fin_private_norm_money(v_discount),
'discount_reason', NULLIF(trim(COALESCE(r->>'discount_reason', '')), ''), 'agreed_with', v_agreed);
IF v_resident IS NOT NULL THEN v_hash_src := v_hash_src || jsonb_build_object('resident_id', lower(v_resident::text)); END IF;
v_hash := fin_private_hash(v_hash_src);
SELECT * INTO v_existing FROM fin_charges WHERE id = v_id;
IF FOUND THEN
IF v_existing.request_hash <> v_hash THEN RAISE EXCEPTION 'idempotency_conflict' USING DETAIL = 'Тот же id начисления уже использован с другим содержимым'; END IF;
v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id, 'existed', true)); CONTINUE;
END IF;
SELECT * INTO v_lock FROM fin_private_lock_retreat_object(v_retreat);
v_creation_reason := NULLIF(trim(COALESCE(r->>'creation_reason', '')), '');
IF v_lock.is_closed THEN
IF v_creation_reason IS NULL THEN RAISE EXCEPTION 'post_close_reason_required' USING DETAIL = 'Начисление по закрытому ретриту требует причины'; END IF;
UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = v_lock.object_id;
END IF;
v_cur := 'INR';
IF EXISTS (SELECT 1 FROM fin_accounting_objects WHERE retreat_id = v_retreat AND NOT legacy_inr_settlement) THEN
SELECT o_currency INTO v_cur FROM fin_private_settlement_currency(v_participant, v_retreat);
END IF;
INSERT INTO fin_charges (id, request_hash, participant_id, retreat_id, kind, description, quantity, unit_price, amount, discount_amount, discount_reason,
agreed_with, creation_reason, created_by, occurred_on, currency_code, resident_id)
VALUES (v_id, v_hash, v_participant, v_retreat, v_kind, v_description, v_qty, v_price, v_amount, v_discount,
NULLIF(trim(COALESCE(r->>'discount_reason', '')), ''), v_agreed, v_creation_reason, v_actor,
COALESCE(fin_private_get_date(r, 'occurred_on'), CURRENT_DATE), v_cur, v_resident);
v_results := v_results || jsonb_build_array(jsonb_build_object('id', v_id, 'amount', v_amount, 'net_amount', v_amount - v_discount, 'currency_code', v_cur));
END LOOP;
RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('rows', v_results), 'warnings', '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
IF SQLERRM ~ '^[a-z_]{3,60}$' THEN RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM))); END IF;
RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

-- Права: служебная функция — только изнутри, публичные — вошедшим
revoke all on function fin_private_no_event_retreat() from public, anon, authenticated;
revoke all on function fin_get_no_event_retreat() from public, anon;
revoke all on function fin_get_stay_tariffs(date) from public, anon;
revoke all on function fin_set_stay_tariffs(jsonb) from public, anon;
grant execute on function fin_get_no_event_retreat() to authenticated;
grant execute on function fin_get_stay_tariffs(date) to authenticated;
grant execute on function fin_set_stay_tariffs(jsonb) to authenticated;
