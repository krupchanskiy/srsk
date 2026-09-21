-- 427. Третий разбор сигнала «человека нет в учёте»: «Возврат»
--
-- ВГ: часть подтверждённых в CRM платежей до рубежа — это не пожертвования и
-- не авансы, а деньги, которые уже реально вернули человеку (возврат прошёл
-- ДО того, как система начала вестись). Нужно фиксировать это отдельным
-- решением, с настоящей датой события (не датой клика), а не молча
-- приравнивать возврат к пожертвованию — это разные факты для отчётности.

-- 1. Дата события и новый вид решения
ALTER TABLE fin_payment_dispositions ADD COLUMN IF NOT EXISTS occurred_on date;

ALTER TABLE fin_payment_dispositions DROP CONSTRAINT fin_payment_dispositions_disposition_check;
ALTER TABLE fin_payment_dispositions ADD CONSTRAINT fin_payment_dispositions_disposition_check
  CHECK (disposition IN ('donation', 'refund'));

COMMENT ON COLUMN fin_payment_dispositions.occurred_on IS
  'Дата, когда решение фактически произошло (возврат отдан / пожертвование принято) — не дата ввода в систему';

-- 2. RPC: добавляем action='refund' и необязательную occurred_on
CREATE OR REPLACE FUNCTION fin_resolve_missing_advance(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_actor       uuid;
  v_request_id  uuid;
  v_participant uuid;
  v_retreat     uuid;
  v_action      text;
  v_note        text;
  v_occurred_on date;
  v_batch       uuid;
  v_ids         uuid[];
  v_сумма       numeric := 0;
  v_строк       int := 0;
  v_detail      text;
  d             record;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Доступно только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'participant_id', 'retreat_id', 'action', 'note', 'occurred_on'
  ]);
  v_request_id  := fin_private_get_uuid(payload, 'request_id', true);
  v_participant := fin_private_get_uuid(payload, 'participant_id', true);
  v_retreat     := fin_private_get_uuid(payload, 'retreat_id', true);
  v_action      := nullif(trim(coalesce(payload->>'action', '')), '');
  v_note        := nullif(trim(coalesce(payload->>'note', '')), '');
  v_occurred_on := nullif(payload->>'occurred_on', '')::date;

  IF v_action NOT IN ('donation', 'refund', 'advance') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'action: ожидается donation, refund или advance';
  END IF;

  -- Платежи, из-за которых горит сигнал
  SELECT array_agg(cp.id), coalesce(sum(cp.amount_inr), 0)
    INTO v_ids, v_сумма
    FROM crm_payments cp
    JOIN crm_deals cd ON cd.id = cp.deal_id
   WHERE cd.vaishnava_id = v_participant
     AND cd.retreat_id = v_retreat
     AND cp.is_confirmed
     AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
     AND NOT EXISTS (SELECT 1 FROM fin_payment_dispositions pd WHERE pd.payment_id = cp.id);

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'nothing_to_resolve'
      USING DETAIL = 'По этому человеку не осталось неразобранных платежей — сигнал уже погашен';
  END IF;

  IF v_action IN ('donation', 'refund') THEN
    INSERT INTO fin_payment_dispositions (payment_id, disposition, occurred_on, note, created_by)
    SELECT u, v_action, coalesce(v_occurred_on, current_date),
           coalesce(v_note, CASE v_action
             WHEN 'refund' THEN 'Участие отменено, деньги возвращены человеку'
             ELSE 'Участие отменено, сумма оставлена как пожертвование' END),
           v_actor
      FROM unnest(v_ids) u
    ON CONFLICT (payment_id) DO NOTHING;
    GET DIAGNOSTICS v_строк = ROW_COUNT;

  ELSE
    -- Добор начального остатка: платёж подтвердили после загрузки рубежа
    IF EXISTS (SELECT 1 FROM fin_participant_opening_balances ob
                WHERE ob.participant_id = v_participant AND ob.retreat_id = v_retreat) THEN
      RAISE EXCEPTION 'opening_exists'
        USING DETAIL = 'Начальный остаток у этого человека уже есть — добор не нужен';
    END IF;

    SELECT ob.cutover_batch_id INTO v_batch
      FROM fin_participant_opening_balances ob
     WHERE ob.retreat_id = v_retreat AND ob.cutover_batch_id IS NOT NULL
     LIMIT 1;

    FOR d IN
      SELECT cd.id AS deal_id,
             sum(cp.amount_inr) AS сумма,
             count(*) AS платежей,
             string_agg(cp.amount || ' ' || cp.currency, ', ' ORDER BY cp.received_at) AS расшифровка
        FROM crm_payments cp
        JOIN crm_deals cd ON cd.id = cp.deal_id
       WHERE cp.id = ANY (v_ids)
       GROUP BY cd.id
    LOOP
      INSERT INTO fin_participant_opening_balances (
        id, participant_id, retreat_id, amount, currency_code, kind, balance_kind,
        source_document, source_row_id, cutover_batch_id, request_hash, comment, created_by
      ) VALUES (
        fin_private_child_uuid(v_request_id, d.deal_id::text),
        v_participant, v_retreat, d.сумма, 'INR', 'credit', 'general',
        'Добор к загрузке рубежа: платёж подтверждён позже',
        d.deal_id::text, v_batch,
        fin_private_hash(jsonb_build_object(
          'command', 'resolve_missing_advance',
          'deal_id', lower(d.deal_id::text),
          'amount', fin_private_norm_money(d.сумма))),
        coalesce(v_note, format('Оплачено до запуска: %s (%s пл.)', d.расшифровка, d.платежей)),
        v_actor
      )
      ON CONFLICT (id) DO NOTHING;
      v_строк := v_строк + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'action', v_action, 'payments', array_length(v_ids, 1),
    'rows', v_строк, 'amount_inr', v_сумма), 'warnings', '[]'::jsonb);

EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF sqlerrm ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', sqlerrm, 'message', coalesce(nullif(v_detail, ''), sqlerrm)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', sqlerrm));
END;
$fn$;

REVOKE ALL ON FUNCTION fin_resolve_missing_advance(jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION fin_resolve_missing_advance(jsonb) TO authenticated;

-- Расшифровку (fin_get_integrity_details) не трогаем: она уже отдаёт всё,
-- что нужно для третьей кнопки (participant_id/retreat_id/who/amount) —
-- кнопка «Возврат» рисуется в JS без изменений в этой функции.
