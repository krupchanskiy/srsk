-- КРИТИЧНО: загрузчик авансов забирал платежи, уже проведённые в журнале.
--
-- fin_load_crm_advances() отбирал ВСЕ подтверждённые платежи до даты запуска,
-- не проверяя, нет ли по ним операции в учёте. Такие платежи есть: они были
-- подтверждены до появления защиты по дате (миграция 241) и успели пройти
-- автопроводкой. Для них деньги легли бы дважды — проводкой и начальным
-- остатком. На живых данных: 1 платёж, 27 600 ₹.
--
-- Исправление: платежи, уже имеющие непогашенную операцию в журнале, в
-- остатки не берём. Сторнированные берём: там деньги в учёте не остались.

CREATE OR REPLACE FUNCTION fin_load_crm_advances()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  SELECT jsonb_build_object(
    'cutover_batch_id', 'c07a11ce-2026-4801-9000-000000000001',
    'source_document', format('CRM: подтверждённые платежи живых сделок до %s', fin_cutover_date()),
    'rows', jsonb_agg(jsonb_build_object(
      'source_row_id', x.deal_id::text,
      'participant_id', x.participant_id,
      'retreat_id', x.retreat_id,
      'amount', x.amount_inr,
      'kind', 'credit',
      'balance_kind', 'general',
      'comment', format('Оплачено до запуска: %s (%s пл.)', x.detail, x.payments)
    )))
  INTO v_payload
  FROM (
    SELECT d.id AS deal_id, d.vaishnava_id AS participant_id, d.retreat_id,
           count(p.id) AS payments,
           string_agg(p.amount || ' ' || p.currency, ' + ' ORDER BY p.received_at) AS detail,
           round(SUM(p.amount_inr), 2) AS amount_inr
    FROM crm_deals d
    JOIN crm_payments p ON p.deal_id = d.id
    WHERE d.status <> 'cancelled'
      AND d.vaishnava_id IS NOT NULL
      AND p.is_confirmed
      AND COALESCE(p.received_at::date, CURRENT_DATE) < COALESCE(fin_cutover_date(), CURRENT_DATE)
      -- платёж, уже проведённый в журнале, в остатки не берём: иначе удвоение
      AND NOT EXISTS (
        SELECT 1 FROM fin_operations o
        WHERE o.id = p.id AND NOT o.is_reversed)
    GROUP BY d.id
    HAVING SUM(p.amount_inr) > 0
  ) x;

  IF v_payload IS NULL OR v_payload->'rows' IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'nothing_to_load', 'message', 'Нет подтверждённых платежей до даты запуска'));
  END IF;

  RETURN fin_load_opening_balances(v_payload);
END;
$$;

-- Предпросмотр обязан показывать ровно то, что загрузит загрузчик,
-- иначе ВГ сверит одно, а получит другое.
CREATE OR REPLACE FUNCTION fin_preview_crm_advances()
RETURNS TABLE(deal_id uuid, participant text, retreat text, payments bigint, detail text, amount_inr numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id,
         COALESCE(NULLIF(v.spiritual_name, ''), trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))),
         COALESCE(r.name_ru, r.name_en),
         count(p.id),
         string_agg(p.amount || ' ' || p.currency, ' + ' ORDER BY p.received_at),
         round(SUM(p.amount_inr), 2)
  FROM crm_deals d
  JOIN vaishnavas v ON v.id = d.vaishnava_id
  JOIN retreats r ON r.id = d.retreat_id
  JOIN crm_payments p ON p.deal_id = d.id
  WHERE fin_is_admin(auth.uid())
    AND d.status <> 'cancelled'
    AND p.is_confirmed
    AND COALESCE(p.received_at::date, CURRENT_DATE) < COALESCE(fin_cutover_date(), CURRENT_DATE)
    AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = p.id AND NOT o.is_reversed)
  GROUP BY d.id, v.id, r.id
  HAVING SUM(p.amount_inr) > 0
  ORDER BY 3, 2;
$$;
