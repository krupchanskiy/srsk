-- Исправления по итогам тестирования этапов 3-4.
--
-- 1. БАГ: автопроводка жёстко ставила participant_balance_kind='org_fee'.
--    В реальных данных crm_payments.payment_type = 'org_fee' (93) и 'accommodation' (1)
--    — это именно блоки начисления. Платёж за проживание уходил в оргвзнос.
--    Теперь payment_type используется как блок, если он валиден; иначе — org_fee.
-- 2. ЗАЩИТА: удаление CRM-платежа, уже проведённого в финмодуль, запрещено —
--    деньги правятся сторно, иначе остаётся «осиротевшая» операция без исходника.
-- 3. МОНИТОРИНГ: витрина подтверждённых, но не разнесённых платежей.
--
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
  v_channel text;
  v_kind text;
  v_res jsonb;
BEGIN
  IF NOT NEW.is_confirmed THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_confirmed THEN RETURN NEW; END IF;

  BEGIN  -- любая ошибка автопроводки не должна сорвать подтверждение в CRM
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

    IF NEW.payment_method = 'cash' THEN
      IF NEW.fin_account_id IS NULL THEN
        INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
        VALUES (NEW.id, 'error', 'cash_account_required', 'Наличные: не выбрана касса при подтверждении', auth.uid());
        RETURN NEW;
      END IF;
      SELECT * INTO v_account FROM fin_accounts WHERE id = NEW.fin_account_id AND is_active;
    ELSE
      SELECT a.* INTO v_account
      FROM fin_crm_channel_map m JOIN fin_accounts a ON a.id = m.account_id
      WHERE m.currency_code = NEW.currency AND a.is_active;
    END IF;

    IF v_account.id IS NULL THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'no_account_mapping',
              format('Нет активного счёта для валюты %s (канал %s)', NEW.currency, COALESCE(NEW.payment_method, '—')), auth.uid());
      RETURN NEW;
    END IF;
    IF v_account.currency_code <> NEW.currency THEN
      INSERT INTO fin_crm_autopost_log(payment_id, status, code, message, actor)
      VALUES (NEW.id, 'error', 'currency_mismatch',
              format('Валюта платежа %s не совпадает с валютой счёта «%s» (%s)', NEW.currency, v_account.name, v_account.currency_code), auth.uid());
      RETURN NEW;
    END IF;

    v_channel := CASE
      WHEN NEW.payment_method = 'cash' THEN 'cash'
      WHEN NEW.payment_method = 'paypal' THEN 'paypal'
      WHEN NEW.currency IN ('USD','EUR') THEN 'paypal'
      ELSE 'bank_transfer'
    END;

    -- payment_type в CRM хранит блок начисления (org_fee / accommodation / meals / extra).
    -- 'general' и 'none' в автопроводке недопустимы: general — служебный блок,
    -- none — пожертвование (отдельная операция).
    v_kind := CASE
      WHEN NEW.payment_type IN ('org_fee', 'accommodation', 'meals', 'extra') THEN NEW.payment_type
      ELSE 'org_fee'
    END;

    v_res := fin_create_payment(jsonb_build_object(
      'request_id', NEW.id,
      'occurred_on', COALESCE(NEW.received_at::date, CURRENT_DATE),
      'payer_contact_id', v_deal.vaishnava_id,
      'comment', format('Автопроводка из CRM: платёж по сделке, канал %s', COALESCE(NEW.payment_method, NEW.currency)),
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


-- Защита от осиротевших операций: проведённый платёж нельзя удалить из CRM
CREATE OR REPLACE FUNCTION public.crm_block_delete_posted_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id AND NOT o.is_reversed) THEN
    RAISE EXCEPTION 'payment_posted_to_finance'
      USING DETAIL = 'Платёж уже проведён в финмодуль. Сначала сторнируйте операцию в ДДС, затем удаляйте запись в CRM.';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_crm_block_delete_posted_payment ON crm_payments;
CREATE TRIGGER trg_crm_block_delete_posted_payment
BEFORE DELETE ON crm_payments
FOR EACH ROW EXECUTE FUNCTION crm_block_delete_posted_payment();

-- Мониторинг: подтверждено в CRM, но в финмодуле операции нет
CREATE OR REPLACE VIEW public.fin_v_unposted_crm_payments AS
SELECT cp.id AS payment_id, cp.deal_id, cp.amount, cp.currency, cp.received_at,
       cp.payment_method, cp.payment_type,
       l.code AS last_error_code, l.message AS last_error_message, l.created_at AS last_attempt_at
FROM crm_payments cp
LEFT JOIN LATERAL (
  SELECT code, message, created_at FROM fin_crm_autopost_log g
  WHERE g.payment_id = cp.id ORDER BY g.created_at DESC LIMIT 1
) l ON true
WHERE cp.is_confirmed
  AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
  AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id);

COMMENT ON VIEW public.fin_v_unposted_crm_payments IS
'Платежи, подтверждённые в CRM, по которым автопроводка не создала операцию. Историю до интеграции не показывает (только те, где была попытка).';
