-- 601: расшифровка у каждого предупреждения финансов (ВГ, 01.10).
--
-- «Нарушение целостности … (2)» без имён и сумм не даёт дойти до проблемы:
-- из 16 проверок сторожа расшифровка была у 4. Теперь — у всех:
-- кто, где, что не так, и ссылка прямо на операцию / карточку / курс.
--
-- Заодно:
-- 1. Две проверки ловили округление, а не ошибку.
--    • Начисление пересчитано из ₹ в €: сумма точная, а цена за единицу
--      округлена до центов, и 33 × 4,17 ≠ 137,50 на 11 центов. Допуск —
--      половина цента на единицу.
--    • Оплата в ₽ по сумме в ₹: ₹ точные, ₽ округлены до копейки, и
--      4 666,67 × 1,05 ≠ 4 900,01 на копейку. Допуск — половина копейки × курс.
--    • Сторно ошибочного перевода (26 450 000 ₹ вместо 2 645 000) наследует
--      курсы перевода, как и сам перевод — перевод проверка уже пропускала,
--      а его сторно нет.
-- 2. Ночной сторож не обновлял число: у плашки оставалась цифра первого
--    обнаружения. Теперь число и текст обновляются каждую ночь.
-- 3. Тексты проверок — по-человечески, без quantity*unit_price.
-- 4. fin_get_retreats_without_rate — для плашки «нет курса ретрита».
--
-- Условия «плохой строки» в расшифровке повторяют условия проверки в
-- fin_run_integrity_checks: правя одно, правь и другое.

-- ============ Проверки сторожа ============
CREATE OR REPLACE FUNCTION public.fin_run_integrity_checks()
 RETURNS TABLE(check_name text, bad_count bigint, detail text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  chk record;
  v_count bigint;
  checks jsonb := jsonb_build_array(
    jsonb_build_object('name','posting_currency_amount',
      'detail','Проводка в чужой валюте счёта или с нулевой/отрицательной суммой или курсом',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_accounts a ON a.id=p.account_id WHERE p.currency_code<>a.currency_code OR p.amount<=0 OR p.amount_base<0 OR p.rate_used<=0'),
    jsonb_build_object('name','amount_base_wrong',
      'detail','Сумма в ₹ не сходится с суммой в валюте по курсу проводки',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_operations o ON o.id=p.operation_id LEFT JOIN fin_operations orig ON orig.id=o.original_operation_id WHERE o.type NOT IN (''transfer'',''refund'') AND NOT (o.type=''reversal'' AND orig.type IN (''transfer'',''refund'')) AND ((p.currency_code=''INR'' AND (p.rate_used<>1 OR p.amount_base<>p.amount)) OR (p.currency_code<>''INR'' AND abs(p.amount_base - p.amount*p.rate_used) > 0.005*p.rate_used + 0.0051))'),
    jsonb_build_object('name','reversal_not_zero',
      'detail','Сторно не гасит исходную операцию в ноль',
      'sql','SELECT count(*) FROM fin_operations r WHERE r.type=''reversal'' AND (SELECT COALESCE(SUM(CASE direction WHEN ''in'' THEN amount_base ELSE -amount_base END),0) FROM fin_postings WHERE operation_id IN (r.id, r.original_operation_id))<>0'),
    jsonb_build_object('name','double_reversal',
      'detail','Операция сторнирована дважды',
      'sql','SELECT count(*) FROM (SELECT original_operation_id FROM fin_operations WHERE type=''reversal'' GROUP BY 1 HAVING count(*)>1) x'),
    jsonb_build_object('name','charge_amount_wrong',
      'detail','Сумма начисления не равна «количество × цена»',
      'sql','SELECT count(*) FROM fin_charges WHERE abs(amount - quantity*unit_price) > 0.005*abs(quantity) + 0.0051'),
    jsonb_build_object('name','participant_kind_mismatch',
      'detail','Проводка привязана к участнику не до конца или там, где участника быть не может',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_operations o ON o.id=p.operation_id WHERE (p.participant_id IS NULL)<>(p.participant_balance_kind IS NULL) OR (o.type IN (''transfer'',''opening'',''reconciliation_adjustment'') AND (p.participant_id IS NOT NULL OR p.participant_balance_kind IS NOT NULL))'),
    jsonb_build_object('name','rate_duplicates',
      'detail','Курс заведён дважды на одну дату',
      'sql','SELECT count(*) FROM (SELECT object_id, effective_date, from_currency FROM fin_exchange_rates GROUP BY 1,2,3 HAVING count(*)>1) x'),
    jsonb_build_object('name','post_close_no_object',
      'detail','Проводка помечена «после закрытия», но не привязана к событию',
      'sql','SELECT count(*) FROM fin_postings WHERE object_id IS NULL AND is_post_close'),
    jsonb_build_object('name','totals_mismatch',
      'detail','Итоги сделки в CRM (оплачено/начислено) разошлись с финансами',
      'sql','SELECT count(*) FROM crm_deals d, LATERAL crm_calc_deal_totals(d.id) t WHERE abs(d.total_paid - t.o_paid) > 0.01 OR d.total_charged IS DISTINCT FROM t.o_charged'),
    jsonb_build_object('name','orphan_autopost',
      'detail','Автопроводка осталась, а платёж CRM, из которого она сделана, удалён',
      'sql','SELECT count(*) FROM fin_operations o WHERE o.comment LIKE ''%Автопроводка%'' AND NOT o.is_reversed AND NOT EXISTS (SELECT 1 FROM crm_payments p WHERE p.id=o.id)'),
    jsonb_build_object('name','unposted_payments',
      'detail','Платежи подтверждены в CRM после запуска, но не разнесены в финмодуль',
      'sql','SELECT count(*) FROM crm_payments cp WHERE cp.is_confirmed AND COALESCE(cp.received_at::date, CURRENT_DATE) >= COALESCE(fin_cutover_date(), DATE ''1900-01-01'') AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=cp.id) AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id=cp.id AND g.status<>''skipped'')'),
    jsonb_build_object('name','currency_cache_drift',
      'detail','Курс в CRM разошёлся с общим курсом финансов',
      'sql','SELECT count(*) FROM crm_currencies c WHERE c.code<>''INR'' AND c.rate_to_inr IS DISTINCT FROM (SELECT rate FROM fin_exchange_rates r WHERE r.from_currency=c.code AND r.object_id IS NULL AND r.effective_date<=CURRENT_DATE ORDER BY r.effective_date DESC LIMIT 1)'),
    jsonb_build_object('name','advance_double_representation',
      'detail','Платёж есть и в журнале, и в начальном остатке своей сделки — деньги посчитаны дважды',
      'sql','SELECT count(*) FROM crm_payments p JOIN crm_deals d ON d.id=p.deal_id WHERE p.is_confirmed AND EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=p.id AND NOT o.is_reversed) AND COALESCE(p.received_at::date, p.confirmed_at::date) < COALESCE(fin_cutover_date(), CURRENT_DATE) AND EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.source_row_id=d.id::text)'),
    jsonb_build_object('name','operation_in_future',
      'detail','Операция датирована будущим: сразу уменьшает остаток счёта, но не попадает ни в один отчёт за период',
      'sql','SELECT count(*) FROM fin_operations WHERE occurred_on > CURRENT_DATE + 1'),
    jsonb_build_object('name','shared_login_blocks_portal',
      'detail','Один вход делят несколько человек — портал не может показать им финансы, нужен отдельный вход каждому',
      'sql','SELECT count(*) FROM (SELECT v.user_id FROM vaishnavas v WHERE v.user_id IS NOT NULL GROUP BY v.user_id HAVING count(*) > 1 AND bool_or(EXISTS (SELECT 1 FROM fin_charges c WHERE c.participant_id = v.id) OR EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id = v.id) OR EXISTS (SELECT 1 FROM fin_postings p WHERE p.participant_id = v.id)) AND EXISTS (SELECT 1 FROM vaishnavas v1 WHERE v1.user_id = v.user_id AND NOT EXISTS (SELECT 1 FROM family_links fl JOIN vaishnavas v2 ON v2.id = CASE WHEN fl.vaishnava_id = v1.id THEN fl.relative_id ELSE fl.vaishnava_id END WHERE (fl.vaishnava_id = v1.id OR fl.relative_id = v1.id) AND v2.user_id = v.user_id))) x'),
    jsonb_build_object('name','advance_missing',
      'detail','Взносы подтверждены в CRM, но человека нет в учёте: ни начального остатка, ни проводок',
      'sql','SELECT count(*) FROM (SELECT cd.vaishnava_id, cd.retreat_id FROM crm_payments cp JOIN crm_deals cd ON cd.id=cp.deal_id WHERE cp.is_confirmed AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=cp.id) AND NOT EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id=cd.vaishnava_id AND ob.retreat_id=cd.retreat_id) AND NOT EXISTS (SELECT 1 FROM fin_payment_dispositions pd WHERE pd.payment_id=cp.id) GROUP BY 1,2) x'),
    jsonb_build_object('name','advance_partial_load',
      'detail','У сделки есть начальный остаток, но сумма исторических платежей с ним не сходится',
      'sql','SELECT count(*) FROM (SELECT d.id, round(SUM(p.amount_inr),2) AS pay FROM crm_deals d JOIN crm_payments p ON p.deal_id=d.id WHERE p.is_confirmed AND COALESCE(p.received_at::date,CURRENT_DATE) < COALESCE(fin_cutover_date(), CURRENT_DATE) AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=p.id AND NOT o.is_reversed) GROUP BY d.id) s JOIN (SELECT source_row_id, round(SUM(fin_private_to_inr(amount, currency_code, retreat_id, created_at::date)),2) AS ob FROM fin_participant_opening_balances WHERE cutover_batch_id IS NOT NULL GROUP BY source_row_id) o ON o.source_row_id=s.id::text WHERE abs(s.pay - o.ob) > 0.01')
  );
BEGIN
  FOR chk IN SELECT * FROM jsonb_array_elements(checks) AS x(val)
  LOOP
    EXECUTE (chk.val->>'sql') INTO v_count;
    check_name := chk.val->>'name';
    bad_count := v_count;
    detail := chk.val->>'detail';
    RETURN NEXT;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_run_integrity_checks() FROM PUBLIC, anon, authenticated;

-- ============ Ночной прогон: число и текст открытой плашки — свежие ============
CREATE OR REPLACE FUNCTION public.fin_integrity_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_now timestamptz := now();
BEGIN
  FOR r IN SELECT * FROM fin_run_integrity_checks()
  LOOP
    IF r.bad_count > 0 THEN
      UPDATE fin_integrity_alerts SET bad_count = r.bad_count, detail = r.detail
       WHERE check_name = r.check_name AND resolved_at IS NULL;
      IF NOT FOUND THEN
        INSERT INTO fin_integrity_alerts (check_name, detail, bad_count, detected_at)
        VALUES (r.check_name, r.detail, r.bad_count, v_now);
      END IF;
    ELSE
      UPDATE fin_integrity_alerts SET resolved_at = v_now
      WHERE check_name = r.check_name AND resolved_at IS NULL;
    END IF;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_integrity_sweep() FROM PUBLIC, anon, authenticated;

-- ============ Помощники расшифровки ============
-- Ссылка на карточку участника: «Гости без события» открываются своим режимом
create or replace function fin_private_participant_link(p_participant uuid, p_retreat uuid)
returns text
language sql stable security definer set search_path to 'public' as $$
  select case when p_retreat = fin_private_no_event_retreat()
              then format('participants.html?guests=1&open=%s', p_participant)
              else format('participants.html?retreat=%s&open=%s', p_retreat, p_participant) end;
$$;
revoke all on function fin_private_participant_link(uuid, uuid) from public, anon, authenticated;

create or replace function fin_private_op_type_ru(p_type text)
returns text
language sql immutable set search_path to 'public' as $$
  select case p_type
    when 'income' then 'Приход' when 'expense' then 'Расход' when 'transfer' then 'Перевод'
    when 'payment' then 'Оплата участника' when 'refund' then 'Возврат' when 'reversal' then 'Сторно'
    when 'donation' then 'Пожертвование' when 'opening' then 'Начальный остаток'
    when 'reconciliation_adjustment' then 'Корректировка сверки'
    else p_type end;
$$;

-- Строка расшифровки про проводку: кто/какой счёт, дата и тип, что не так, ссылка на операцию в ДДС
create or replace function fin_private_posting_row(p_posting uuid, p_what text)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
           'title', coalesce(fin_private_person_name(p.participant_id), a.name),
           'subtitle', format('%s · %s · %s', fin_private_op_type_ru(o.type::text),
                              fin_fmt_date_ru(o.occurred_on), a.name),
           'detail', p_what,
           'link', format('dds.html?op=%s', o.id))
    from fin_postings p
    join fin_operations o on o.id = p.operation_id
    join fin_accounts a on a.id = p.account_id
   where p.id = p_posting;
$$;
revoke all on function fin_private_posting_row(uuid, text) from public, anon, authenticated;

-- Строка про операцию целиком
create or replace function fin_private_op_row(p_op uuid, p_what text)
returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
           'title', coalesce(
             (select fin_private_person_name(p.participant_id) from fin_postings p
               where p.operation_id = o.id and p.participant_id is not null limit 1),
             nullif(o.comment, ''),
             fin_private_op_type_ru(o.type::text)),
           'subtitle', format('%s · %s', fin_private_op_type_ru(o.type::text), fin_fmt_date_ru(o.occurred_on)),
           'detail', p_what,
           'link', format('dds.html?op=%s', o.id))
    from fin_operations o
   where o.id = p_op;
$$;
revoke all on function fin_private_op_row(uuid, text) from public, anon, authenticated;

-- ============ Расшифровка: все проверки ============
create or replace function public.fin_get_integrity_details(p_check text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_rows jsonb;
begin
  if not fin_can_read_all() then
    raise exception 'forbidden' using detail = 'Недостаточно прав';
  end if;

  if p_check = 'advance_partial_load' then
    -- Начальный остаток есть, но он меньше (или больше) суммы исторических платежей
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('в остатке %s, платежей %s — расхождение %s',
                              fin_fmt_money(x.в_остатке, 'INR'),
                              fin_fmt_money(x.в_платежах, 'INR'),
                              fin_fmt_money(x.в_платежах - x.в_остатке, 'INR')),
             'link', fin_private_participant_link(x.participant_id, x.retreat_id),
             'action', jsonb_build_object(
                         'kind', 'resolve_missing_advance',
                         'mode', 'topup',
                         'participant_id', x.participant_id,
                         'retreat_id', x.retreat_id,
                         'amount', fin_fmt_money(x.в_платежах - x.в_остатке, 'INR'),
                         'who', x.имя)
           ) order by abs(x.в_платежах - x.в_остатке) desc), '[]'::jsonb)
      into v_rows
      from (
        select ob.participant_id, ob.retreat_id,
               fin_private_person_name(ob.participant_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               sum(case when ob.source_document = 'opening_correction'
                    and ob.correction_reason like 'Пересчёт по прайсу CRM%' then 0
               else ob.amount end) as в_остатке,
               (select coalesce(sum(cp.amount_inr), 0)
                  from crm_payments cp join crm_deals cd on cd.id = cp.deal_id
                 where cd.vaishnava_id = ob.participant_id
                   and cd.retreat_id = ob.retreat_id
                   and cp.is_confirmed
                   and not exists (select 1 from fin_operations o where o.id = cp.id)) as в_платежах
          from fin_participant_opening_balances ob
          join retreats r on r.id = ob.retreat_id
         group by ob.participant_id, ob.retreat_id, r.name_ru, r.name_en
      ) x
     where abs(x.в_платежах - x.в_остатке) > 1 and x.в_платежах > 0
     limit 50;

  elsif p_check = 'advance_double_representation' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('в журнале %s (%s %s, %s), в начальном остатке %s',
                              fin_fmt_money(x.в_журнале, 'INR'),
                              x.сумма, x.валюта, fin_fmt_date_ru(x.дата),
                              fin_fmt_money(x.в_остатке, 'INR')),
             'link', fin_private_participant_link(x.participant_id, x.retreat_id)
           ) order by x.в_журнале desc), '[]'::jsonb)
      into v_rows
      from (
        select cd.vaishnava_id as participant_id, cd.retreat_id,
               fin_private_person_name(cd.vaishnava_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               cp.amount_inr as в_журнале, cp.amount as сумма, cp.currency as валюта,
               coalesce(cp.received_at::date, cp.confirmed_at::date) as дата,
               (select sum(ob.amount) from fin_participant_opening_balances ob
                 where ob.source_row_id = cd.id::text) as в_остатке
          from crm_payments cp
          join crm_deals cd on cd.id = cp.deal_id
          join retreats r on r.id = cd.retreat_id
         where cp.is_confirmed
           and coalesce(cp.received_at::date, cp.confirmed_at::date)
                 < coalesce(fin_cutover_date(), current_date)
           and exists (select 1 from fin_operations o where o.id = cp.id and not o.is_reversed)
           and exists (select 1 from fin_participant_opening_balances ob
                        where ob.source_row_id = cd.id::text)
      ) x
     limit 50;

  elsif p_check = 'advance_missing' then
    -- Платежи подтверждены, но начального остатка нет вовсе: деньги не в учёте
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', x.имя,
             'subtitle', x.ретрит,
             'detail', format('подтверждено %s, в учёте ничего нет — %s',
                              fin_fmt_money(x.в_платежах, 'INR'),
                              case when x.отменён then 'участие отменено'
                                   else 'участие в силе' end),
             'link', fin_private_participant_link(x.participant_id, x.retreat_id),
             'action', jsonb_build_object(
                         'kind', 'resolve_missing_advance',
                         'participant_id', x.participant_id,
                         'retreat_id', x.retreat_id,
                         'cancelled', x.отменён,
                         'amount', fin_fmt_money(x.в_платежах, 'INR'),
                         'who', x.имя)
           ) order by x.в_платежах desc), '[]'::jsonb)
      into v_rows
      from (
        select cd.vaishnava_id as participant_id, cd.retreat_id,
               fin_private_person_name(cd.vaishnava_id) as имя,
               coalesce(r.name_ru, r.name_en) as ретрит,
               sum(cp.amount_inr) as в_платежах,
               bool_and(cd.status::text = 'cancelled') as отменён
          from crm_payments cp
          join crm_deals cd on cd.id = cp.deal_id
          join retreats r on r.id = cd.retreat_id
         where cp.is_confirmed
           and not exists (select 1 from fin_operations o where o.id = cp.id)
           and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp.id)
           and not exists (select 1 from fin_participant_opening_balances ob
                            where ob.participant_id = cd.vaishnava_id
                              and ob.retreat_id = cd.retreat_id)
         group by cd.vaishnava_id, cd.retreat_id, r.name_ru, r.name_en
      ) x
     limit 50;

  elsif p_check = 'unposted_payments' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(cd.vaishnava_id),
             'subtitle', coalesce(r.name_ru, r.name_en),
             'detail', format('%s от %s не разнесён в учёт',
                              fin_fmt_money(cp.amount_inr, 'INR'), fin_fmt_date_ru(cp.received_at::date)),
             'link', 'inbox.html?tab=unposted'
           ) order by cp.amount_inr desc), '[]'::jsonb)
      into v_rows
      from crm_payments cp
      join crm_deals cd on cd.id = cp.deal_id
      join retreats r on r.id = cd.retreat_id
     where cp.is_confirmed
       and coalesce(cp.received_at::date, current_date) >= coalesce(fin_cutover_date(), date '1900-01-01')
       and not exists (select 1 from fin_operations o where o.id = cp.id)
     limit 50;

  elsif p_check = 'charge_amount_wrong' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(c.participant_id),
             'subtitle', format('%s · %s', coalesce(r.name_ru, r.name_en), c.description),
             'detail', format('%s × %s = %s, а в начислении %s',
                              c.quantity, fin_fmt_money(c.unit_price, c.currency_code),
                              fin_fmt_money(round(c.quantity * c.unit_price, 2), c.currency_code),
                              fin_fmt_money(c.amount, c.currency_code)),
             'link', fin_private_participant_link(c.participant_id, c.retreat_id)
           ) order by c.created_at desc), '[]'::jsonb)
      into v_rows
      from (select * from fin_charges
             where abs(amount - quantity*unit_price) > 0.005*abs(quantity) + 0.0051
             limit 50) c
      join retreats r on r.id = c.retreat_id;

  elsif p_check = 'amount_base_wrong' then
    select coalesce(jsonb_agg(fin_private_posting_row(p.id,
             case when p.currency_code = 'INR'
                  then format('проводка в ₹, но курс %s и в ₹ записано %s вместо %s',
                              p.rate_used, fin_fmt_money(p.amount_base, 'INR'), fin_fmt_money(p.amount, 'INR'))
                  else format('%s × курс %s = %s, а в ₹ записано %s',
                              fin_fmt_money(p.amount, p.currency_code), round(p.rate_used, 4),
                              fin_fmt_money(round(p.amount * p.rate_used, 2), 'INR'),
                              fin_fmt_money(p.amount_base, 'INR')) end)), '[]'::jsonb)
      into v_rows
      from (select p.* from fin_postings p
              join fin_operations o on o.id = p.operation_id
              left join fin_operations orig on orig.id = o.original_operation_id
             where o.type not in ('transfer','refund')
               and not (o.type = 'reversal' and orig.type in ('transfer','refund'))
               and ((p.currency_code = 'INR' and (p.rate_used <> 1 or p.amount_base <> p.amount))
                 or (p.currency_code <> 'INR' and abs(p.amount_base - p.amount*p.rate_used) > 0.005*p.rate_used + 0.0051))
             limit 50) p;

  elsif p_check = 'posting_currency_amount' then
    select coalesce(jsonb_agg(fin_private_posting_row(p.id,
             case when p.currency_code <> a.currency_code
                  then format('проводка в %s на счёте в %s', p.currency_code, a.currency_code)
                  else format('сумма %s, в ₹ %s, курс %s', p.amount, p.amount_base, p.rate_used) end)), '[]'::jsonb)
      into v_rows
      from (select p.* from fin_postings p join fin_accounts a on a.id = p.account_id
             where p.currency_code <> a.currency_code or p.amount <= 0 or p.amount_base < 0 or p.rate_used <= 0
             limit 50) p
      join fin_accounts a on a.id = p.account_id;

  elsif p_check = 'participant_kind_mismatch' then
    select coalesce(jsonb_agg(fin_private_posting_row(p.id,
             case when (p.participant_id is null) <> (p.participant_balance_kind is null)
                  then 'участник указан без вида баланса (или наоборот)'
                  else 'участник у перевода / начального остатка / корректировки' end)), '[]'::jsonb)
      into v_rows
      from (select p.* from fin_postings p join fin_operations o on o.id = p.operation_id
             where (p.participant_id is null) <> (p.participant_balance_kind is null)
                or (o.type in ('transfer','opening','reconciliation_adjustment')
                    and (p.participant_id is not null or p.participant_balance_kind is not null))
             limit 50) p;

  elsif p_check = 'post_close_no_object' then
    select coalesce(jsonb_agg(fin_private_posting_row(p.id, 'помечена «после закрытия» без события')), '[]'::jsonb)
      into v_rows
      from (select id from fin_postings where object_id is null and is_post_close limit 50) p;

  elsif p_check = 'reversal_not_zero' then
    select coalesce(jsonb_agg(fin_private_op_row(x.id,
             format('после сторно остаётся %s', fin_fmt_money(x.остаток, 'INR')))), '[]'::jsonb)
      into v_rows
      from (select r.original_operation_id as id,
                   (select sum(case direction when 'in' then amount_base else -amount_base end)
                      from fin_postings where operation_id in (r.id, r.original_operation_id)) as остаток
              from fin_operations r where r.type = 'reversal') x
     where x.остаток <> 0;

  elsif p_check = 'double_reversal' then
    select coalesce(jsonb_agg(fin_private_op_row(x.original_operation_id,
             format('сторнирована %s раза', x.n))), '[]'::jsonb)
      into v_rows
      from (select original_operation_id, count(*) n from fin_operations
             where type = 'reversal' group by 1 having count(*) > 1) x;

  elsif p_check = 'orphan_autopost' then
    select coalesce(jsonb_agg(fin_private_op_row(o.id,
             'платёж CRM удалён — операцию нужно сторнировать или вернуть платёж')), '[]'::jsonb)
      into v_rows
      from (select id from fin_operations o where o.comment like '%Автопроводка%' and not o.is_reversed
               and not exists (select 1 from crm_payments p where p.id = o.id) limit 50) o;

  elsif p_check = 'operation_in_future' then
    select coalesce(jsonb_agg(fin_private_op_row(o.id,
             format('дата операции — %s %s', fin_fmt_date_ru(o.occurred_on), extract(year from o.occurred_on)))), '[]'::jsonb)
      into v_rows
      from (select id, occurred_on from fin_operations where occurred_on > current_date + 1 limit 50) o;

  elsif p_check = 'rate_duplicates' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', format('Курс %s', x.from_currency),
             'subtitle', coalesce((select o.display_name from fin_accounting_objects o where o.id = x.object_id), 'Общий курс'),
             'detail', format('на %s заведён %s раза', fin_fmt_date_ru(x.effective_date), x.n),
             'link', 'dictionaries.html?tab=rates')), '[]'::jsonb)
      into v_rows
      from (select object_id, effective_date, from_currency, count(*) n from fin_exchange_rates
             group by 1,2,3 having count(*) > 1) x;

  elsif p_check = 'currency_cache_drift' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', format('Курс %s', c.code),
             'subtitle', 'CRM против финансов',
             'detail', format('в CRM 1 %s = %s ₹, общий курс финансов — %s ₹', c.code, c.rate_to_inr, x.rate),
             'link', 'dictionaries.html?tab=rates')), '[]'::jsonb)
      into v_rows
      from crm_currencies c
      cross join lateral (select r.rate from fin_exchange_rates r
                           where r.from_currency = c.code and r.object_id is null and r.effective_date <= current_date
                           order by r.effective_date desc limit 1) x
     where c.code <> 'INR' and c.rate_to_inr is distinct from x.rate;

  elsif p_check = 'totals_mismatch' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', fin_private_person_name(d.vaishnava_id),
             'subtitle', coalesce(r.name_ru, r.name_en),
             'detail', format('в сделке оплачено %s / начислено %s, по финансам %s / %s',
                              fin_fmt_money(d.total_paid, 'INR'), fin_fmt_money(d.total_charged, 'INR'),
                              fin_fmt_money(t.o_paid, 'INR'), fin_fmt_money(t.o_charged, 'INR')),
             'link', format('../crm/deal.html?id=%s', d.id))), '[]'::jsonb)
      into v_rows
      from crm_deals d
      cross join lateral crm_calc_deal_totals(d.id) t
      left join retreats r on r.id = d.retreat_id
     where abs(d.total_paid - t.o_paid) > 0.01 or d.total_charged is distinct from t.o_charged;

  elsif p_check = 'shared_login_blocks_portal' then
    -- Одна строка на вход: чей он и какие карточки на нём висят
    select coalesce(jsonb_agg(jsonb_build_object(
             'title', coalesce(x.email, 'вход без почты'),
             'subtitle', format('%s карточки на одном входе', x.n),
             'detail', x.кто,
             'link', format('../vaishnavas/person.html?id=%s', x.first_id))), '[]'::jsonb)
      into v_rows
      from (
        select v.user_id, au.email, count(*) n,
               string_agg(coalesce(nullif(v.spiritual_name, ''), trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')))
                          || ' (заведена ' || fin_fmt_date_ru(v.created_at::date) || ')', ', ' order by v.created_at) as кто,
               (array_agg(v.id order by v.created_at))[1] as first_id
          from vaishnavas v
          left join auth.users au on au.id = v.user_id
         where v.user_id in (
           select v.user_id from vaishnavas v where v.user_id is not null group by v.user_id
           having count(*) > 1
              and bool_or(exists (select 1 from fin_charges c where c.participant_id = v.id)
                       or exists (select 1 from fin_participant_opening_balances ob where ob.participant_id = v.id)
                       or exists (select 1 from fin_postings p where p.participant_id = v.id))
              and exists (select 1 from vaishnavas v1 where v1.user_id = v.user_id
                           and not exists (select 1 from family_links fl
                                             join vaishnavas v2 on v2.id = case when fl.vaishnava_id = v1.id then fl.relative_id else fl.vaishnava_id end
                                            where (fl.vaishnava_id = v1.id or fl.relative_id = v1.id) and v2.user_id = v.user_id)))
         group by v.user_id, au.email
      ) x;

  else
    v_rows := '[]'::jsonb;   -- неизвестная проверка: страница покажет «расшифровки нет»
  end if;

  return jsonb_build_object('ok', true, 'result', v_rows);
end;
$function$;
revoke all on function public.fin_get_integrity_details(text) from public, anon;
grant execute on function public.fin_get_integrity_details(text) to authenticated, service_role;

-- ============ Плашка «нет курса ретрита» ============
-- Свой ретрит (не сторонний, не «Гости без события»), ещё не закончился, своего
-- курса нет, а деньги в другой валюте уже пришли — они ждут курса (582).
-- Или курса нет вовсе, а до начала меньше 30 дней и есть записавшиеся.
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
   where x.ждут is not null
      or (not x.есть_курс and x.людей > 0 and x.start_date <= current_date + 30);

  return jsonb_build_object('ok', true, 'result', v_rows);
end;
$$;
revoke all on function public.fin_get_retreats_without_rate() from public, anon;
grant execute on function public.fin_get_retreats_without_rate() to authenticated;
