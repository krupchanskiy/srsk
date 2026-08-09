-- В карточке участника видны только суммы в рупиях: авансы за прошлые ретриты
-- загружались одним начальным остатком, а исходная валюта осталась в CRM.
-- Так Сварупананда дас числится с ₹ 53 104,80 вместо своих 560 USD, а понять,
-- сколько человек реально внёс и каким способом, из финмодуля было нельзя (ВГ, 08.08).
--
-- Показываем происхождение денег: к проводкам финмодуля добавляем платежи CRM,
-- сделанные до переезда, — с их настоящей суммой, валютой, способом оплаты и счётом.
-- Учёт не трогаем: начальный остаток остаётся агрегатом, здесь только его расшифровка.
create or replace function public.fin_private_participant_payments(p_participant uuid, p_retreat uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT COALESCE(jsonb_agg(x ORDER BY (x->>'occurred_on') DESC), '[]'::jsonb)
  FROM (
    -- 1. Проводки финмодуля
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
      'account_name', a.name,
      'payment_system', NULL,
      'source', 'ledger',
      'balance_kind', p.participant_balance_kind,
      'is_reversed', o.is_reversed,
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
    LEFT JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN LATERAL fin_private_net_refunded(p.id) n ON o.type = 'payment'
    WHERE p.participant_id = p_participant
      AND ao.retreat_id = p_retreat
      AND p.participant_balance_kind IS NOT NULL
      -- Само сторно от перераспределения гостю не показываем: иначе на одну
      -- историю выходит три строки (было / сторно / стало).
      AND NOT (o.type = 'reversal' AND o.reason LIKE 'Перераспределение платежа%')

    UNION ALL

    -- 2. Платежи из CRM, сделанные до переезда: в журнале их нет, они свёрнуты
    --    в начальный остаток. Здесь показываем, из чего этот остаток сложился.
    SELECT jsonb_build_object(
      'posting_id', NULL,
      'operation_id', NULL,
      'occurred_on', COALESCE(cp.received_at::date, cp.confirmed_at::date),
      'type', 'payment',
      'amount', cp.amount,
      'currency_code', cp.currency,
      'amount_base', cp.amount_inr,
      'rate_used', cp.rate_to_inr,
      'payment_channel', NULL,
      'account_name', acc.name,
      'payment_system', ps.name_ru,
      'source', 'crm',
      'balance_kind', CASE cp.payment_type
                        WHEN 'org_fee' THEN 'org_fee'
                        WHEN 'accommodation' THEN 'accommodation'
                        ELSE 'general' END,
      'is_reversed', false,
      'paid_by', NULL,
      'status', 'pre_cutover',
      'available_to_refund', 0
    )
    FROM crm_payments cp
    JOIN crm_deals cd ON cd.id = cp.deal_id
    LEFT JOIN crm_payment_systems ps ON ps.id = cp.payment_system_id
    LEFT JOIN fin_accounts acc ON acc.id = cp.fin_account_id
    WHERE cd.vaishnava_id = p_participant
      AND cd.retreat_id = p_retreat
      AND cp.is_confirmed
      -- только те, что не попали в журнал: иначе платёж покажется дважды
      AND NOT EXISTS (SELECT 1 FROM fin_operations o2 WHERE o2.id = cp.id)
  ) t
$function$;
