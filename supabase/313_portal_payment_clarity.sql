-- Портал гостя: кто заплатил и чем «переоформлен» отличается от «отменён».
--
-- Две шероховатости, которые вылезли после разбивки платежей (29.07.2026):
--
-- 1. Муж платит за жену — у жены в портале появляется платёж, которого она не
--    делала, без всякого объяснения. Плательщик в базе есть (payer_contact_id),
--    просто портал его не показывал.
--
-- 2. Перераспределение платежа делает сторно, и гость видел статус «сторно» —
--    то есть «мой платёж отменили», хотя деньги на месте и просто разнесены
--    иначе. Сторно от перераспределения узнаём по причине, с которой его
--    создаёт fin_reallocate_payment, и показываем как «переоформлен».

create or replace function fin_private_participant_payments(p_participant uuid, p_retreat uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'occurred_on') DESC), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
      'posting_id', p.id,
      'operation_id', p.operation_id,
      'occurred_on', o.occurred_on,
      'type', o.type,
      'amount', p.amount,
      'currency_code', p.currency_code,
      'amount_base', p.amount_base,
      'rate_used', p.rate_used,
      'payment_channel', p.payment_channel,
      'balance_kind', p.participant_balance_kind,
      'is_reversed', o.is_reversed,
      -- Показываем плательщика, только если платил не сам участник
      'paid_by', CASE
        WHEN o.payer_contact_id IS NOT NULL AND o.payer_contact_id <> p.participant_id
          THEN fin_private_person_name(o.payer_contact_id)
        ELSE NULL
      END,
      'status', CASE
        WHEN o.is_reversed AND EXISTS (
              SELECT 1 FROM fin_operations rv
               WHERE rv.original_operation_id = o.id
                 AND rv.reason LIKE 'Перераспределение платежа%')
          THEN 'reallocated'
        WHEN o.is_reversed THEN 'reversed'
        WHEN o.type = 'payment' AND n.net_amount >= p.amount THEN 'refunded_fully'
        WHEN o.type = 'payment' AND n.net_amount > 0 THEN 'refunded_partially'
        ELSE 'active'
      END,
      'available_to_refund', CASE WHEN o.type = 'payment' AND NOT o.is_reversed THEN p.amount - n.net_amount ELSE 0 END
    ) AS x
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounting_objects ao ON ao.id = p.object_id
    LEFT JOIN LATERAL fin_private_net_refunded(p.id) n ON o.type = 'payment'
    WHERE p.participant_id = p_participant
      AND ao.retreat_id = p_retreat
      AND p.participant_balance_kind IS NOT NULL
      -- Само сторно от перераспределения гостю не показываем: иначе на одну
      -- историю выходит три строки (было / сторно / стало). Бухгалтеру они видны
      -- в ДДС, а гостю достаточно «переоформлен» на старой сумме и новой строки.
      AND NOT (o.type = 'reversal' AND o.reason LIKE 'Перераспределение платежа%')
  ) t
$function$;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_reallocated', 'переоформлен', 'reallocated', 'पुनर्वितरित', 'Финансы'),
  ('fin_paid_by', 'оплатил', 'paid by', 'भुगतानकर्ता', 'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
