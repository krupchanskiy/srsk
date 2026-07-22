-- Закрытие периметра по итогам ночного аудита. Проверено вживую анонимным ключом:
-- crm_calc_deal_totals возвращал анониму суммы начислено/оплачено, crm_resync_pair_totals
-- позволял анониму писать в crm_deals, витрина неразнесённых платежей была ему открыта.
-- Дисциплина проекта (миграции 176, 195): каждая внутренняя функция — с явным REVOKE.

-- ── 1. Внутренние функции интеграции: только сервер и триггеры ────────────────
REVOKE ALL ON FUNCTION public.crm_calc_deal_totals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_apply_deal_totals(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_resync_pair_totals(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_private_has_retreat_data(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_crm_autopost() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_deal_pair_changed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_trg_resync_deal_totals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_recalc_deal_finances() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_guard_payment_confirmation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_block_delete_posted_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.crm_block_edit_posted_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fin_sync_crm_currency_cache() FROM PUBLIC, anon, authenticated;

-- ── 2. Витрина неразнесённых платежей — только читающие финмодуль ─────────────
-- Была доступна анониму: view без security_invoker исполняется правами владельца,
-- RLS crm_payments не применялась.
DROP VIEW IF EXISTS public.fin_v_unposted_crm_payments;
CREATE VIEW public.fin_v_unposted_crm_payments
WITH (security_invoker = true) AS
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

-- ── 3. Витрина конверсии отдавала точные суммы всем сотрудникам ───────────────
-- Отделу продаж нужен факт «оргвзнос закрыт полностью», а не цифры чужих денег.
-- Суммы остаются только для тех, кто и так читает финмодуль.
CREATE OR REPLACE FUNCTION public.crm_deal_org_fee_status(p_retreat uuid)
RETURNS TABLE (deal_id uuid, org_charged numeric, org_paid numeric, fully_paid boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_full boolean;
BEGIN
  IF NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  v_full := fin_can_read_all(auth.uid());
  RETURN QUERY
  SELECT d.id,
         CASE WHEN v_full THEN round(COALESCE(ch.s, 0), 2) END,
         CASE WHEN v_full THEN round(COALESCE(lg.s, 0) + COALESCE(pp.s, 0), 2) END,
         COALESCE(ch.s, 0) > 0 AND COALESCE(lg.s, 0) + COALESCE(pp.s, 0) >= COALESCE(ch.s, 0)
  FROM crm_deals d
  LEFT JOIN LATERAL (
    SELECT SUM(c.amount - c.discount_amount) AS s FROM fin_charges c
    WHERE c.participant_id = d.vaishnava_id AND c.retreat_id = d.retreat_id
      AND c.kind = 'org_fee' AND NOT c.is_cancelled
  ) ch ON true
  LEFT JOIN LATERAL (
    SELECT SUM(cp.amount_inr) AS s FROM crm_payments cp
    WHERE cp.deal_id = d.id AND cp.is_confirmed
      AND NOT EXISTS (SELECT 1 FROM fin_operations fo WHERE fo.id = cp.id)
  ) lg ON true
  LEFT JOIN LATERAL (
    SELECT SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS s
    FROM fin_postings p JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE p.participant_id = d.vaishnava_id AND o.retreat_id = d.retreat_id
      AND p.participant_balance_kind = 'org_fee'
  ) pp ON true
  WHERE d.retreat_id = p_retreat;
END;
$function$;

-- ── 4. Семейные связи: ключ к чужим финансам не должен раздавать любой сотрудник ──
-- is_staff() истинна для любого с активной ролью: сотрудник мог связать себя
-- с любым гостем и получить его сальдо в портале. Требуем право на правку людей.
DROP POLICY IF EXISTS "Staff manage family links" ON family_links;
CREATE POLICY "Family links read staff" ON family_links
  FOR SELECT TO authenticated USING (is_staff((SELECT auth.uid())));
CREATE POLICY "Family links write with permission" ON family_links
  FOR ALL TO authenticated
  USING (has_permission((SELECT auth.uid()), 'edit_vaishnava'))
  WITH CHECK (has_permission((SELECT auth.uid()), 'edit_vaishnava'));
