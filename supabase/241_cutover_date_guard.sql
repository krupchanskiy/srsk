-- =============================================================
-- Защита от двойного счёта на переходе (план запуска, 23.07.2026).
--
-- Опасение ВГ дословно: «если мы внесём сумму подтверждения к выписке
-- со счёта, то они добавятся поверх счёта и задублируются». Именно так
-- и случилось бы: остаток по выписке на дату запуска уже содержит все
-- старые платежи, и подтверждение любого из них после запуска добавило
-- бы деньги второй раз.
--
-- Механика: в системе появляется дата запуска (fin_settings.cutover_date).
-- Платёж, полученный ДО неё, при подтверждении в учёт не проводится —
-- автопроводка помечает его «учтено в начальных остатках» (skipped).
-- Подтверждать старые платежи можно спокойно, для истории; счёт и
-- фактическую сумму для них указывать не нужно. Аванс участника по таким
-- платежам входит отдельной загрузкой fin_load_opening_balances.
-- =============================================================

CREATE TABLE IF NOT EXISTS fin_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fin_settings ENABLE ROW LEVEL SECURITY;  -- политик нет: только definer-функции
REVOKE ALL ON fin_settings FROM PUBLIC, anon, authenticated;

INSERT INTO fin_settings (key, value) VALUES ('cutover_date', '2026-08-01')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE fin_settings IS
'Настройки финмодуля. cutover_date — дата запуска: платежи, полученные раньше, учтены в начальных остатках и автопроводкой не проводятся.';

-- Дата запуска — читаемая всем вошедшим (не секрет, нужна интерфейсу)
CREATE OR REPLACE FUNCTION public.fin_cutover_date()
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$ SELECT value::date FROM fin_settings WHERE key = 'cutover_date' $$;
REVOKE ALL ON FUNCTION public.fin_cutover_date() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_cutover_date() TO authenticated;

-- Журнал автопроводки: новый статус skipped
ALTER TABLE fin_crm_autopost_log DROP CONSTRAINT IF EXISTS fin_crm_autopost_log_status_check;
ALTER TABLE fin_crm_autopost_log ADD CONSTRAINT fin_crm_autopost_log_status_check
  CHECK (status IN ('ok', 'error', 'skipped'));

-- ---------- Автопроводка: платежи до даты запуска не проводятся ----------
-- Правка точечная: в начало fin_crm_autopost добавляется проверка даты.
CREATE OR REPLACE FUNCTION public.fin_crm_autopost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deal crm_deals%ROWTYPE;
  v_account fin_accounts%ROWTYPE;
  v_object uuid;
  v_sys_code text;
  v_channel fin_payment_channel;
  v_kind text;
  v_existing fin_operations%ROWTYPE;
  v_res jsonb;
  v_fee numeric;
  v_fee_category uuid;
  v_fee_res jsonb;
  v_cutover date;
BEGIN
  IF NOT NEW.is_confirmed THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_confirmed THEN RETURN NEW; END IF;

  BEGIN
    -- Получен до даты запуска: деньги уже сидят в начальных остатках,
    -- проводить второй раз нельзя (двойной счёт). Помечаем и выходим.
    v_cutover := fin_cutover_date();
    IF v_cutover IS NOT NULL AND COALESCE(NEW.received_at::date, CURRENT_DATE) < v_cutover THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'skipped', 'pre_cutover',
              format('Платёж получен %s — до запуска финмодуля (%s). Деньги учтены в начальных остатках, в учёт повторно не проводятся.',
                     COALESCE(NEW.received_at::date::text, '—'), v_cutover), auth.uid());
      RETURN NEW;
    END IF;

    SELECT * INTO v_existing FROM fin_operations WHERE id = NEW.id;
    IF FOUND AND v_existing.is_reversed THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'already_reversed',
              'Платёж уже проводился и был сторнирован. Повторное подтверждение денег не восстанавливает — заведите новый платёж.', auth.uid());
      RETURN NEW;
    END IF;

    SELECT * INTO v_deal FROM crm_deals WHERE id = NEW.deal_id;
    IF NOT FOUND OR v_deal.vaishnava_id IS NULL THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'no_participant', 'У сделки платежа нет участника', auth.uid());
      RETURN NEW;
    END IF;
    IF v_deal.retreat_id IS NULL THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'no_retreat', 'У сделки платежа не указан ретрит', auth.uid());
      RETURN NEW;
    END IF;

    SELECT id INTO v_object FROM fin_accounting_objects WHERE retreat_id = v_deal.retreat_id;
    IF NOT FOUND THEN
      INSERT INTO fin_accounting_objects (type, retreat_id, display_name)
      SELECT 'retreat', r.id, COALESCE(r.name_ru, r.name_en)
      FROM retreats r WHERE r.id = v_deal.retreat_id
      RETURNING id INTO v_object;
    END IF;

    IF NEW.fin_account_id IS NULL THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'account_required',
              'При подтверждении не указан счёт, на который поступили деньги', auth.uid());
      RETURN NEW;
    END IF;

    SELECT * INTO v_account FROM fin_accounts WHERE id = NEW.fin_account_id;
    IF NOT FOUND OR NOT v_account.is_active THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'account_inactive', 'Выбранный счёт не найден или закрыт', auth.uid());
      RETURN NEW;
    END IF;
    IF v_account.kind <> 'real' THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'account_not_real',
              format('Деньги гостя нельзя принять на подотчётный счёт «%s»', v_account.name), auth.uid());
      RETURN NEW;
    END IF;
    IF v_account.currency_code <> NEW.currency THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'currency_mismatch',
              format('Валюта платежа %s не совпадает с валютой счёта «%s» (%s)', NEW.currency, v_account.name, v_account.currency_code), auth.uid());
      RETURN NEW;
    END IF;

    SELECT code INTO v_sys_code FROM crm_payment_systems WHERE id = NEW.payment_system_id;
    v_channel := CASE
      WHEN v_account.reconciliation_mode = 'cash_count' THEN 'cash'
      WHEN v_sys_code = 'cash' THEN 'cash'
      WHEN v_sys_code = 'paypal' THEN 'paypal'
      ELSE 'bank_transfer'
    END::fin_payment_channel;

    v_kind := CASE
      WHEN NEW.payment_type IN ('org_fee', 'accommodation', 'meals', 'extra') THEN NEW.payment_type
      ELSE 'org_fee'
    END;

    v_res := fin_create_payment(jsonb_build_object(
      'request_id', NEW.id,
      'occurred_on', COALESCE(NEW.received_at::date, CURRENT_DATE),
      'payer_contact_id', v_deal.vaishnava_id,
      'comment', format('Автопроводка из CRM: платёж по сделке, счёт «%s»', v_account.name),
      'reason', NULL,
      'rows', jsonb_build_array(jsonb_build_object(
        'id', fin_private_child_uuid(NEW.id, 'crm-autopost-row'),
        'account_id', v_account.id,
        'amount', NEW.amount,
        'participant_id', v_deal.vaishnava_id,
        'object_id', v_object,
        'participant_balance_kind', v_kind,
        'payment_channel', v_channel
      ))
    ));

    IF COALESCE((v_res->>'ok')::boolean, false) THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, operation_id, actor)
      VALUES (NEW.id, 'ok', NEW.id, auth.uid());

      v_fee := NEW.amount - COALESCE(NEW.amount_received, NEW.amount);
      IF v_fee > 0 THEN
        SELECT id INTO v_fee_category FROM fin_categories WHERE code = 'bank_fee';
        v_fee_res := fin_create_expense(jsonb_build_object(
          'request_id', fin_private_child_uuid(NEW.id, 'crm-autopost-fee'),
          'occurred_on', COALESCE(NEW.received_at::date, CURRENT_DATE),
          'comment', format('Комиссия по платежу: отправлено %s, зачислено %s %s',
                            NEW.amount, NEW.amount_received, NEW.currency),
          'rows', jsonb_build_array(jsonb_build_object(
            'id', fin_private_child_uuid(NEW.id, 'crm-autopost-fee-row'),
            'account_id', v_account.id,
            'amount', v_fee,
            'category_id', v_fee_category,
            'object_id', v_object
          ))
        ));
        IF NOT COALESCE((v_fee_res->>'ok')::boolean, false) THEN
          INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
          VALUES (NEW.id, 'error', 'fee_failed',
                  format('Платёж проведён, но комиссия %s не списана: %s', v_fee,
                         COALESCE(v_fee_res#>>'{error,message}', '—')), auth.uid());
        END IF;
      END IF;
    ELSE
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', v_res#>>'{error,code}', v_res#>>'{error,message}', auth.uid());
    END IF;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
    VALUES (NEW.id, 'error', 'exception', SQLERRM, auth.uid());
  END;
  RETURN NEW;
END;
$function$;

-- ---------- Сторож подтверждения: старым платежам счёт не нужен ----------
CREATE OR REPLACE FUNCTION public.crm_guard_payment_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cutover date;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT fin_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'confirm_requires_fin_admin'
      USING DETAIL = 'Подтверждать платежи может только администратор финансов: подтверждение проводит платёж в финмодуль от имени подтверждающего.';
  END IF;
  -- Платёж до даты запуска: в учёт не проводится (учтён в начальных
  -- остатках), поэтому счёт и фактическая сумма не требуются.
  v_cutover := fin_cutover_date();
  IF v_cutover IS NOT NULL AND COALESCE(NEW.received_at::date, CURRENT_DATE) < v_cutover THEN
    RETURN NEW;
  END IF;
  IF NEW.payment_system_id IS NULL THEN
    RAISE EXCEPTION 'confirm_requires_payment_system'
      USING DETAIL = 'У платежа не указан способ оплаты. Заполните платёжную систему в карточке сделки.';
  END IF;
  IF NEW.fin_account_id IS NULL THEN
    RAISE EXCEPTION 'confirm_requires_account'
      USING DETAIL = 'Укажите счёт, на который фактически поступили деньги: приход отмечается только там, где деньги лежат.';
  END IF;
  IF NEW.amount_received IS NULL THEN
    RAISE EXCEPTION 'confirm_requires_amount_received'
      USING DETAIL = 'Укажите, сколько фактически пришло на счёт: банк мог удержать комиссию, и остаток должен сойтись с выпиской.';
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------- Витрина неразнесённых: skipped — не проблема ----------
DROP VIEW IF EXISTS public.fin_v_unposted_crm_payments;
CREATE VIEW public.fin_v_unposted_crm_payments AS
SELECT cp.id AS payment_id,
    cp.deal_id,
    cp.amount,
    cp.currency,
    cp.received_at,
    cp.payment_method,
    cp.payment_type,
    l.code AS last_error_code,
    l.message AS last_error_message,
    l.created_at AS last_attempt_at
FROM crm_payments cp
LEFT JOIN LATERAL (
  SELECT g.code, g.message, g.created_at, g.status
  FROM fin_crm_autopost_log g
  WHERE g.payment_id = cp.id
  ORDER BY g.created_at DESC
  LIMIT 1
) l ON true
WHERE fin_can_read_all(auth.uid())
  AND cp.is_confirmed
  AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
  AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id)
  AND l.status <> 'skipped'
  AND COALESCE(cp.received_at::date, CURRENT_DATE) >= COALESCE(fin_cutover_date(), DATE '1900-01-01');
REVOKE ALL ON public.fin_v_unposted_crm_payments FROM PUBLIC, anon;
GRANT SELECT ON public.fin_v_unposted_crm_payments TO authenticated;

-- ---------- Сторож целостности: инвариант unposted_payments — то же ----------
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
    jsonb_build_object('name','totals_mismatch',
      'detail','total_paid/total_charged сделки разошлись с формулой финмодуля',
      'sql','SELECT count(*) FROM crm_deals d, LATERAL crm_calc_deal_totals(d.id) t WHERE abs(d.total_paid - t.o_paid) > 0.01 OR d.total_charged IS DISTINCT FROM t.o_charged'),
    jsonb_build_object('name','orphan_autopost',
      'detail','Операция автопроводки без CRM-платежа-исходника (кроме законно сторнированных)',
      'sql','SELECT count(*) FROM fin_operations o WHERE o.comment LIKE ''%Автопроводка%'' AND NOT o.is_reversed AND NOT EXISTS (SELECT 1 FROM crm_payments p WHERE p.id=o.id)'),
    jsonb_build_object('name','unposted_payments',
      'detail','Платежи подтверждены в CRM после запуска, но не разнесены в финмодуль',
      'sql','SELECT count(*) FROM crm_payments cp WHERE cp.is_confirmed AND COALESCE(cp.received_at::date, CURRENT_DATE) >= COALESCE(fin_cutover_date(), DATE ''1900-01-01'') AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=cp.id) AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id=cp.id AND g.status<>''skipped'')'),
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
