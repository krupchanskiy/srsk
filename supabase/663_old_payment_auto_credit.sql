-- 663: старый платёж при подтверждении сам зачитывается гостю (решение ВГ 09.10.2026)
--
-- Было: платёж до запуска кассы (04.08.2026) при подтверждении не проводился
-- в кассу — верно, — но и гостю в начальный остаток не попадал. Человек
-- в финансах оставался должен, пока финансист отдельно не нажмёт «добор»
-- (так было у Труниной, мигр. 414). Можно забыть — ВГ: «этого допускать нельзя».
--
-- Стало: подтверждение «Старым платежом» или платежа до запуска само заводит
-- строку начального остатка «Оплачено до запуска: 100 EUR» на этого гостя
-- и этот ретрит. Сумма — ровно этот платёж; валюта — как в добор (мигр. 638):
-- Сева-ретрит в ₹, новая система — в валюте платежа.
--
-- Задвоение исключено: снять подтверждение со старого платежа нельзя — он уже
-- зачтён (у 88 сделок со старыми платежами зачтено ровно столько, сколько
-- заплачено, проверено 09.10). Ошибка исправляется коррекцией остатка в финансах.

CREATE OR REPLACE FUNCTION public.fin_private_credit_old_payment(p_payment_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay    crm_payments%ROWTYPE;
  v_deal   crm_deals%ROWTYPE;
  v_legacy boolean;
  v_cur    text;
  v_amount numeric;
  v_batch  uuid;
  v_id     uuid;
BEGIN
  SELECT * INTO v_pay FROM crm_payments WHERE id = p_payment_id;
  SELECT * INTO v_deal FROM crm_deals WHERE id = v_pay.deal_id;
  IF v_deal.vaishnava_id IS NULL OR v_deal.retreat_id IS NULL THEN
    RAISE EXCEPTION 'У сделки нет участника или ретрита — гостю зачесть некуда';
  END IF;

  SELECT coalesce(o.legacy_inr_settlement, true) INTO v_legacy
    FROM retreats r LEFT JOIN fin_accounting_objects o ON o.retreat_id = r.id
   WHERE r.id = v_deal.retreat_id;
  v_cur    := CASE WHEN v_legacy THEN 'INR' ELSE v_pay.currency END;
  v_amount := round(CASE WHEN v_legacy THEN v_pay.amount_inr ELSE v_pay.amount END, 2);

  SELECT ob.cutover_batch_id INTO v_batch
    FROM fin_participant_opening_balances ob
   WHERE ob.retreat_id = v_deal.retreat_id AND ob.cutover_batch_id IS NOT NULL
   LIMIT 1;

  v_id := fin_private_child_uuid(p_payment_id, 'old-payment-credit');
  INSERT INTO fin_participant_opening_balances (
    id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
    source_document, source_row_id, cutover_batch_id, request_hash, comment, created_by
  ) VALUES (
    v_id, v_deal.vaishnava_id, v_deal.retreat_id, v_amount, v_cur, 'credit', 'general',
    'Старый платёж: подтверждён в CRM',
    v_deal.id::text, v_batch,
    fin_private_hash(jsonb_build_object(
      'command', 'credit_old_payment',
      'payment_id', lower(p_payment_id::text),
      'currency', v_cur,
      'amount', fin_private_norm_money(v_amount))),
    format('Оплачено до запуска: %s %s от %s', v_pay.amount, v_pay.currency,
           coalesce(to_char(v_pay.received_at, 'DD.MM.YYYY'), '-')),
    auth.uid()
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN format('%s %s', v_amount, v_cur);
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_private_credit_old_payment(uuid) FROM PUBLIC, anon, authenticated;

-- Автопроводка: в кассу старый платёж не идёт, но гостю зачитывается
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('fin_crm_autopost()'::regprocedure);
  n := replace(d,
E'  BEGIN
    IF NEW.is_legacy THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, ''skipped'', ''legacy'',
              ''Старый платёж: подтверждён для сделки, в кассу и ДДС не проводится.'', auth.uid());
      RETURN NEW;
    END IF;

    v_cutover := fin_cutover_date();
    IF v_cutover IS NOT NULL AND COALESCE(NEW.received_at::date, CURRENT_DATE) < v_cutover THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, ''skipped'', ''pre_cutover'',
              format(''Платёж получен %s - до запуска финмодуля (%s). Деньги учтены в начальных остатках, в учёт повторно не проводятся.'',
                     COALESCE(NEW.received_at::date::text, ''-''), v_cutover), auth.uid());
      RETURN NEW;
    END IF;',
E'  -- мигр. 663: старый платёж в кассу не проводим, но гостю зачитываем сразу.
  -- Вне перехвата ошибок: не зачлось — не подтверждается, молча не проходит.
  v_cutover := fin_cutover_date();
  IF NEW.is_legacy
     OR (v_cutover IS NOT NULL AND COALESCE(NEW.received_at::date, CURRENT_DATE) < v_cutover) THEN
    v_credit := fin_private_credit_old_payment(NEW.id);
    INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
    VALUES (NEW.id, ''skipped'', CASE WHEN NEW.is_legacy THEN ''legacy'' ELSE ''pre_cutover'' END,
            format(''Старый платёж: в кассу и ДДС не проводится. Гостю зачтено %s в начальный остаток.'', v_credit),
            auth.uid());
    RETURN NEW;
  END IF;

  BEGIN');
  n := replace(n, E'  v_cutover date;\nBEGIN', E'  v_cutover date;\n  v_credit text;\nBEGIN');
  IF n = d OR n !~ 'fin_private_credit_old_payment' OR n !~ 'v_credit text;' THEN
    RAISE EXCEPTION 'autopost: шаблон не найден';
  END IF;
  EXECUTE n;
END;
$mig$;

-- Снять подтверждение со старого платежа нельзя: он уже зачтён гостю
CREATE OR REPLACE FUNCTION public.crm_block_edit_posted_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cutover date;
BEGIN
  IF (NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.rate_to_inr IS DISTINCT FROM OLD.rate_to_inr
      OR NEW.amount_inr IS DISTINCT FROM OLD.amount_inr
      OR NEW.amount_received IS DISTINCT FROM OLD.amount_received
      OR NEW.received_at IS DISTINCT FROM OLD.received_at)
     AND EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id AND NOT o.is_reversed)
  THEN
    RAISE EXCEPTION 'payment_posted_immutable'
      USING DETAIL = 'Платёж уже проведён в финмодуль: сумму, валюту, курс, комиссию и дату изменить нельзя. Сторнируйте операцию в ДДС и заведите платёж заново.';
  END IF;
  IF NEW.is_legacy AND NOT OLD.is_legacy
     AND EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id AND NOT o.is_reversed)
  THEN
    RAISE EXCEPTION 'payment_posted_not_legacy'
      USING DETAIL = 'Платёж уже проведён в кассу — пометить его старым нельзя. Сначала сторнируйте операцию в ДДС.';
  END IF;
  v_cutover := fin_cutover_date();
  IF OLD.is_confirmed AND NOT NEW.is_confirmed
     AND (OLD.is_legacy OR (v_cutover IS NOT NULL AND COALESCE(OLD.received_at::date, OLD.created_at::date) < v_cutover))
     AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id)
  THEN
    RAISE EXCEPTION 'old_payment_credited'
      USING DETAIL = 'Старый платёж уже зачтён гостю в начальный остаток — снять подтверждение нельзя. Если ошибка — исправьте остаток коррекцией в финансах.';
  END IF;
  RETURN NEW;
END;
$function$;

-- Тексты: гостю зачитывается, касса — нет
UPDATE translations SET
  ru = 'Зачтён гостю как «оплачено до запуска», в кассу и ДДС не проводится',
  en = 'Credited to the guest as "paid before launch", not posted to cash or cash flow'
WHERE key = 'crm_prepayment_legacy_hint';
UPDATE translations SET
  ru = 'Будьте внимательны: платёж получен после запуска кассы. «Старый платёж» НЕ поставит эти деньги на баланс кассы и не внесёт их в ДДС — гостю они зачтутся как «оплачено до запуска». Продолжить?',
  en = 'Careful: this payment was received after the cash system started. "Old payment" will NOT put this money on the cash balance or into cash flow — the guest will be credited as "paid before launch". Continue?'
WHERE key = 'crm_prepayment_legacy_warn';
