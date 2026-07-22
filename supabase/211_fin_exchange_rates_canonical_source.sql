-- Этап 1 интеграции: fin_exchange_rates — единственный источник курса.
-- crm_currencies.rate_to_inr становится производным кэшем (integration_review_vg.md, 2.1/R2.1).

-- 1. Стартовые глобальные курсы — переносим текущие значения из crm_currencies.
--    effective_date в прошлом, чтобы платежи с прошлой occurred_on не падали
--    на exchange_rate_missing до внесения точных исторических курсов.
--    created_by — Ачинтья Кришна (администратор финансов, инициатор переноса).
INSERT INTO fin_exchange_rates (object_id, effective_date, from_currency, rate, created_by)
SELECT NULL, DATE '2025-01-01', c.code, c.rate_to_inr, '2160b531-4e37-4d2a-ba46-cc1ee230cfeb'
FROM crm_currencies c
WHERE c.code <> 'INR' AND c.rate_to_inr > 0
ON CONFLICT (object_id, effective_date, from_currency) DO NOTHING;

-- 2. Синхронизация кэша: любой правкой глобального курса (object_id IS NULL)
--    пересчитывается rate_to_inr затронутой валюты — актуальный курс на сегодня.
--    Курсы объектов (object_id NOT NULL) кэш CRM не трогают: это переопределения
--    для конкретного ретрита, общий курс им не меняется.
--    Краевой случай «курс с будущей датой наступил» кэш не ловит (триггер срабатывает
--    на изменение, не на ход времени) — на практике курсы вносятся текущей датой.
CREATE OR REPLACE FUNCTION public.fin_sync_crm_currency_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_currency text;
    v_rate numeric;
BEGIN
    v_currency := COALESCE(NEW.from_currency, OLD.from_currency);
    IF COALESCE(NEW.object_id, OLD.object_id) IS NOT NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT rate INTO v_rate
    FROM fin_exchange_rates
    WHERE from_currency = v_currency AND object_id IS NULL AND effective_date <= CURRENT_DATE
    ORDER BY effective_date DESC
    LIMIT 1;

    IF v_rate IS NOT NULL THEN
        UPDATE crm_currencies SET rate_to_inr = v_rate, updated_at = now()
        WHERE code = v_currency AND rate_to_inr IS DISTINCT FROM v_rate;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_fin_sync_crm_currency_cache ON fin_exchange_rates;
CREATE TRIGGER trg_fin_sync_crm_currency_cache
AFTER INSERT OR UPDATE OR DELETE ON fin_exchange_rates
FOR EACH ROW EXECUTE FUNCTION fin_sync_crm_currency_cache();

COMMENT ON COLUMN crm_currencies.rate_to_inr IS
'Производный кэш. Источник — fin_exchange_rates (глобальные курсы), синхронизируется триггером trg_fin_sync_crm_currency_cache. Вручную не править — значение будет перезаписано.';
