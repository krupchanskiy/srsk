-- Сторож целостности финмодуля: ночная проверка инвариантов из ТЗ + автопроводки.
-- Превращает разовые проверки ночного тестирования в постоянный автотест —
-- ловит регрессии, которые невозможно предусмотреть руками, ДО того как они
-- дойдут до людей. Нарушение фиксируется в fin_integrity_alerts; открытый alert
-- виден на дашборде (бейдж) и может дублироваться в Telegram отдельным шагом.

CREATE TABLE IF NOT EXISTS fin_integrity_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_name text NOT NULL,
  detail text NOT NULL,
  bad_count bigint NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (check_name, detected_at)
);
CREATE INDEX IF NOT EXISTS idx_fin_integrity_open ON fin_integrity_alerts (detected_at DESC) WHERE resolved_at IS NULL;

ALTER TABLE fin_integrity_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Integrity alerts read fin staff" ON fin_integrity_alerts;
CREATE POLICY "Integrity alerts read fin staff" ON fin_integrity_alerts
  FOR SELECT TO authenticated USING (fin_can_read_all((SELECT auth.uid())));

COMMENT ON TABLE fin_integrity_alerts IS
'Нарушения инвариантов финмодуля, найденные ночным сторожем fin_run_integrity_checks(). Открытый (resolved_at IS NULL) alert = данные разошлись с ТЗ.';

-- Каталог проверок: имя, человекочитаемое описание, запрос, считающий «плохие» строки.
-- Каждый инвариант из ночного аудита + специфичные для интеграции CRM↔финмодуль.
CREATE OR REPLACE FUNCTION public.fin_run_integrity_checks()
RETURNS TABLE (check_name text, bad_count bigint, detail text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  chk record;
  v_count bigint;
  checks jsonb := jsonb_build_array(
    jsonb_build_object('name','posting_currency_amount',
      'detail','Проводки: валюта ≠ валюте счёта, или amount≤0, или rate_used≤0',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_accounts a ON a.id=p.account_id WHERE p.currency_code<>a.currency_code OR p.amount<=0 OR p.amount_base<0 OR p.rate_used<=0'),
    jsonb_build_object('name','amount_base_wrong',
      'detail','amount_base не равен amount×rate_used (кроме transfer/refund с наследованием)',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_operations o ON o.id=p.operation_id WHERE o.type NOT IN (''transfer'',''refund'') AND ((p.currency_code=''INR'' AND (p.rate_used<>1 OR p.amount_base<>p.amount)) OR (p.currency_code<>''INR'' AND p.amount_base<>round(p.amount*p.rate_used,2)))'),
    jsonb_build_object('name','reversal_not_zero',
      'detail','Сторно-пара не гасится в ноль по деньгам или рупиям',
      'sql','SELECT count(*) FROM fin_operations r WHERE r.type=''reversal'' AND (SELECT COALESCE(SUM(CASE direction WHEN ''in'' THEN amount_base ELSE -amount_base END),0) FROM fin_postings WHERE operation_id IN (r.id, r.original_operation_id))<>0'),
    jsonb_build_object('name','double_reversal',
      'detail','На одну операцию больше одного активного сторно',
      'sql','SELECT count(*) FROM (SELECT original_operation_id FROM fin_operations WHERE type=''reversal'' GROUP BY 1 HAVING count(*)>1) x'),
    jsonb_build_object('name','charge_amount_wrong',
      'detail','Сумма начисления не равна quantity×unit_price',
      'sql','SELECT count(*) FROM fin_charges WHERE amount<>round(quantity*unit_price,2)'),
    jsonb_build_object('name','participant_kind_mismatch',
      'detail','participant_id и participant_balance_kind рассогласованы, или недопустимы для типа операции',
      'sql','SELECT count(*) FROM fin_postings p JOIN fin_operations o ON o.id=p.operation_id WHERE (p.participant_id IS NULL)<>(p.participant_balance_kind IS NULL) OR (o.type IN (''transfer'',''opening'',''reconciliation_adjustment'') AND (p.participant_id IS NOT NULL OR p.participant_balance_kind IS NOT NULL))'),
    jsonb_build_object('name','rate_duplicates',
      'detail','Дубли курса на одну пару (объект, дата, валюта)',
      'sql','SELECT count(*) FROM (SELECT object_id, effective_date, from_currency FROM fin_exchange_rates GROUP BY 1,2,3 HAVING count(*)>1) x'),
    jsonb_build_object('name','post_close_no_object',
      'detail','is_post_close=true у проводки без объекта учёта',
      'sql','SELECT count(*) FROM fin_postings WHERE object_id IS NULL AND is_post_close'),
    -- Интеграционные инварианты
    jsonb_build_object('name','totals_mismatch',
      'detail','total_paid/total_charged сделки разошлись с формулой финмодуля',
      'sql','SELECT count(*) FROM crm_deals d, LATERAL crm_calc_deal_totals(d.id) t WHERE abs(d.total_paid - t.o_paid) > 0.01 OR d.total_charged IS DISTINCT FROM t.o_charged'),
    jsonb_build_object('name','orphan_autopost',
      'detail','Операция автопроводки без CRM-платежа-исходника (кроме законно сторнированных)',
      'sql','SELECT count(*) FROM fin_operations o WHERE o.comment LIKE ''%Автопроводка%'' AND NOT o.is_reversed AND NOT EXISTS (SELECT 1 FROM crm_payments p WHERE p.id=o.id)'),
    jsonb_build_object('name','unposted_payments',
      'detail','Платежи подтверждены в CRM, но не разнесены в финмодуль',
      'sql','SELECT count(*) FROM crm_payments cp WHERE cp.is_confirmed AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=cp.id) AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id=cp.id)'),
    jsonb_build_object('name','currency_cache_drift',
      'detail','Кэш курса crm_currencies разошёлся с актуальным глобальным курсом финмодуля',
      'sql','SELECT count(*) FROM crm_currencies c WHERE c.code<>''INR'' AND c.rate_to_inr IS DISTINCT FROM (SELECT rate FROM fin_exchange_rates r WHERE r.from_currency=c.code AND r.object_id IS NULL AND r.effective_date<=CURRENT_DATE ORDER BY r.effective_date DESC LIMIT 1)')
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

-- Ночной прогон: пишет открытые alert-ы, закрывает разрешившиеся.
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
      -- открыт ли уже alert по этой проверке?
      IF NOT EXISTS (SELECT 1 FROM fin_integrity_alerts a
                     WHERE a.check_name = r.check_name AND a.resolved_at IS NULL) THEN
        INSERT INTO fin_integrity_alerts (check_name, detail, bad_count, detected_at)
        VALUES (r.check_name, r.detail, r.bad_count, v_now);
      END IF;
    ELSE
      -- проблема ушла — закрываем открытый alert
      UPDATE fin_integrity_alerts SET resolved_at = v_now
      WHERE check_name = r.check_name AND resolved_at IS NULL;
    END IF;
  END LOOP;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_integrity_sweep() FROM PUBLIC, anon, authenticated;

-- Ежедневный прогон в 02:30 IST (21:00 UTC пред. дня — глубокая ночь в Индии).
-- Отдельно от fin-cleanup (21:30 UTC), чистый SQL — Edge Function не нужна.
SELECT cron.unschedule('fin-integrity-sweep')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fin-integrity-sweep');
SELECT cron.schedule('fin-integrity-sweep', '0 21 * * *', $$SELECT public.fin_integrity_sweep()$$);

-- Витрина открытых нарушений для дашборда
CREATE OR REPLACE VIEW public.fin_v_integrity_open
WITH (security_invoker = true) AS
SELECT check_name, detail, bad_count, detected_at
FROM fin_integrity_alerts
WHERE resolved_at IS NULL
ORDER BY detected_at DESC;
REVOKE ALL ON public.fin_v_integrity_open FROM anon;
GRANT SELECT ON public.fin_v_integrity_open TO authenticated;
