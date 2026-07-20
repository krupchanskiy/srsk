-- =============================================================
-- Финмодуль: закрытие двух гэпов реализации перед прогоном
-- программы тестирования (ТЗ приёмочные сценарии 68 и 89).
--   68 — правка payer_contact_id платежа без активного refund
--   89 — видимость вложений для пользователя счёта
-- =============================================================

-- -------------------------------------------------------------
-- fin_update_payer — сменить плательщика операции (сц. 68).
-- Под блокировкой операции, с аудит-следом. payer_contact_id не в
-- списке замороженных полей fin_operations_guard → правится штатно.
-- При активном refund по платежу — отказ (payer разъедется с
-- возвратом). State-idempotent.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_update_payer(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_op_id uuid;
  v_new_payer uuid;
  v_reason text;
  v_op fin_operations%ROWTYPE;
  v_total_refunded numeric := 0;
  v_net record;
  p record;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Смену плательщика выполняет только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'operation_id', 'new_payer_contact_id', 'reason', 'audit_request_id'
  ]);
  v_op_id := fin_private_get_uuid(payload, 'operation_id', true);
  v_new_payer := fin_private_get_uuid(payload, 'new_payer_contact_id');  -- NULL допустим (аноним)
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');

  SELECT * INTO v_op FROM fin_operations WHERE id = v_op_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция не найдена';
  END IF;

  IF v_op.type NOT IN ('payment', 'donation') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Плательщик правится только у payment/donation';
  END IF;
  IF v_op.is_reversed THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция сторнирована — плательщик неизменен';
  END IF;
  IF v_new_payer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_new_payer) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Плательщик не найден в справочнике людей';
  END IF;

  -- state-идемпотентность
  IF v_op.payer_contact_id IS NOT DISTINCT FROM v_new_payer THEN
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('operation_id', v_op.id, 'noop', true),
      'warnings', '[]'::jsonb);
  END IF;

  -- активный refund у платежа блокирует смену плательщика (инвариант 2)
  IF v_op.type = 'payment' THEN
    FOR p IN SELECT id FROM fin_postings WHERE operation_id = v_op.id LOOP
      SELECT * INTO v_net FROM fin_private_net_refunded(p.id);
      v_total_refunded := v_total_refunded + v_net.net_amount;
    END LOOP;
    IF v_total_refunded > 0 THEN
      RAISE EXCEPTION 'payer_locked_by_refund'
        USING DETAIL = format('По платежу активный возврат (%s) — плательщик неизменен', v_total_refunded);
    END IF;
  END IF;

  PERFORM set_config('app.change_reason', COALESCE(v_reason, ''), true);
  IF payload->>'audit_request_id' IS NOT NULL THEN
    PERFORM set_config('app.request_id', payload->>'audit_request_id', true);
  END IF;

  UPDATE fin_operations SET payer_contact_id = v_new_payer WHERE id = v_op.id;

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('operation_id', v_op.id, 'payer_contact_id', v_new_payer),
    'warnings', '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

REVOKE ALL ON FUNCTION fin_update_payer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_update_payer(jsonb) TO authenticated;

-- -------------------------------------------------------------
-- fin_v_attachments — видимость для пользователя счёта (сц. 89, 77):
--   • posting-level: доступ к счёту этой проводки;
--   • operation-level (posting_id IS NULL): загрузил сам ИЛИ все
--     проводки операции на доступных ему счетах;
--   • object-level (закрытийные PDF): только admin/observer.
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_attachments AS
SELECT a.id, a.parent_type, a.parent_id, a.posting_id,
       a.storage_path, a.file_name, a.mime_type, a.size_bytes,
       a.uploaded_at, fin_private_person_name(
         (SELECT v.id FROM vaishnavas v WHERE v.user_id = a.uploaded_by LIMIT 1)
       ) AS uploaded_by_name
FROM fin_attachments a
WHERE fin_can_read_all()
   OR (
     a.posting_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM fin_postings p
       JOIN fin_account_access aa ON aa.account_id = p.account_id
       WHERE p.id = a.posting_id AND aa.user_id = auth.uid()
     )
   )
   OR (
     a.parent_type = 'operation' AND a.posting_id IS NULL
     AND (
       a.uploaded_by = auth.uid()
       OR (
         EXISTS (SELECT 1 FROM fin_postings p WHERE p.operation_id = a.parent_id)
         AND NOT EXISTS (
           SELECT 1 FROM fin_postings p
           WHERE p.operation_id = a.parent_id
             AND NOT EXISTS (
               SELECT 1 FROM fin_account_access aa
               WHERE aa.account_id = p.account_id AND aa.user_id = auth.uid()
             )
         )
       )
     )
   );

GRANT SELECT ON fin_v_attachments TO authenticated;
REVOKE ALL ON fin_v_attachments FROM anon;
