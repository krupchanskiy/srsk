-- Витрина неразнесённых платежей читает fin_operations, к которой у authenticated
-- нет table-прав (финмодуль закрыт). При security_invoker=true (миграция 228)
-- она падала с permission denied даже у fin-админа.
-- Правильно: security definer (владелец читает fin_operations) + гейт в WHERE
-- по fin_can_read_all + REVOKE anon. Проверено: анон отбит, fin-staff видит.
DROP VIEW IF EXISTS public.fin_v_unposted_crm_payments;
CREATE VIEW public.fin_v_unposted_crm_payments AS
SELECT cp.id AS payment_id, cp.deal_id, cp.amount, cp.currency, cp.received_at,
       cp.payment_method, cp.payment_type,
       l.code AS last_error_code, l.message AS last_error_message, l.created_at AS last_attempt_at
FROM crm_payments cp
LEFT JOIN LATERAL (
  SELECT code, message, created_at FROM fin_crm_autopost_log g
  WHERE g.payment_id = cp.id ORDER BY g.created_at DESC LIMIT 1
) l ON true
WHERE fin_can_read_all(auth.uid())
  AND cp.is_confirmed
  AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
  AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id);
REVOKE ALL ON public.fin_v_unposted_crm_payments FROM anon;
GRANT SELECT ON public.fin_v_unposted_crm_payments TO authenticated;
