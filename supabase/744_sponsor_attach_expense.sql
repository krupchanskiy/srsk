-- 744: «это ретрит» прямо из плашки спонсора (ВГ 23.10.2026: ссылка в ДДС не находила операцию).
-- Ставит объект ретрита всем строкам траты без объекта — через fin_update_posting_analytics
-- (те же проверки, журнал и правила закрытия, что у карандаша в ДДС). Зачёт спонсору — сам (740).

CREATE OR REPLACE FUNCTION fin_sponsor_attach(p_retreat uuid, p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := fin_actor();
  v_obj uuid;
  p fin_postings%ROWTYPE;
  v_res jsonb;
  n int := 0;
BEGIN
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Доступно администратору финансов';
  END IF;
  SELECT id INTO v_obj FROM fin_accounting_objects WHERE retreat_id = p_retreat;
  IF v_obj IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У ретрита нет учётного объекта';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_operations WHERE id = p_operation AND type = 'expense' AND NOT is_reversed) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Трата не найдена или сторнирована';
  END IF;
  FOR p IN SELECT * FROM fin_postings WHERE operation_id = p_operation AND object_id IS NULL ORDER BY ledger_seq LOOP
    v_res := fin_update_posting_analytics(jsonb_build_object(
      'posting_id', p.id,
      'expected_analytics_hash', fin_private_analytics_hash(p.category_id, p.cost_center_id, p.object_id,
                                                            p.participant_id, p.participant_balance_kind, p.contractor_id),
      'target', jsonb_build_object('category_id', p.category_id, 'cost_center_id', p.cost_center_id,
                                   'object_id', v_obj, 'participant_id', p.participant_id,
                                   'participant_balance_kind', p.participant_balance_kind, 'contractor_id', p.contractor_id),
      'reason', 'Отнесено к ретриту из блока спонсора',
      'audit_request_id', gen_random_uuid()));
    IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'attach_failed' USING DETAIL = COALESCE(v_res#>>'{error,message}', 'Не удалось поставить ретрит');
    END IF;
    n := n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'postings', n);
END;
$$;

GRANT EXECUTE ON FUNCTION fin_sponsor_attach(uuid, uuid) TO authenticated;
