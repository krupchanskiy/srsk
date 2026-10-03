-- Фаза 2, шаг 8 (часть 3): авансы из CRM — в валюте платежа, не в ₹.
-- 1. fin_resolve_missing_advance («добор» стартового остатка по сигналу): новая система —
--    по строке на сделку и валюту, сумма в валюте платежа; Сева-ретрит — как было (₹).
-- 2. fin_load_crm_advances / fin_preview_crm_advances (разовая загрузка рубежа) — только
--    старая система: на новых событиях стартовый остаток в ₹ по курсу CRM — тот самый хвост;
--    там подтверждённое до рубежа добирается сигналом (п. 1).
-- 3. Сигналы целостности: суммы гостю — в валюте платежа / валюте итогов сделки.
-- Функции правятся заменой фрагментов по тексту из базы; каждая замена обязана найтись.

do $mig$
declare d text; n text;
begin
  -- 1. добор
  d := pg_get_functiondef('fin_resolve_missing_advance(jsonb)'::regprocedure);
  n := replace(d, E'  v_batch       uuid;\n', E'  v_batch       uuid;\n  v_legacy      boolean;\n');
  n := replace(n,
E'    SELECT ob.cutover_batch_id INTO v_batch',
E'    -- мигр. 638: новая система — в валюте платежа; Сева-ретрит (всё в ₹) — как было
    SELECT coalesce(o.legacy_inr_settlement, true) INTO v_legacy
      FROM retreats r LEFT JOIN fin_accounting_objects o ON o.retreat_id = r.id
     WHERE r.id = v_retreat;

    SELECT ob.cutover_batch_id INTO v_batch');
  n := replace(n,
E'      SELECT cd.id AS deal_id,
             sum(cp.amount_inr) AS сумма,
             count(*) AS платежей,
             string_agg(cp.amount || '' '' || cp.currency, '', '' ORDER BY cp.received_at) AS расшифровка
        FROM crm_payments cp
        JOIN crm_deals cd ON cd.id = cp.deal_id
       WHERE cp.id = ANY (v_ids)
       GROUP BY cd.id',
E'      SELECT cd.id AS deal_id,
             CASE WHEN v_legacy THEN ''INR'' ELSE cp.currency END AS валюта,
             sum(CASE WHEN v_legacy THEN cp.amount_inr ELSE cp.amount END) AS сумма,
             count(*) AS платежей,
             string_agg(cp.amount || '' '' || cp.currency, '', '' ORDER BY cp.received_at) AS расшифровка
        FROM crm_payments cp
        JOIN crm_deals cd ON cd.id = cp.deal_id
       WHERE cp.id = ANY (v_ids)
       GROUP BY cd.id, 2');
  n := replace(n,
E'        fin_private_child_uuid(v_request_id, d.deal_id::text),
        v_participant, v_retreat, d.сумма, ''INR'', ''credit'', ''general'',
        ''Добор к загрузке рубежа: платёж подтверждён позже'',',
E'        fin_private_child_uuid(v_request_id, d.deal_id::text || CASE WHEN v_legacy THEN '''' ELSE '':'' || d.валюта END),
        v_participant, v_retreat, d.сумма, d.валюта, ''credit'', ''general'',
        ''Добор к загрузке рубежа: платёж подтверждён позже'' || CASE WHEN v_legacy THEN '''' ELSE '' ('' || d.валюта || '')'' END,');
  n := replace(n,
E'          ''deal_id'', lower(d.deal_id::text),',
E'          ''deal_id'', lower(d.deal_id::text),
          ''currency'', CASE WHEN v_legacy THEN NULL ELSE d.валюта END,');
  if n = d or n !~ 'd\.валюта, ''credit''' or n !~ 'v_legacy      boolean' or n !~ '''currency'', CASE WHEN v_legacy'
     or n ~ 'sum\(cp\.amount_inr\) AS сумма' or n !~ 'INTO v_legacy' then
    raise exception 'resolve: шаблон не найден';
  end if;
  execute n;

  -- 2. разовая загрузка рубежа — только старая система
  d := pg_get_functiondef('fin_load_crm_advances()'::regprocedure);
  n := replace(d,
E'    WHERE d.status <> ''cancelled''
      AND d.vaishnava_id IS NOT NULL',
E'    WHERE d.status <> ''cancelled''
      AND d.vaishnava_id IS NOT NULL
      -- мигр. 638: в ₹ — только Сева-ретрит; новые события добирают сигналом в валюте платежа
      AND EXISTS (SELECT 1 FROM fin_accounting_objects ao
                  WHERE ao.retreat_id = d.retreat_id AND ao.legacy_inr_settlement)');
  if n = d then raise exception 'load: шаблон не найден'; end if;
  execute n;

  d := pg_get_functiondef('fin_preview_crm_advances()'::regprocedure);
  n := replace(d,
E'    AND d.status <> ''cancelled''',
E'    AND d.status <> ''cancelled''
    AND EXISTS (SELECT 1 FROM fin_accounting_objects ao
                WHERE ao.retreat_id = d.retreat_id AND ao.legacy_inr_settlement)');
  if n = d then raise exception 'preview: шаблон не найден'; end if;
  execute n;

  -- 3. тексты сигналов
  d := pg_get_functiondef('fin_get_integrity_details(text)'::regprocedure);
  n := replace(d,
E'             ''detail'', format(''подтверждено %s, в учёте ничего нет — %s'',
                              fin_fmt_money(x.в_платежах, ''INR''),',
E'             ''detail'', format(''подтверждено %s, в учёте ничего нет — %s'',
                              x.по_валютам,');
  n := replace(n,
E'                         ''amount'', fin_fmt_money(x.в_платежах, ''INR''),',
E'                         ''amount'', x.по_валютам,');
  n := replace(n,
E'               sum(cp.amount_inr) as в_платежах,
               bool_and(cd.status::text = ''cancelled'') as отменён
          from crm_payments cp',
E'               sum(cp.amount_inr) as в_платежах,
               -- мигр. 638: гостю — в валюте платежа, без пересчёта
               (select string_agg(fin_fmt_money(v.s, v.c), '' + '' order by v.c)
                  from (select cp2.currency c, sum(cp2.amount) s
                          from crm_payments cp2 join crm_deals cd2 on cd2.id = cp2.deal_id
                         where cd2.vaishnava_id = cd.vaishnava_id and cd2.retreat_id = cd.retreat_id
                           and cp2.is_confirmed
                           and not exists (select 1 from fin_operations o where o.id = cp2.id)
                           and not exists (select 1 from fin_payment_dispositions pd where pd.payment_id = cp2.id)
                         group by cp2.currency) v) as по_валютам,
               bool_and(cd.status::text = ''cancelled'') as отменён
          from crm_payments cp');
  n := replace(n,
E'                              fin_fmt_money(cp.amount_inr, ''INR''), fin_fmt_date_ru(cp.received_at::date)),',
E'                              fin_fmt_money(cp.amount, cp.currency), fin_fmt_date_ru(cp.received_at::date)),');
  n := replace(n,
E'                              fin_fmt_money(d.total_paid, ''INR''), fin_fmt_money(d.total_charged, ''INR''),
                              fin_fmt_money(t.o_paid, ''INR''), fin_fmt_money(t.o_charged, ''INR'')),',
E'                              fin_fmt_money(d.total_paid, d.totals_currency), fin_fmt_money(d.total_charged, d.totals_currency),
                              fin_fmt_money(t.o_paid, d.totals_currency), fin_fmt_money(t.o_charged, d.totals_currency)),');
  if n = d or n ~ 'fin_fmt_money\(x\.в_платежах' or n !~ 'as по_валютам' or n !~ 'fin_fmt_money\(cp\.amount, cp\.currency\), fin_fmt_date_ru'
     or n !~ 'd\.total_paid, d\.totals_currency' then
    raise exception 'integrity: шаблон не найден';
  end if;
  execute n;
end $mig$;
