-- 664: с проведённого платежа нельзя снять подтверждение (решение ВГ 09.10.2026)
--
-- Было: клик по зелёной «Подтверждена» снимал только отметку в CRM, а деньги
-- оставались в кассе и ДДС, гостю — зачтёнными. CRM и финансы расходились.
-- Стало: пока проводка в кассе живая — снять нельзя, отмена только сторно в ДДС.
-- После сторно снять отметку можно (повторно подтвердить — нельзя, мигр. автопроводки).

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
  -- мигр. 664
  IF OLD.is_confirmed AND NOT NEW.is_confirmed
     AND EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id AND NOT o.is_reversed)
  THEN
    RAISE EXCEPTION 'payment_posted_cannot_unconfirm'
      USING DETAIL = 'Платёж проведён в кассу — снять подтверждение нельзя. Отмена — только сторно операции в ДДС.';
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

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('crm_prepayment_normal_hint',
   'Проводится в кассу и ДДС. Отменить — только сторно в ДДС',
   'Posted to cash and cash flow. Undo — only by reversal in cash flow',
   'कैश में दर्ज होता है। रद्द — केवल स्टॉर्नो से',
   'CRM Предоплата')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
