-- 582: фаза 2, шаг 5 (ВГ, 29.09).
--
-- 1. Предоплата в другой валюте ждёт курса ретрита. Приём — движение денег
--    в своей валюте; ₹ для ДДС по общему курсу на дату (579). Засчитать
--    деньги другой валюты в долг гостя — только по курсу ретрита: пока у
--    нашего ретрита нет своего курса и он не начался, засчитанная сумма не
--    создаётся, деньги ждут. Засчитываются при выборе валюты расчёта или
--    кнопкой в карточке, когда курс заведён. Сторонние мероприятия и «Гости
--    без события» не ждут — у них общий курс (ВГ, 28.09).
-- 2. Итоги в ₹ (баланс v1 → должники, отчёт ретрита; итоги сделки CRM;
--    проверка целостности) переводят стартовые остатки и начисления не в ₹
--    по курсу события (свой, иначе общий на дату). У Сева-ретрита всё в ₹ —
--    ничего не меняется.
-- 3. Отчёт ретрита: «Начислено · Оплачено» учитывают стартовые остатки и
--    оплаты без привязки к блоку (сообщение «Задачи кухни 8», 29.09) — на
--    Сева-ретрите не было видно ₹1,29 млн оплат до запуска финмодуля.
-- 4. 14 стартовых авансов Лила-киртана 2027 — в исходной валюте платежа
--    CRM (₽/$) вместо ₹.
--
-- Функции правятся заменой фрагментов по тексту из базы: каждая замена
-- обязана найтись, иначе миграция падает целиком.

-- ============ Помощники ============
create or replace function fin_private_settle_waits(p_retreat uuid, p_from text, p_to text, p_on date)
returns boolean
language sql stable security definer set search_path to 'public' as $$
  select p_from <> p_to
     and not coalesce(r.is_external, false)
     and p_on < r.start_date
     and exists (select 1 from unnest(array[p_from, p_to]) c
                  where c <> 'INR'
                    and not exists (select 1 from fin_exchange_rates x
                                     where x.object_id = o.id and x.from_currency = c))
    from retreats r join fin_accounting_objects o on o.retreat_id = r.id
   where r.id = p_retreat;
$$;

create or replace function fin_private_to_inr(p_amount numeric, p_currency text, p_retreat uuid, p_on date)
returns numeric
language sql stable security definer set search_path to 'public' as $$
  select case when p_currency = 'INR' or p_amount = 0 then p_amount
              else round(p_amount * fin_private_retreat_rate(
                     p_currency, (select id from fin_accounting_objects where retreat_id = p_retreat), p_on), 2) end;
$$;

revoke all on function fin_private_settle_waits(uuid, text, text, date) from public, anon, authenticated;
revoke all on function fin_private_to_inr(numeric, text, uuid, date) from public, anon, authenticated;

-- ============ Точечные замены ============
do $mig$
declare
  v_def text;
  v_new text;
  procedure_patch record;
begin
  create temp table _patch (fn text, ord int, old text, new text) on commit drop;

  -- 1а. Приём: без курса ретрита до начала — засчитанная сумма не создаётся
  insert into _patch values
  ('fin_create_payment', 1,
   E'ELSE\nv_rate_to := fin_private_retreat_rate(v_settle, (r->>''object_id'')::uuid, v_on);',
   E'ELSIF NOT (r ? ''settle_amount'') AND fin_private_settle_waits(v_ret, v_acc.currency_code, v_settle, v_on) THEN\nNULL; -- ждёт курса ретрита (582)\nELSE\nv_rate_to := fin_private_retreat_rate(v_settle, (r->>''object_id'')::uuid, v_on);');

  -- 1б. Выбор валюты расчёта: деньги, ждущие курса ретрита, не засчитываются
  insert into _patch values
  ('fin_private_apply_settlement_currency', 1,
   E'v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);\ninsert into fin_settlement_credits (posting_id,',
   E'if fin_private_settle_waits(p_retreat, rec.currency_code, p_currency, p_on) then continue; end if;\nv_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);\ninsert into fin_settlement_credits (posting_id,'),
  ('fin_private_apply_settlement_currency', 2,
   E'v_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);\ninsert into fin_settlement_credits (opening_id,',
   E'if fin_private_settle_waits(p_retreat, rec.currency_code, p_currency, p_on) then continue; end if;\nv_rate_from := fin_private_retreat_rate(rec.currency_code, v_obj, p_on);\ninsert into fin_settlement_credits (opening_id,');

  -- 1в. Баланс v2: ждущие деньги — отдельной пометкой, не «не засчитан»
  insert into _patch values
  ('fin_private_participant_balance_v2', 1,
   E'''code'', ''unconverted_opening'', ''id'', rec.id,\n''message'', format(''Стартовый остаток %s %s не засчитан в %s'', rec.amount, rec.c, v_cur)));',
   E'''code'', case when fin_private_settle_waits(p_retreat, rec.c, v_cur, current_date) then ''awaiting_retreat_rate'' else ''unconverted_opening'' end, ''id'', rec.id,\n''message'', case when fin_private_settle_waits(p_retreat, rec.c, v_cur, current_date)\n  then format(''Предоплата %s %s засчитается в %s по курсу ретрита — курс ещё не заведён'', rec.amount, rec.c, v_cur)\n  else format(''Стартовый остаток %s %s не засчитан в %s'', rec.amount, rec.c, v_cur) end));'),
  ('fin_private_participant_balance_v2', 2,
   E'''code'', ''unconverted_payment'', ''id'', rec.id,\n''message'', format(''Платёж %s %s не засчитан в %s'', rec.amount, rec.c, v_cur)));',
   E'''code'', case when fin_private_settle_waits(p_retreat, rec.c, v_cur, current_date) then ''awaiting_retreat_rate'' else ''unconverted_payment'' end, ''id'', rec.id,\n''message'', case when fin_private_settle_waits(p_retreat, rec.c, v_cur, current_date)\n  then format(''Предоплата %s %s засчитается в %s по курсу ретрита — курс ещё не заведён'', rec.amount, rec.c, v_cur)\n  else format(''Платёж %s %s не засчитан в %s'', rec.amount, rec.c, v_cur) end));');

  -- 2а. Баланс v1: начисления и старты не в ₹ — в ₹ по курсу события;
  --     плюс «без блока» отдельно для отчёта ретрита (3)
  insert into _patch values
  ('fin_private_participant_balance', 1,
   'SUM(amount - discount_amount) AS s',
   'SUM(fin_private_to_inr(amount - discount_amount, currency_code, retreat_id, coalesce(occurred_on, created_at::date))) AS s'),
  ('fin_private_participant_balance', 2,
   'SELECT balance_kind::text AS bk, kind::text AS k, SUM(amount) AS s',
   'SELECT balance_kind::text AS bk, kind::text AS k, SUM(fin_private_to_inr(amount, currency_code, retreat_id, created_at::date)) AS s'),
  ('fin_private_participant_balance', 3,
   E'  v_result jsonb := ''{}''::jsonb;',
   E'  v_result jsonb := ''{}''::jsonb;\n  v_gen_charged numeric;\n  v_gen_paid numeric;'),
  ('fin_private_participant_balance', 4,
   '  -- стартовые general-кредит и general-долг',
   E'  v_gen_charged := v_general_debt;\n  v_gen_paid := v_general_credit + v_general_signed;\n\n  -- стартовые general-кредит и general-долг'),
  ('fin_private_participant_balance', 5,
   E'    ''quick_net'', v_quick\n',
   E'    ''quick_net'', v_quick,\n    ''general_charged'', v_gen_charged,\n    ''general_paid'', v_gen_paid\n');

  -- 3. Отчёт ретрита: «Начислено · Оплачено» с суммами без блока
  insert into _patch values
  ('fin_private_build_snapshot', 1,
   E'FROM unnest(ARRAY[''org_fee'',''accommodation'',''meals'',''extra'']) k;',
   E'FROM unnest(ARRAY[''org_fee'',''accommodation'',''meals'',''extra'']) k;\n      v_charged := v_charged + COALESCE((v_bal->>''general_charged'')::numeric, 0);\n      v_paid := v_paid + COALESCE((v_bal->>''general_paid'')::numeric, 0);');

  -- 2б. Итоги сделки CRM (₹)
  insert into _patch values
  ('crm_calc_deal_totals', 1,
   'SELECT COALESCE(SUM(amount - discount_amount), 0) INTO v_fin_charged',
   'SELECT COALESCE(SUM(fin_private_to_inr(amount - discount_amount, currency_code, retreat_id, coalesce(occurred_on, created_at::date))), 0) INTO v_fin_charged'),
  ('crm_calc_deal_totals', 2,
   'THEN amount ELSE 0 END',
   'THEN fin_private_to_inr(amount, currency_code, retreat_id, created_at::date) ELSE 0 END');

  -- 2в. Проверка «старты = платежи CRM до запуска» — в ₹
  insert into _patch values
  ('fin_run_integrity_checks', 1,
   'round(SUM(amount),2) AS ob FROM fin_participant_opening_balances',
   'round(SUM(fin_private_to_inr(amount, currency_code, retreat_id, created_at::date)),2) AS ob FROM fin_participant_opening_balances');

  for procedure_patch in select distinct fn from _patch loop
    v_def := pg_get_functiondef(procedure_patch.fn::regproc);
    v_new := v_def;
    declare p record; begin
      for p in select * from _patch where fn = procedure_patch.fn order by ord loop
        if position(p.old in v_new) = 0 then
          raise exception 'patch_not_found: % #%', p.fn, p.ord;
        end if;
        v_new := replace(v_new, p.old, p.new);
      end loop;
    end;
    execute v_new;
  end loop;
end $mig$;

-- ============ 4. Стартовые авансы Лила-киртана 2027 — в валюте платежа CRM ============
-- 13 × ₽ (6 × 24 000, 4 × 10 000, 3 × 5 000) и $149 — по одному платежу CRM
-- на каждого, суммы совпадают 1:1 (проверено 29.09). Засчитанных сумм и
-- выбранных валют расчёта у события нет. ₹ в итогах не меняются: общий курс
-- на 04.08 — 1,15 и 97, по ним старты и заводились.
update fin_participant_opening_balances b
   set currency_code = cp.currency,
       amount = cp.amount,
       comment = b.comment || ' · 29.09: в валюте платежа CRM (фаза 2), было ₹' || b.amount
  from crm_deals d
  join crm_payments cp on cp.deal_id = d.id and cp.is_confirmed
 where b.retreat_id = '059b86b3-7411-4343-a46a-10bbb5e18e08'
   and b.currency_code = 'INR'
   and b.corrects_opening_balance_id is null
   and d.retreat_id = b.retreat_id and d.vaishnava_id = b.participant_id
   and cp.received_at::date < '2026-08-04'::date + 1
   and cp.amount_inr = b.amount
   and cp.currency in ('RUB', 'USD');
