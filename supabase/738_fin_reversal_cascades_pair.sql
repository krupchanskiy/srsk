-- =============================================================
-- Сторно половины пары «выдано … и сразу потрачено» сторнирует и вторую половину.
--
-- Заявка из чата с галочкой «сразу потрачено» (330) и разбивка расхода по
-- департаментам (325) создают две операции: перевод департаменту и его же
-- расход этих денег. Связь — общая заявка в tg_draft_operations. Сторно
-- работало по одной операции, и 06.10 «Выдал зп Папе 29 800₹» отменили только
-- переводом: расход остался, в ведомости у Бридж Кишора лишняя выплата, а
-- «Кухня (₹)» занижена на 29 800. Так же в августе на «Завод (₹)» и
-- «Стройка (₹)» остались переводы без расходов (ВГ 22.10).
--
-- Пара: перевод и расход одной заявки, где расход списан со счёта, на который
-- пришёл перевод. Остальные операции заявки (основной расход плательщика,
-- выдачи другим департаментам) не трогаем — они от этой пары не зависят.
-- Парная операция сторнируется тем же вызовом, с той же причиной и датой;
-- в ответ добавляется предупреждение, что сторнировано и она.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_create_reversal(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_policy text;
  v_on date;
  v_reason text;
  v_hash text;
  v_existing jsonb;
  v_source fin_operations%ROWTYPE;
  v_objs_pre uuid[];
  v_objs_now uuid[];
  v_closed uuid[];
  v_accounts uuid[];
  v_net record;
  v_total_refunded numeric := 0;
  v_warnings jsonb := '[]'::jsonb;
  p fin_postings%ROWTYPE;
  v_attempt int := 0;
  v_acc fin_accounts%ROWTYPE;
  v_detail text;
  v_pair record;
  v_pair_res jsonb;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Сторно проводит только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'original_operation_id', 'occurred_on_policy', 'occurred_on', 'reason']);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина сторно обязательна';
  END IF;
  v_policy := COALESCE(NULLIF(payload->>'occurred_on_policy', ''), 'same_as_original');
  IF v_policy NOT IN ('same_as_original', 'actual_reverse_date') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'occurred_on_policy: same_as_original | actual_reverse_date';
  END IF;
  IF v_policy = 'actual_reverse_date' THEN
    v_on := fin_private_get_date(payload, 'occurred_on', true);
  END IF;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_reversal',
    'original_operation_id', lower(payload->>'original_operation_id'),
    'occurred_on_policy', v_policy,
    'occurred_on', v_on,
    'reason', v_reason
  ));

  v_existing := fin_private_idempotency_check(v_request_id, v_hash);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', v_existing, 'warnings', '[]'::jsonb);
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 3 THEN
      RAISE EXCEPTION 'internal_error' USING DETAIL = 'Не удалось стабилизировать объекты исходной операции';
    END IF;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_pre
    FROM fin_postings WHERE operation_id = fin_private_get_uuid(payload, 'original_operation_id', true);

    IF v_objs_pre IS NOT NULL THEN
      PERFORM 1 FROM fin_accounting_objects WHERE id = ANY (v_objs_pre) ORDER BY id FOR UPDATE;
    END IF;

    SELECT * INTO v_source FROM fin_operations
    WHERE id = fin_private_get_uuid(payload, 'original_operation_id', true)
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Исходная операция не найдена';
    END IF;
    PERFORM 1 FROM fin_postings WHERE operation_id = v_source.id FOR UPDATE;

    SELECT array_agg(DISTINCT object_id) FILTER (WHERE object_id IS NOT NULL) INTO v_objs_now
    FROM fin_postings WHERE operation_id = v_source.id;
    EXIT WHEN v_objs_now IS NOT DISTINCT FROM v_objs_pre;
  END LOOP;

  IF v_source.type = 'reversal' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Сторно сторно запрещено — повторно введите исходную операцию';
  END IF;
  IF v_source.is_reversed THEN
    RAISE EXCEPTION 'operation_already_reversed' USING DETAIL = 'Операция уже сторнирована';
  END IF;

  IF v_source.type = 'payment' THEN
    FOR p IN SELECT * FROM fin_postings WHERE operation_id = v_source.id
    LOOP
      SELECT * INTO v_net FROM fin_private_net_refunded(p.id);
      v_total_refunded := v_total_refunded + v_net.net_amount;
    END LOOP;
    IF v_total_refunded > 0 THEN
      RAISE EXCEPTION 'reversal_not_allowed_after_refund'
        USING DETAIL = format('По платежу уже возвращено %s — доступен только дополнительный возврат остатка', v_total_refunded);
    END IF;
  END IF;

  IF v_policy = 'same_as_original' THEN
    v_on := v_source.occurred_on;
  END IF;

  SELECT array_agg(DISTINCT c.object_id) INTO v_closed
  FROM fin_object_closures c WHERE c.object_id = ANY (COALESCE(v_objs_now, '{}')) AND c.is_initial;

  SELECT array_agg(DISTINCT account_id) INTO v_accounts FROM fin_postings WHERE operation_id = v_source.id;
  PERFORM 1 FROM fin_accounts WHERE id = ANY (v_accounts) ORDER BY id FOR UPDATE;

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, original_operation_id, reason, created_by)
  VALUES (v_request_id, v_hash, 'reversal', v_on, 'not_required', v_source.id, v_reason, v_actor);

  FOR p IN SELECT * FROM fin_postings WHERE operation_id = v_source.id ORDER BY ledger_seq
  LOOP
    INSERT INTO fin_postings (
      id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, cost_center_id, object_id,
      is_post_close, participant_id, participant_balance_kind,
      contractor_id, payment_channel
    ) VALUES (
      fin_private_child_uuid(v_request_id, p.id::text), v_request_id, p.account_id,
      CASE p.direction WHEN 'in' THEN 'out'::fin_direction ELSE 'in'::fin_direction END,
      p.amount, p.currency_code, p.amount_base, p.rate_used,
      p.category_id, p.cost_center_id, p.object_id,
      (p.object_id IS NOT NULL AND v_closed IS NOT NULL AND p.object_id = ANY (v_closed)),
      p.participant_id, p.participant_balance_kind,
      p.contractor_id, p.payment_channel
    );
  END LOOP;

  UPDATE fin_operations SET is_reversed = true WHERE id = v_source.id;

  IF v_closed IS NOT NULL THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = ANY (v_closed);
  END IF;

  FOR v_acc IN SELECT * FROM fin_accounts WHERE id = ANY (v_accounts)
  LOOP
    IF v_acc.kind = 'real' AND fin_private_account_balance(v_acc.id) < 0 THEN
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'real_negative_balance',
        'message', format('Реальный счёт «%s» ушёл в минус — требуется внеплановая сверка', v_acc.name)));
    END IF;
  END LOOP;

  -- Вторая половина пары «выдано … и сразу потрачено»: перевод и расход одной
  -- заявки, расход — со счёта, куда пришёл перевод (738)
  FOR v_pair IN
    SELECT DISTINCT o.id
      FROM tg_draft_operations ts
      JOIN tg_draft_operations tp ON tp.draft_id = ts.draft_id AND tp.operation_id <> ts.operation_id
      JOIN fin_operations o ON o.id = tp.operation_id
     WHERE ts.operation_id = v_source.id
       AND NOT o.is_reversed AND o.type <> 'reversal'
       AND ((v_source.type = 'transfer' AND o.type = 'expense' AND EXISTS (
               SELECT 1 FROM fin_postings tin JOIN fin_postings ex ON ex.account_id = tin.account_id
                WHERE tin.operation_id = v_source.id AND tin.direction = 'in'
                  AND ex.operation_id = o.id AND ex.direction = 'out'))
         OR (v_source.type = 'expense' AND o.type = 'transfer' AND EXISTS (
               SELECT 1 FROM fin_postings tin JOIN fin_postings ex ON ex.account_id = tin.account_id
                WHERE tin.operation_id = o.id AND tin.direction = 'in'
                  AND ex.operation_id = v_source.id AND ex.direction = 'out')))
  LOOP
    v_pair_res := fin_create_reversal(jsonb_build_object(
      'request_id', fin_private_child_uuid(v_request_id, 'pair-' || v_pair.id::text),
      'original_operation_id', v_pair.id,
      'occurred_on_policy', 'actual_reverse_date',
      'occurred_on', v_on,
      'reason', v_reason));
    IF NOT COALESCE((v_pair_res->>'ok')::boolean, false) THEN
      RAISE EXCEPTION 'pair_reversal_failed'
        USING DETAIL = 'Не удалось сторнировать парную операцию: '
                       || COALESCE(v_pair_res#>>'{error,message}', 'ошибка');
    END IF;
    v_warnings := v_warnings || COALESCE(v_pair_res->'warnings', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object(
           'code', 'pair_reversed',
           'message', CASE WHEN v_source.type = 'transfer'
                           THEN 'Вместе с выдачей сторнирован и расход этих денег'
                           ELSE 'Вместе с расходом сторнирована и выдача этих денег' END));
  END LOOP;

  RETURN jsonb_build_object('ok', true,
    'result', fin_private_operation_result(v_request_id),
    'warnings', v_warnings);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
