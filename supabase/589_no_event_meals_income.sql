-- Гости без события, шаг 3 (ВГ, 29.09.2026): «Себестоимость» кухни видит питание,
-- начисленное гостям без события (служебный контейнер, fin_get_no_event_retreat).
-- Раньше доход строки «Гости без события» был только из пожертвований на прасад.
--
-- fin_no_event_meals_income(p_from, p_to) → [{charge_id, name, check_in, check_out, description,
--   amount (весь, ₹), share (доля в периоде), in_period (₹)}]
-- Доля — по дням визита (заезд…выезд включительно, как у кухни), попавшим в период:
-- визит на стыке месяцев делится, как ретрит. Без визита — целиком в дату начисления.
-- Курс: общий на дату начисления (у контейнера своего нет). Без курса — не входит (rate null).
-- Только чтение.
create or replace function fin_no_event_meals_income(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare
    v_ret uuid := fin_private_no_event_retreat();
begin
    if not (fin_kitchen_can_view() or fin_can_read_all()) then
        raise exception 'forbidden' using detail = 'Недостаточно прав';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'charge_id', x.id, 'name', x.name, 'check_in', x.d1, 'check_out', x.d2,
            'description', x.description, 'amount', round(x.inr, 2), 'no_rate', x.inr is null,
            'share', round(x.share, 4), 'in_period', round(x.inr * x.share, 2)) order by x.d1, x.name)
          from (
            select c.id, c.description,
                   fin_private_person_name(c.participant_id) name,
                   coalesce(r.check_in, c.occurred_on, c.created_at::date) d1,
                   coalesce(r.check_out, r.check_in, c.occurred_on, c.created_at::date) d2,
                   (c.amount - c.discount_amount) * case when c.currency_code = 'INR' then 1 else
                       (select x.rate from fin_exchange_rates x where x.from_currency = c.currency_code and x.object_id is null
                           and x.effective_date <= coalesce(c.occurred_on, c.created_at::date)
                         order by x.effective_date desc limit 1) end inr,
                   (least(coalesce(r.check_out, r.check_in, c.occurred_on, c.created_at::date), p_to)
                      - greatest(coalesce(r.check_in, c.occurred_on, c.created_at::date), p_from) + 1)::numeric
                   / (coalesce(r.check_out, r.check_in, c.occurred_on, c.created_at::date)
                      - coalesce(r.check_in, c.occurred_on, c.created_at::date) + 1) share
              from fin_charges c
              left join residents r on r.id = c.resident_id
             where c.retreat_id = v_ret and c.kind = 'meals' and not c.is_cancelled
               and coalesce(r.check_in, c.occurred_on, c.created_at::date) <= p_to
               and coalesce(r.check_out, r.check_in, c.occurred_on, c.created_at::date) >= p_from
          ) x
    ), '[]'::jsonb);
end;
$$;

revoke execute on function fin_no_event_meals_income(date, date) from public, anon;
grant execute on function fin_no_event_meals_income(date, date) to authenticated;
