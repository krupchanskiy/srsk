-- Этап 0 интеграции CRM↔финмодуль: гигиена (по integration_review_vg.md, R2.2/R2.3)
-- 1. Один пересчёт total_* вместо двух расходящихся триггеров:
--    total_paid раньше считался то по всем платежам (crm_recalc_deal_finances),
--    то только по подтверждённым (update_deal_total_paid) — кто последний, тот и прав.
--    Каноном становится «только подтверждённые» — как считает и финмодуль.
-- 2. Убран deposit-блок: crm_deposit_expenses удаляется, deposit_balance мёртв (везде 0).
-- 3. Удаление трёх таблиц до-финмодульного учёта денег (0 строк, 0 обращений в коде,
--    единственная ссылка в БД — deposit-блок этой же функции).

CREATE OR REPLACE FUNCTION public.crm_recalc_deal_finances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_deal_id UUID;
BEGIN
    v_deal_id := COALESCE(NEW.deal_id, OLD.deal_id);
    UPDATE crm_deals SET
        total_charged = (SELECT COALESCE(SUM(total_price), 0) FROM crm_deal_services WHERE deal_id = v_deal_id),
        total_paid    = (SELECT COALESCE(SUM(amount_inr), 0) FROM crm_payments
                          WHERE deal_id = v_deal_id AND is_confirmed = TRUE)
    WHERE id = v_deal_id;
    RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Дубль-триггер и его функция больше не нужны
DROP TRIGGER IF EXISTS trg_update_deal_total_paid ON crm_payments;
DROP FUNCTION IF EXISTS public.update_deal_total_paid();

-- Мёртвые таблицы (триггер crm_expenses_recalc умрёт вместе со своей таблицей)
DROP TABLE IF EXISTS public.guest_payments;
DROP TABLE IF EXISTS public.crm_deposit_expenses;
DROP TABLE IF EXISTS public.crm_final_settlements;

-- Колонку заполнял только удалённый deposit-блок; значения нулевые у всех сделок
ALTER TABLE public.crm_deals DROP COLUMN IF EXISTS deposit_balance;

-- Разовый пересчёт total_paid по каноническому правилу — убрать возможные
-- следы рассинхрона, накопленные двумя триггерами
UPDATE crm_deals d SET total_paid = COALESCE(
    (SELECT SUM(amount_inr) FROM crm_payments p WHERE p.deal_id = d.id AND p.is_confirmed = TRUE), 0)
WHERE d.total_paid IS DISTINCT FROM COALESCE(
    (SELECT SUM(amount_inr) FROM crm_payments p WHERE p.deal_id = d.id AND p.is_confirmed = TRUE), 0);
