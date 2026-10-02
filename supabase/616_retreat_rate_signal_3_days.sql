-- 616: плашка «нет курса ретрита» — только за 3 дня до начала.
--
-- Правило ВГ (29.09, docs/finance/phase2_debt_in_price_currency.md, «Курс:
-- окончательно»): сигнал о том, что у ретрита нет своего курса, начинается за
-- 3 дня до начала. В 601 плашка висела всегда, если предоплата в другой валюте
-- ждёт курса (Лила-киртан 2027 — за полгода), и за 30 дней без курса.
-- Предоплата до этого просто лежит и ждёт курса (582) — это штатно, не тревога.

-- ============ Плашка «нет курса ретрита» ============
-- Свой ретрит (не сторонний, не «Гости без события»), ещё не закончился, своего
-- курса нет, до начала 3 дня или меньше (или уже идёт), и либо деньги в другой
-- валюте ждут курса (582), либо курса нет вовсе, а записавшиеся есть.
create or replace function public.fin_get_retreats_without_rate()
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare
  v_rows jsonb;
begin
  if not fin_can_read_all() then
    return jsonb_build_object('ok', true, 'result', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'retreat_id', x.id,
           'title', x.name,
           'start_date', x.start_date,
           'end_date', x.end_date,
           'waiting', x.ждут,
           'participants', x.людей
         ) order by x.start_date), '[]'::jsonb)
    into v_rows
    from (
      select r.id, coalesce(r.name_ru, r.name_en) as name, r.start_date, r.end_date,
             (select string_agg(format('%s — %s', fin_fmt_money(w.сумма, w.currency), w.n || ' плат.'), ', ')
                from (select cp.currency, sum(cp.amount) сумма, count(*) n
                        from crm_payments cp join crm_deals d on d.id = cp.deal_id
                       where d.retreat_id = r.id and cp.is_confirmed and cp.currency <> 'INR'
                         and not exists (select 1 from fin_exchange_rates er
                                           join fin_accounting_objects o on o.id = er.object_id
                                          where o.retreat_id = r.id and er.from_currency = cp.currency)
                       group by cp.currency) w) as ждут,
             (select count(*) from retreat_registrations rr
               where rr.retreat_id = r.id and rr.status <> 'cancelled') as людей,
             exists (select 1 from fin_exchange_rates er join fin_accounting_objects o on o.id = er.object_id
                      where o.retreat_id = r.id) as есть_курс
        from retreats r
       where not coalesce(r.is_external, false)
         and r.id <> fin_private_no_event_retreat()
         and r.end_date >= current_date
    ) x
   where x.start_date <= current_date + 3
     and (x.ждут is not null or (not x.есть_курс and x.людей > 0));

  return jsonb_build_object('ok', true, 'result', v_rows);
end;
$$;
revoke all on function public.fin_get_retreats_without_rate() from public, anon;
grant execute on function public.fin_get_retreats_without_rate() to authenticated;
