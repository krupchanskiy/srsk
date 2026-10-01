-- 602: расшифровка «начальный остаток не сходится с платежами» — по формуле
-- самой проверки (ВГ, 01.10).
--
-- Расшифровка считала по-старому: все платежи без проводки против остатка в
-- ₹ без пересчёта валюты и по человеку, а не по сделке. Проверка находила 0,
-- а расшифровка показала бы 20 строк. Теперь — ровно условие из
-- fin_run_integrity_checks (advance_partial_load): по сделке, платежи до
-- запуска без живой проводки против остатка рубежа в ₹ по курсу события.
--
-- Кнопку «Добрать» убираем: fin_resolve_missing_advance отказывает в доборе,
-- если остаток уже есть, а здесь он есть всегда — кнопка не срабатывала.
--
-- Ветка заменяется по тексту из базы: якоря обязаны найтись.

do $mig$
declare
  src text := pg_get_functiondef('fin_get_integrity_details(text)'::regprocedure);
  a int := position('if p_check = ''advance_partial_load'' then' in src);
  b int := position('elsif p_check = ''advance_double_representation'' then' in src);
  ветка text := $branch$if p_check = 'advance_partial_load' then
    -- Условие — как в проверке advance_partial_load: правя одно, правь и другое
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(d.vaishnava_id),
             'subtitle', coalesce(r.name_ru, r.name_en),
             'detail', format('в начальном остатке %s, платежей до запуска %s — %s %s',
                              fin_fmt_money(o.ob, 'INR'), fin_fmt_money(s.pay, 'INR'),
                              case when s.pay > o.ob then 'не хватает' else 'лишних' end,
                              fin_fmt_money(abs(s.pay - o.ob), 'INR')),
             'link', fin_private_participant_link(d.vaishnava_id, d.retreat_id)
           ) order by abs(s.pay - o.ob) desc), '[]'::jsonb)
      into v_rows
      from (select d.id, round(sum(p.amount_inr), 2) as pay
              from crm_deals d join crm_payments p on p.deal_id = d.id
             where p.is_confirmed
               and coalesce(p.received_at::date, current_date) < coalesce(fin_cutover_date(), current_date)
               and not exists (select 1 from fin_operations op where op.id = p.id and not op.is_reversed)
             group by d.id) s
      join (select source_row_id,
                   round(sum(fin_private_to_inr(amount, currency_code, retreat_id, created_at::date)), 2) as ob
              from fin_participant_opening_balances
             where cutover_batch_id is not null
             group by source_row_id) o on o.source_row_id = s.id::text
      join crm_deals d on d.id = s.id
      left join retreats r on r.id = d.retreat_id
     where abs(s.pay - o.ob) > 0.01;

  $branch$;
begin
  if a = 0 or b = 0 or b < a then
    raise exception 'fin_get_integrity_details: якоря advance_partial_load не найдены';
  end if;
  execute overlay(src placing ветка from a for b - a);
end;
$mig$;
