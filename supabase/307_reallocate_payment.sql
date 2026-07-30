-- Перераспределение проведённого платежа между участниками.
--
-- Случай ВГ: деньги принёс один (глава семьи, старший в группе), а записали всё
-- на него одного — надо разнести по участникам. Правка «на кого записано» у одной
-- строки уже есть (fin_update_posting_analytics), но там нельзя менять суммы:
-- денежные поля проводки неизменны, а удаление проводок запрещено — исправление
-- только сторно. Это правильно для журнала, но казначею нужна одна кнопка.
--
-- Поэтому операция делает сторно исходного платежа и заводит новый с новым
-- распределением — в одной транзакции, с одной причиной и одной записью в аудите.
-- Сторно встаёт на дату исходной операции (same_as_original), поэтому отчёты по
-- периодам и закрытые ретриты не «едут».
--
-- Ограничение ВГ «в рамках имеющейся суммы» — жёсткая проверка: сумма новых строк
-- обязана совпасть с суммой платежа. Ни рупии не появляется и не исчезает,
-- меняется только то, чей долг закрыт.

create or replace function fin_reallocate_payment(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_actor      uuid;
  v_req        uuid;
  v_op_id      uuid;
  v_reason     text;
  v_rows       jsonb;
  v_op         fin_operations%ROWTYPE;
  v_accounts   uuid[];
  v_objects    uuid[];
  v_account    uuid;
  v_object     uuid;
  v_channel    text;
  v_old_total  numeric;
  v_new_total  numeric;
  v_new_rows   jsonb := '[]'::jsonb;
  v_rev        jsonb;
  v_new        jsonb;
  r            jsonb;
  v_detail     text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Перераспределение платежа доступно только администратору финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY['request_id', 'operation_id', 'rows', 'reason']);
  v_req    := fin_private_get_uuid(payload, 'request_id', true);
  v_op_id  := fin_private_get_uuid(payload, 'operation_id', true);
  v_reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Причина перераспределения обязательна';
  END IF;

  v_rows := payload->'rows';
  IF v_rows IS NULL OR jsonb_typeof(v_rows) <> 'array' OR jsonb_array_length(v_rows) = 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'rows: требуется непустой массив строк';
  END IF;

  SELECT * INTO v_op FROM fin_operations WHERE id = v_op_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция не найдена';
  END IF;
  IF v_op.type <> 'payment' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Перераспределить можно только платёж участника';
  END IF;
  IF v_op.is_reversed THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Платёж уже сторнирован';
  END IF;

  -- Возврат по платежу превратил бы перераспределение в клубок ссылок:
  -- сначала пусть казначей разберётся с возвратом
  IF EXISTS (
    SELECT 1 FROM fin_postings p
    WHERE p.refund_of_posting_id IN (SELECT id FROM fin_postings WHERE operation_id = v_op_id)
  ) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'По платежу есть возврат — сначала разберитесь с ним';
  END IF;

  SELECT array_agg(DISTINCT account_id),
         array_agg(DISTINCT object_id),
         sum(amount),
         max(payment_channel::text)
    INTO v_accounts, v_objects, v_old_total, v_channel
  FROM fin_postings WHERE operation_id = v_op_id;

  -- Платёж, размазанный по нескольким счетам или мероприятиям, перераспределяется
  -- вручную: сторно и новый платёж. Здесь мы бы только запутали казначея.
  IF array_length(v_accounts, 1) <> 1 THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Платёж на нескольких счетах: перераспределите вручную — сторно и новый платёж';
  END IF;
  IF array_length(v_objects, 1) <> 1 OR v_objects[1] IS NULL THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Платёж по нескольким мероприятиям: перераспределите вручную — сторно и новый платёж';
  END IF;
  v_account := v_accounts[1];
  v_object  := v_objects[1];

  SELECT sum(fin_private_get_money(x.val, 'amount', true))
    INTO v_new_total
  FROM jsonb_array_elements(v_rows) AS x(val);

  IF fin_private_norm_money(v_new_total) <> fin_private_norm_money(v_old_total) THEN
    RAISE EXCEPTION 'amount_mismatch'
      USING DETAIL = format('Сумма строк %s не равна сумме платежа %s — перераспределяем в рамках имеющейся суммы',
                            fin_private_norm_money(v_new_total), fin_private_norm_money(v_old_total));
  END IF;

  -- Идемпотентность: request_id сторно выводим из request_id вызова, иначе
  -- повторный клик создал бы второе сторно
  v_rev := fin_create_reversal(jsonb_build_object(
    'request_id',            md5(v_req::text || ':reallocate-reversal')::uuid,
    'original_operation_id', v_op_id,
    'occurred_on_policy',    'same_as_original',
    'reason',                'Перераспределение платежа: ' || v_reason
  ));
  -- Именно RAISE, а не RETURN: возврат ошибки сохранил бы уже сделанное сторно, и
  -- платёж остался бы «отменён в пользу ничего». Исключение откатывает всё до входа
  -- в функцию, и казначей видит отказ с исходной причиной.
  IF NOT COALESCE((v_rev->>'ok')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_rev->'error'->>'code', 'internal_error')
      USING DETAIL = COALESCE(v_rev->'error'->>'message', 'Не удалось сторнировать платёж');
  END IF;

  FOR r IN SELECT x.val FROM jsonb_array_elements(v_rows) AS x(val)
  LOOP
    PERFORM fin_private_assert_keys(r, ARRAY['participant_id', 'participant_balance_kind', 'amount']);
    v_new_rows := v_new_rows || jsonb_build_array(jsonb_build_object(
      'id',                       gen_random_uuid(),
      'account_id',               v_account,
      'amount',                   fin_private_get_money(r, 'amount', true),
      'object_id',                v_object,
      'participant_id',           fin_private_get_uuid(r, 'participant_id', true),
      'participant_balance_kind', r->>'participant_balance_kind',
      'payment_channel',          v_channel
    ));
  END LOOP;

  v_new := fin_create_payment(jsonb_build_object(
    'request_id',       v_req,
    'occurred_on',      v_op.occurred_on,
    'payer_contact_id', v_op.payer_contact_id,
    'comment',          v_op.comment,
    'reason',           'Перераспределение платежа: ' || v_reason,
    'rows',             v_new_rows
  ));
  IF NOT COALESCE((v_new->>'ok')::boolean, false) THEN
    RAISE EXCEPTION '%', COALESCE(v_new->'error'->>'code', 'internal_error')
      USING DETAIL = COALESCE(v_new->'error'->>'message', 'Не удалось создать платёж с новым распределением');
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'reversal_operation_id', v_rev->'result'->>'operation_id',
    'payment', v_new->'result'
  ), 'warnings', '[]'::jsonb);

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

grant execute on function fin_reallocate_payment(jsonb) to authenticated;
