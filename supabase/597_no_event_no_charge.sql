-- Гости без события (ВГ, 01.10.2026): «без оплаты» и серый $ в шахматке.
--   • fin_no_charge_visits — визит отмечен «без оплаты» с причиной (гость ашрама,
--     за счёт ашрама, пожертвование). Частичная оплата — обычное начисление со скидкой.
--   • fin_guest_set_no_charge — поставить/снять отметку (администратор финансов);
--     при уже живых начислениях по визиту — отказ: сначала отменить их.
--   • fin_list_no_event_visits отдаёт no_charge_reason.
--   • fin_no_event_uncharged — визиты, которые уже начались, а по ним ни начислений,
--     ни отметки «без оплаты»: шахматка ставит серый $. Ресепшен служебный контейнер
--     не видит, поэтому — только id визитов, без сумм (как fin_no_event_debt_flags).

create table if not exists fin_no_charge_visits (
    resident_id uuid primary key references residents(id) on delete cascade,
    reason text not null check (length(trim(reason)) > 0),
    created_by uuid,
    created_at timestamptz not null default now()
);
alter table fin_no_charge_visits enable row level security;
-- политик нет: читается и пишется только через функции ниже

create or replace function fin_guest_set_no_charge(payload jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
    v_actor uuid; v_detail text; v_res residents%rowtype; v_reason text;
begin
    v_actor := fin_actor();
    if not fin_is_admin(v_actor) then
        raise exception 'forbidden' using detail = 'Отмечает администратор финансов';
    end if;
    perform fin_private_assert_keys(payload, array['resident_id', 'reason']);
    select * into v_res from residents where id = fin_private_get_uuid(payload, 'resident_id', true);
    if not found then raise exception 'invalid_payload' using detail = 'Проживание (визит) не найдено'; end if;
    if v_res.retreat_id is not null then
        raise exception 'invalid_payload' using detail = 'Это проживание ретрита — оплата через ретрит';
    end if;
    v_reason := nullif(trim(coalesce(payload->>'reason', '')), '');
    if v_reason is null then
        delete from fin_no_charge_visits where resident_id = v_res.id;
    else
        if exists (select 1 from fin_charges where resident_id = v_res.id and not is_cancelled) then
            raise exception 'has_charges' using detail = 'По визиту уже есть начисления — сначала отмените их';
        end if;
        insert into fin_no_charge_visits (resident_id, reason, created_by)
        values (v_res.id, v_reason, v_actor)
        on conflict (resident_id) do update set reason = excluded.reason, created_by = excluded.created_by, created_at = now();
    end if;
    return jsonb_build_object('ok', true, 'result', jsonb_build_object('reason', v_reason), 'warnings', '[]'::jsonb);
exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm ~ '^[a-z_]{3,60}$' then
        return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
end;
$$;

create or replace function fin_no_event_uncharged()
returns table(resident_id uuid)
language plpgsql stable security definer set search_path to 'public' as $$
begin
    if not is_staff(auth.uid()) then raise exception 'forbidden'; end if;
    return query
    select r.id from residents r
      join resident_categories rc on rc.id = r.category_id and rc.slug = 'guest'
     where r.retreat_id is null
       and r.status in ('confirmed', 'checked_out')
       and r.check_in <= current_date
       and not exists (select 1 from fin_charges c where c.resident_id = r.id and not c.is_cancelled)
       and not exists (select 1 from fin_no_charge_visits n where n.resident_id = r.id);
end;
$$;

CREATE OR REPLACE FUNCTION public.fin_list_no_event_visits(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            'roommates', (select max(cnt) from (
                select count(*) cnt from generate_series(r.check_in, coalesce(r.check_out, r.check_in), interval '1 day') g(d)
                  join residents o on o.room_id = r.room_id and o.status in ('confirmed', 'checked_out')
                   and o.check_in <= g.d::date and coalesce(o.check_out, o.check_in) > g.d::date
                 group by g.d) x),
            'charged', (select coalesce(sum(c.amount - c.discount_amount), 0) from fin_charges c
                         where c.resident_id = r.id and not c.is_cancelled),
            'charge_currency', (select min(c.currency_code) from fin_charges c
                                 where c.resident_id = r.id and not c.is_cancelled),
            'no_charge_reason', (select n.reason from fin_no_charge_visits n where n.resident_id = r.id),
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
$function$;

revoke all on table fin_no_charge_visits from public, anon, authenticated;
revoke all on function fin_guest_set_no_charge(jsonb) from public, anon;
revoke all on function fin_no_event_uncharged() from public, anon;
grant execute on function fin_guest_set_no_charge(jsonb) to authenticated;
grant execute on function fin_no_event_uncharged() to authenticated;

insert into translations (key, ru, en, hi, context) values
    ('timeline_not_charged', 'Не начислено и не оплачено', 'Not charged, not paid', 'शुल्क नहीं, भुगतान नहीं', 'Шахматка'),
    ('timeline_outside_retreat_hint', 'вне дат ретрита. Вынести в «Гости без события»? Кнопка «Разделить» в окне проживания', 'outside retreat dates. Move to «Guests without event»? Use «Split» in the stay window', 'रिट्रीट तिथियों के बाहर। «बिना कार्यक्रम के अतिथि» में ले जाएँ? ठहराव विंडो में «विभाजित करें»', 'Шахматка'),
    ('timeline_days_before', 'дн. до', 'days before', 'दिन पहले', 'Шахматка'),
    ('timeline_days_after', 'дн. после', 'days after', 'दिन बाद', 'Шахматка'),
    ('timeline_split_before', 'Разделить: до ретрита', 'Split: before retreat', 'विभाजित: रिट्रीट से पहले', 'Шахматка'),
    ('timeline_split_after', 'Разделить: после ретрита', 'Split: after retreat', 'विभाजित: रिट्रीट के बाद', 'Шахматка')
on conflict (key) do nothing;
