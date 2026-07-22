-- Решение ВГ (вопрос 2, 23.07.2026): подтверждение платежа без прав администратора
-- финансов невозможно В ПРИНЦИПЕ — не предупреждение, а запрет на уровне БД.
-- Автопроводка выполняется от имени подтверждающего (вариант А подтверждён),
-- поэтому подтверждающий обязан быть fin_admin, иначе деньги мимо учёта.
--
-- auth.uid() IS NULL — серверный контекст (service role: миграции, cutover-скрипты),
-- не UI-путь; анонимов и так не пускает RLS.

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
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_crm_guard_payment_confirmation_ins ON crm_payments;
CREATE TRIGGER trg_crm_guard_payment_confirmation_ins
BEFORE INSERT ON crm_payments
FOR EACH ROW WHEN (NEW.is_confirmed)
EXECUTE FUNCTION crm_guard_payment_confirmation();

DROP TRIGGER IF EXISTS trg_crm_guard_payment_confirmation_upd ON crm_payments;
CREATE TRIGGER trg_crm_guard_payment_confirmation_upd
BEFORE UPDATE OF is_confirmed ON crm_payments
FOR EACH ROW WHEN (NEW.is_confirmed AND NOT OLD.is_confirmed)
EXECUTE FUNCTION crm_guard_payment_confirmation();

-- Перевод жёсткого отказа (заменяет мягкое предупреждение)
INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_confirm_requires_fin_admin',
   'Подтверждать платежи может только администратор финансов — подтверждение проводит деньги в финмодуль.',
   'Only a finance administrator can confirm payments — confirmation posts the money to the finance module.',
   'भुगतान की पुष्टि केवल वित्त प्रशासक कर सकता है — पुष्टि से राशि वित्त मॉड्यूल में दर्ज होती है।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
