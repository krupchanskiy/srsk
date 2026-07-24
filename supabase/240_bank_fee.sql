-- =============================================================
-- Комиссия банка и платёжных систем (решение ВГ от 23.07.2026).
--
-- Участник отправляет одну сумму, а на счёт ложится меньшая — банк или
-- платёжная система удерживают процент. Раньше система заводила на счёт
-- полную сумму: остаток расходился с выпиской ровно на комиссию, и найти
-- причину было бы почти невозможно. Касается всех онлайн-каналов —
-- ИП ШРСК, PayPal, USDT и всех будущих.
--
-- Модель (дословно по требованию ВГ):
--   • участнику засчитывается ВСЯ отправленная сумма — долг не появляется;
--   • на счёт приходит фактически зачисленная;
--   • разница проводится расходом «Комиссия банка» на тот же счёт.
-- Итог: остаток счёта сходится с выпиской, участник ничего не должен,
-- а сколько съедают банки — видно отдельной строкой в расходах.
--
-- Для расчёта процента отделу продаж берётся amount_received (фактически
-- поступившее), а не отправленное — тоже требование ВГ.
-- =============================================================

ALTER TABLE crm_payments ADD COLUMN IF NOT EXISTS amount_received numeric;

ALTER TABLE crm_payments DROP CONSTRAINT IF EXISTS crm_payments_amount_received_check;
ALTER TABLE crm_payments ADD CONSTRAINT crm_payments_amount_received_check
  CHECK (amount_received IS NULL OR (amount_received > 0 AND amount_received <= amount));

COMMENT ON COLUMN crm_payments.amount_received IS
'Сколько фактически пришло на счёт, в валюте платежа (после удержания банком). Заполняется при подтверждении, по умолчанию равно amount. Разница проводится расходом «Комиссия банка» и на долг участника не влияет.';

INSERT INTO fin_categories (code, name, direction, is_active)
SELECT 'bank_fee', 'Комиссия банка', 'out', true
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'bank_fee');

-- ---------- Автопроводка: платёж по-полной + расход комиссии ----------
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
BEGIN
  IF NOT NEW.is_confirmed THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_confirmed THEN RETURN NEW; END IF;

  BEGIN
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

    -- Участнику засчитывается вся отправленная сумма
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

      -- Комиссия: разница между отправленным и зачисленным. Расход без
      -- участника — на его долг не влияет, но остаток счёта сходится
      -- с выпиской.
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

-- ---------- Сторож подтверждения: фактическая сумма обязательна ----------
CREATE OR REPLACE FUNCTION public.crm_guard_payment_confirmation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT fin_is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'confirm_requires_fin_admin'
      USING DETAIL = 'Подтверждать платежи может только администратор финансов: подтверждение проводит платёж в финмодуль от имени подтверждающего.';
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

-- ---------- Заморозка проведённого платежа: и фактическая сумма тоже ----------
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
  RETURN NEW;
END;
$function$;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_amount_received', 'Сколько пришло на счёт', 'Amount credited to the account', 'खाते में कितना आया'),
  ('crm_amount_received_hint', 'Если банк удержал комиссию — укажите сумму из выписки. Разница спишется расходом, долгом на гостя не ляжет.', 'If the bank took a fee, enter the amount from the statement. The difference is booked as an expense and never becomes the guest''s debt.', 'यदि बैंक ने शुल्क काटा है, विवरण से राशि दर्ज करें। अंतर व्यय में जाएगा, अतिथि का बकाया नहीं बनेगा।'),
  ('crm_bank_fee', 'Комиссия', 'Fee', 'शुल्क'),
  ('crm_confirm_requires_amount_received', 'Укажите, сколько фактически пришло на счёт', 'Enter how much actually reached the account', 'बताएँ कि खाते में वास्तव में कितना आया')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
