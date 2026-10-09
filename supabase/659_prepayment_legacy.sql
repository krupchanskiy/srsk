-- 659: «Старый платёж» в CRM → Предоплата (решение ВГ 09.10.2026)
--
-- Платёж подтверждается для сделки (долг гостя уменьшается), но в кассу
-- не проводится и в ДДС не попадает: деньги получены до запуска кассы
-- (fin_cutover_date = 04.08.2026) или были учтены где-то раньше.
-- Пример: Павани дд, 100 € PayPal от 06.05.2025 — внесено до переноса
-- ретрита, сделка теперь на Лила-киртан 2027.
--
-- После даты запуска кнопка тоже доступна, но страница предупреждает:
-- деньги не встанут на баланс.

ALTER TABLE crm_payments ADD COLUMN IF NOT EXISTS is_legacy boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN crm_payments.is_legacy IS
  'Старый платёж: подтверждён для сделки, но без проводки в кассу/ДДС';

ALTER TABLE crm_payments DROP CONSTRAINT IF EXISTS crm_payments_legacy_confirmed;
ALTER TABLE crm_payments ADD CONSTRAINT crm_payments_legacy_confirmed
  CHECK (NOT is_legacy OR is_confirmed);

-- Подтверждение: старому платежу не нужны счёт, способ оплаты и сумма зачисления
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
  IF NEW.is_legacy THEN
    RETURN NEW;
  END IF;
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

-- Уже проведённый платёж нельзя задним числом объявить старым:
-- деньги остались бы в кассе, а в CRM висела бы метка «без проводки»
CREATE OR REPLACE FUNCTION public.crm_block_edit_posted_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  RETURN NEW;
END;
$function$;

-- Автопроводка: старый платёж пропускается с записью в журнал
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
    IF NEW.is_legacy THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'skipped', 'legacy',
              'Старый платёж: подтверждён для сделки, в кассу и ДДС не проводится.', auth.uid());
      RETURN NEW;
    END IF;

    v_cutover := fin_cutover_date();
    IF v_cutover IS NOT NULL AND COALESCE(NEW.received_at::date, CURRENT_DATE) < v_cutover THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'skipped', 'pre_cutover',
              format('Платёж получен %s - до запуска финмодуля (%s). Деньги учтены в начальных остатках, в учёт повторно не проводятся.',
                     COALESCE(NEW.received_at::date::text, '-'), v_cutover), auth.uid());
      RETURN NEW;
    END IF;

    SELECT * INTO v_existing FROM fin_operations WHERE id = NEW.id;
    IF FOUND AND v_existing.is_reversed THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'already_reversed',
              'Платёж уже проводился и был сторнирован. Повторное подтверждение денег не восстанавливает - заведите новый платёж.', auth.uid());
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
                         COALESCE(v_fee_res#>>'{error,message}', '-')), auth.uid());
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

-- Разовая разметка: все подтверждённые до запуска кассы (04.08.2026) и
-- не проведённые — старые. На 09.10.2026 таких 108, проведённых среди них нет.
UPDATE crm_payments p SET is_legacy = true
WHERE p.is_confirmed
  AND NOT p.is_legacy
  AND COALESCE(p.received_at::date, p.created_at::date) < fin_cutover_date()
  AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = p.id);

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('crm_prepayment_legacy', 'Старый платёж', 'Old payment', 'पुराना भुगतान', 'CRM Предоплата'),
  ('crm_prepayment_legacy_hint', 'Подтверждён для сделки, в кассу и ДДС не проводится', 'Confirmed for the deal, not posted to cash or cash flow', 'सौदे के लिए पुष्टि, कैश में दर्ज नहीं', 'CRM Предоплата'),
  ('crm_prepayment_legacy_warn', 'Будьте внимательны: платёж получен после запуска кассы. «Старый платёж» НЕ поставит эти деньги на баланс и не внесёт их в ДДС. Продолжить?', 'Careful: this payment was received after the cash system started. "Old payment" will NOT put this money on the balance or into cash flow. Continue?', 'सावधान: यह भुगतान कैश प्रणाली शुरू होने के बाद मिला। «पुराना भुगतान» इसे बैलेंस में नहीं डालेगा। जारी रखें?', 'CRM Предоплата'),
  ('crm_prepayment_how_confirm', 'Как подтвердить платёж?', 'How to confirm the payment?', 'भुगतान की पुष्टि कैसे करें?', 'CRM Предоплата')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
