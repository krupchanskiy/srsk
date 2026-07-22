-- Этап 3: автопроводка платежей CRM → финмодуль.
-- Подтверждение платежа в CRM (is_confirmed=true) автоматически создаёт операцию
-- fin_create_payment. Актор — подтверждающий (НВ/ВГ, оба постоянные fin_admin,
-- вопрос 3 интеграционных ответов). Идемпотентность: request_id = crm_payments.id —
-- повторное подтверждение возвращает существующую операцию, дубль невозможен.
-- Ошибки автопроводки НИКОГДА не роняют CRM-поток — пишутся в fin_crm_autopost_log
-- (будущий источник «красных» уведомлений, блок 6 интеграционных ответов).

ALTER TABLE crm_payments ADD COLUMN IF NOT EXISTS fin_account_id uuid REFERENCES fin_accounts(id);
COMMENT ON COLUMN crm_payments.fin_account_id IS
'Счёт финмодуля для наличного платежа (касса). Обязателен при подтверждении cash — безналичные определяются маппингом fin_crm_channel_map.';

CREATE TABLE IF NOT EXISTS fin_crm_autopost_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error')),
  code text,
  message text,
  operation_id uuid,
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fin_crm_autopost_log_payment ON fin_crm_autopost_log(payment_id, created_at DESC);
ALTER TABLE fin_crm_autopost_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fin staff read autopost log" ON fin_crm_autopost_log;
CREATE POLICY "fin staff read autopost log" ON fin_crm_autopost_log
  FOR SELECT TO authenticated USING (fin_can_read_all((SELECT auth.uid())));

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
        'participant_balance_kind', 'org_fee',
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

DROP TRIGGER IF EXISTS trg_fin_crm_autopost_ins ON crm_payments;
CREATE TRIGGER trg_fin_crm_autopost_ins
AFTER INSERT ON crm_payments
FOR EACH ROW WHEN (NEW.is_confirmed)
EXECUTE FUNCTION fin_crm_autopost();

DROP TRIGGER IF EXISTS trg_fin_crm_autopost_upd ON crm_payments;
CREATE TRIGGER trg_fin_crm_autopost_upd
AFTER UPDATE OF is_confirmed ON crm_payments
FOR EACH ROW WHEN (NEW.is_confirmed AND NOT OLD.is_confirmed)
EXECUTE FUNCTION fin_crm_autopost();
