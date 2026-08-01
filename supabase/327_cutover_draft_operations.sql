-- Заявка из чата порождает несколько операций (см. 324): связь между заявкой
-- и её операциями обязана переживать перенос вместе с ними. Без этого
-- fin_cutover_reset падает на внешнем ключе, удаляя fin_operations раньше
-- связей, а восстановление из снимка теряет историю проведения.

CREATE OR REPLACE FUNCTION public.fin_cutover_snapshot()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tables text[] := ARRAY[
    'fin_operations','fin_postings','fin_charges','fin_participant_opening_balances',
    'fin_reconciliations','fin_attachments','fin_object_closures','fin_audit_log',
    'fin_crm_autopost_log','fin_integrity_alerts','tg_log','tg_drafts','tg_incoming','tg_draft_operations'];
  v_t text; v_n bigint; v_total bigint := 0; v_counts jsonb := '{}'::jsonb;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  DROP SCHEMA IF EXISTS cutover_snapshot CASCADE;
  CREATE SCHEMA cutover_snapshot;

  FOREACH v_t IN ARRAY v_tables LOOP
    EXECUTE format('CREATE TABLE cutover_snapshot.%I AS SELECT * FROM public.%I', v_t, v_t);
    EXECUTE format('SELECT count(*) FROM cutover_snapshot.%I', v_t) INTO v_n;
    v_counts := v_counts || jsonb_build_object(v_t, v_n);
    v_total := v_total + v_n;
  END LOOP;

  -- значение боевой последовательности и метка времени
  CREATE TABLE cutover_snapshot._meta AS
  SELECT now() AS taken_at,
         auth.uid() AS taken_by,
         (SELECT last_value FROM fin_ledger_seq) AS ledger_seq,
         (SELECT count(*) FROM fin_accounts) AS accounts_kept;

  -- «грязные» отчёты: reset их обнуляет, для возврата нужно помнить
  CREATE TABLE cutover_snapshot._objects_dirty AS
  SELECT id, report_dirty_at FROM fin_accounting_objects;

  RETURN jsonb_build_object('ok', true, 'total_rows', v_total, 'tables', v_counts);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fin_cutover_restore(p_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order text[] := ARRAY[
    'fin_operations','fin_postings','fin_charges','fin_participant_opening_balances',
    'fin_reconciliations','fin_attachments','fin_object_closures','fin_audit_log',
    'fin_crm_autopost_log','fin_integrity_alerts','tg_log','tg_drafts','tg_incoming','tg_draft_operations'];
  v_t text; v_seq bigint; v_total bigint := 0; v_n bigint;
  v_ident text; v_override text; v_identseq text;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_confirm IS DISTINCT FROM 'ВОССТАНОВИТЬ ИЗ СНИМКА' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Нужно подтверждение: передайте строку «ВОССТАНОВИТЬ ИЗ СНИМКА»');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='cutover_snapshot') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Снимка нет — восстанавливать не из чего');
  END IF;

  ALTER TABLE fin_postings   DISABLE TRIGGER trg_fin_postings_guard;
  ALTER TABLE fin_postings   DISABLE TRIGGER trg_fin_postings_validate;
  ALTER TABLE fin_operations DISABLE TRIGGER trg_fin_operations_guard;
  ALTER TABLE fin_audit_log  DISABLE TRIGGER trg_fin_audit_immutable;
  ALTER TABLE fin_operations                   DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_postings                     DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_reconciliations              DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_charges                      DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_participant_opening_balances DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_attachments                  DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_object_closures              DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_accounting_objects           DISABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_postings                     DISABLE TRIGGER trg_tg_negative_balance;
  ALTER TABLE fin_postings                     DISABLE TRIGGER trg_tg_notify_dept_credit;
  ALTER TABLE fin_postings                     DISABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_charges                      DISABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_participant_opening_balances DISABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_crm_autopost_log             DISABLE TRIGGER trg_tg_autopost_error;
  ALTER TABLE fin_integrity_alerts             DISABLE TRIGGER trg_tg_integrity_alert;

  FOR v_t IN SELECT unnest FROM unnest(v_order) WITH ORDINALITY t(unnest, ord) ORDER BY ord DESC LOOP
    EXECUTE format('DELETE FROM public.%I', v_t);
  END LOOP;

  FOREACH v_t IN ARRAY v_order LOOP
    -- есть ли колонка GENERATED ALWAYS AS IDENTITY
    SELECT a.attname INTO v_ident
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', v_t)::regclass
      AND a.attidentity = 'a' AND a.attnum > 0 AND NOT a.attisdropped
    LIMIT 1;

    v_override := CASE WHEN v_ident IS NOT NULL THEN ' OVERRIDING SYSTEM VALUE' ELSE '' END;
    EXECUTE format('INSERT INTO public.%I%s SELECT * FROM cutover_snapshot.%I',
                   v_t, v_override, v_t);

    IF v_ident IS NOT NULL THEN
      -- иначе следующая запись столкнётся с восстановленной
      v_identseq := pg_get_serial_sequence(format('public.%I', v_t), v_ident);
      IF v_identseq IS NOT NULL THEN
        EXECUTE format('SELECT setval(%L, COALESCE((SELECT max(%I) FROM public.%I), 1))',
                       v_identseq, v_ident, v_t);
      END IF;
    END IF;
    v_ident := NULL;

    EXECUTE format('SELECT count(*) FROM public.%I', v_t) INTO v_n;
    v_total := v_total + v_n;
  END LOOP;

  EXECUTE 'SELECT ledger_seq FROM cutover_snapshot._meta' INTO v_seq;
  PERFORM setval('fin_ledger_seq', GREATEST(v_seq, 1));

  UPDATE fin_accounting_objects o
     SET report_dirty_at = d.report_dirty_at
    FROM cutover_snapshot._objects_dirty d WHERE d.id = o.id;

  ALTER TABLE fin_postings   ENABLE TRIGGER trg_fin_postings_guard;
  ALTER TABLE fin_postings   ENABLE TRIGGER trg_fin_postings_validate;
  ALTER TABLE fin_operations ENABLE TRIGGER trg_fin_operations_guard;
  ALTER TABLE fin_audit_log  ENABLE TRIGGER trg_fin_audit_immutable;
  ALTER TABLE fin_operations                   ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_postings                     ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_reconciliations              ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_charges                      ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_participant_opening_balances ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_attachments                  ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_object_closures              ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_accounting_objects           ENABLE TRIGGER trg_fin_audit;
  ALTER TABLE fin_postings                     ENABLE TRIGGER trg_tg_negative_balance;
  ALTER TABLE fin_postings                     ENABLE TRIGGER trg_tg_notify_dept_credit;
  ALTER TABLE fin_postings                     ENABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_charges                      ENABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_participant_opening_balances ENABLE TRIGGER trg_resync_deal_totals;
  ALTER TABLE fin_crm_autopost_log             ENABLE TRIGGER trg_tg_autopost_error;
  ALTER TABLE fin_integrity_alerts             ENABLE TRIGGER trg_tg_integrity_alert;

  -- пересчитываем суммы сделок: во время возврата триггер отключён,
  -- а reset до этого успел пересчитать их на пустой журнал
  UPDATE crm_deals d SET total_paid = c.o_paid, total_charged = c.o_charged
  FROM (SELECT x.id, (crm_calc_deal_totals(x.id)).* FROM crm_deals x) c
  WHERE c.id = d.id
    AND (d.total_paid IS DISTINCT FROM c.o_paid OR d.total_charged IS DISTINCT FROM c.o_charged);

  RETURN jsonb_build_object('ok', true, 'restored_rows', v_total, 'ledger_seq', v_seq);
END;
$function$
;
