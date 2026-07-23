-- =============================================================
-- Решения ВГ от 23.07.2026 (вопросы 1, 3, 4 раунда 4).
--
-- Правило ВГ дословно: «отмечать приход денег только на тот счёт,
-- на котором они лежат». Отсюда следует главное изменение:
-- автопроводка БОЛЬШЕ НЕ УГАДЫВАЕТ счёт по валюте платежа.
-- Счёт указывает человек при подтверждении — и это обязательно.
--
-- Что это закрывает разом:
--   вопрос 1 (рупии): индийского банковского счёта нет, рупии только
--     наличные — подтверждающий выбирает «Касса (₹)», угадывать нечего;
--   вопрос 3 (наличные без пометки): признак наличных больше не нужен —
--     касса это или банк, говорит сам выбранный счёт;
--   вопрос 4 (система → счёт): таблица соответствий не нужна, новая
--     точка входа = новый счёт в справочнике, его и выбирают.
--
-- fin_crm_channel_map остаётся, но меняет смысл: теперь это лишь
-- подсказка «что предложить по умолчанию» в интерфейсе, а не решающее
-- правило. Ошибиться она больше не может — последнее слово за человеком.
-- =============================================================

-- ---------- 1. Автопроводка: счёт только явный ----------
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
BEGIN
  IF NOT NEW.is_confirmed THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.is_confirmed THEN RETURN NEW; END IF;

  BEGIN  -- любая ошибка автопроводки не должна сорвать подтверждение в CRM
    -- Операция с этим id уже была: повторное подтверждение не должно
    -- выглядеть успешным, если деньги сторнированы (иначе тихая потеря)
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

    -- Счёт назначает человек при подтверждении. Никаких догадок по валюте:
    -- деньги ложатся туда, где они физически лежат (правило ВГ).
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

    -- Канал для аналитики выводим из счёта и платёжной системы, а не из
    -- пометки payment_method: касса это или банк — знает сам счёт.
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

-- ---------- 2. Сторож подтверждения: fin_admin + счёт + способ оплаты ----------
-- Срабатывает только на переходе «не подтверждён → подтверждён», поэтому
-- исторические записи можно править как раньше. auth.uid() IS NULL —
-- служебный путь (миграции, cutover), он не проверяется.
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
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.crm_guard_payment_confirmation() IS
'Условия подтверждения платежа в CRM (решения ВГ 22–23.07.2026): права fin_admin, заполненный способ оплаты и явно указанный счёт поступления.';

-- ---------- 3. Подсказка по умолчанию для рупий ----------
-- Индийского банковского счёта нет: безналичных рупий у нас не бывает,
-- рупии приходят наличными в кассу (ответ ВГ на вопрос 1).
INSERT INTO fin_crm_channel_map (currency_code, account_id)
SELECT 'INR', id FROM fin_accounts WHERE name = 'Касса (₹)' AND is_active
ON CONFLICT (currency_code) DO UPDATE SET account_id = EXCLUDED.account_id;

COMMENT ON TABLE fin_crm_channel_map IS
'Подсказка интерфейса: какой счёт предложить по умолчанию при подтверждении платежа в этой валюте. Решающего значения не имеет — счёт всегда выбирает человек.';
