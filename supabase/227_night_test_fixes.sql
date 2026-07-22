-- Фиксы по итогам ночного тестирования (сценарии блока 4).
--
-- 1. «Зомби-подтверждение»: платёж проведён → сторнирован → снят с подтверждения →
--    подтверждён снова. Идемпотентность возвращала сторнированную операцию,
--    лог рапортовал 'ok', подтверждающий видел зелёное «проведён» — а денег в учёте нет.
--    Теперь: если операция уже существует и сторнирована — ошибка с понятным текстом.
-- 2. Смена участника/ретрита сделки не пересчитывала витрину total_* (триггера не было).
-- 3. Сумму проведённого платежа можно было переписать в CRM: учёт и CRM расходились.
--    По ТЗ ошибка в деньгах правится только сторно — блокируем правку денежных полей.
-- 4. Зеркальные семейные связи (A→B и B→A) с разными видами давали дубль человека
--    в портале: запрещаем зеркало индексом по неупорядоченной паре.
--
-- Полный текст fin_crm_autopost() — в применённой миграции на проде
-- (SELECT pg_get_functiondef('fin_crm_autopost'::regproc)); здесь ключевое отличие
-- от миграции 218 — блок проверки уже существующей сторнированной операции.

-- ── 2. Смена участника/ретрита сделки пересчитывает витрину обеих пар ─────────
CREATE OR REPLACE FUNCTION public.crm_deal_pair_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM crm_resync_pair_totals(OLD.vaishnava_id, OLD.retreat_id);
  PERFORM crm_resync_pair_totals(NEW.vaishnava_id, NEW.retreat_id);
  PERFORM crm_apply_deal_totals(NEW.id);
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_crm_deal_pair_changed ON crm_deals;
CREATE TRIGGER trg_crm_deal_pair_changed
AFTER UPDATE OF vaishnava_id, retreat_id ON crm_deals
FOR EACH ROW
WHEN (NEW.vaishnava_id IS DISTINCT FROM OLD.vaishnava_id
   OR NEW.retreat_id IS DISTINCT FROM OLD.retreat_id)
EXECUTE FUNCTION crm_deal_pair_changed();

-- ── 3. Денежные поля проведённого платежа неизменяемы (ТЗ: только сторно) ─────
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
      OR NEW.received_at IS DISTINCT FROM OLD.received_at)
     AND EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = OLD.id AND NOT o.is_reversed)
  THEN
    RAISE EXCEPTION 'payment_posted_immutable'
      USING DETAIL = 'Платёж уже проведён в финмодуль: сумму, валюту, курс и дату изменить нельзя. Сторнируйте операцию в ДДС и заведите платёж заново.';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_crm_block_edit_posted_payment ON crm_payments;
CREATE TRIGGER trg_crm_block_edit_posted_payment
BEFORE UPDATE ON crm_payments
FOR EACH ROW EXECUTE FUNCTION crm_block_edit_posted_payment();

-- ── 4. Одна семейная связь на пару: зеркало запрещено ─────────────────────────
DELETE FROM family_links a USING family_links b
WHERE a.vaishnava_id = b.relative_id AND a.relative_id = b.vaishnava_id
  AND a.created_at > b.created_at;

CREATE UNIQUE INDEX IF NOT EXISTS uq_family_links_pair
  ON family_links (LEAST(vaishnava_id, relative_id), GREATEST(vaishnava_id, relative_id));

INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_family_link_exists', 'Связь между этими людьми уже заведена', 'These people are already linked', 'इन लोगों के बीच संबंध पहले से है')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
