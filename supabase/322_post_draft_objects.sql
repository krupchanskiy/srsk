-- Проведение заявки из чата: строка разбивки несёт ретрит.
--
-- Замечание ВГ (31.07.2026): «тут нет куда мы эту трату записываем (как трата
-- ретрита или набора из нескольких ретритов — да обязано именно нескольких!!!,
-- те трата делится между ретритами/событиями)».
--
-- Этап 1 из двух: ретриты. Движок расхода уже принимает object_id в строке,
-- поэтому здесь только проброс и проверка. Деление на доли и округление делает
-- интерфейс: сюда приходят готовые строки, а сумма строк, как и раньше, обязана
-- сойтись с суммой заявки до копейки.
--
-- Этап 2 (отдельно): департамент-получатель и «учесть как его расход».

create or replace function tg_post_draft(p_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_acc uuid; v_tgt uuid; v_cat uuid;
  v_res jsonb; v_op uuid; v_comment text; v_src_cur text;
  v_rows jsonb; v_sum numeric; v_bad int;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_d.kind IS NULL OR v_d.currency IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указан вид или валюта');
  END IF;
  IF v_d.kind = 'expense' AND COALESCE(length(btrim(v_d.purpose)), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указано, на что потрачено');
  END IF;

  -- ---------- проверка разбивки ----------
  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) = 'array' AND jsonb_array_length(p_rows) > 0 THEN
    IF v_d.kind <> 'expense' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Разбить по статьям можно только расход');
    END IF;

    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE COALESCE((r->>'amount')::numeric, 0) <= 0;
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'В разбивке есть строка с нулевой или отрицательной суммой');
    END IF;

    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NOT EXISTS (SELECT 1 FROM fin_categories c
                        WHERE c.id = NULLIF(r->>'category_id','')::uuid
                          AND c.is_active AND c.direction = 'out');
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'В разбивке есть строка без статьи расхода');
    END IF;

    -- Ретрит необязателен (бывают траты ашрама вне событий), но если указан —
    -- он должен существовать: иначе трата молча уедет мимо отчёта ретрита.
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'object_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_accounting_objects ao
                        WHERE ao.id = (r->>'object_id')::uuid);
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'В разбивке указан несуществующий ретрит');
    END IF;

    -- Сумма строк обязана сойтись с суммой заявки до копейки: иначе в учёт
    -- попало бы не то, что человек написал в чате, и расхождение всплыло бы
    -- только на сверке.
    SELECT COALESCE(sum((r->>'amount')::numeric), 0) INTO v_sum FROM jsonb_array_elements(p_rows) r;
    IF round(v_sum, 2) <> round(v_d.amount, 2) THEN
      RETURN jsonb_build_object('ok', false, 'error',
        format('Сумма строк %s не сходится с суммой заявки %s', v_sum, v_d.amount));
    END IF;
  ELSE
    p_rows := NULL;
  END IF;

  IF v_d.kind = 'expense' THEN
    v_acc := fin_dept_account(v_d.department_id, v_d.currency);
    v_comment := format('%s (из чата: %s)', btrim(v_d.purpose), v_d.raw_text);

    IF p_rows IS NULL THEN
      v_cat := COALESCE(v_d.category_id, (SELECT id FROM fin_categories WHERE code='dept_expense'));
      v_rows := jsonb_build_array(jsonb_build_object(
        'id', fin_private_child_uuid(v_d.id, 'chat-expense-row'),
        'account_id', v_acc, 'amount', v_d.amount, 'category_id', v_cat));
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'id', fin_private_child_uuid(v_d.id, 'chat-expense-row-' || ord::text),
               'account_id', v_acc,
               'amount', (r->>'amount')::numeric,
               'category_id', (r->>'category_id')::uuid,
               'object_id', NULLIF(r->>'object_id','')::uuid) ORDER BY ord)
        INTO v_rows
        FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord);
    END IF;

    v_res := fin_create_expense(jsonb_build_object(
      'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
      'comment', v_comment, 'rows', v_rows));
  ELSE
    IF v_d.target_department_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'no_target'); END IF;

    IF v_d.source_account_id IS NOT NULL THEN
      SELECT currency_code INTO v_src_cur FROM fin_accounts WHERE id = v_d.source_account_id;
      IF v_src_cur IS DISTINCT FROM v_d.currency THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Валюта счёта не совпадает с валютой заявки');
      END IF;
      v_acc := v_d.source_account_id;
    ELSE
      v_acc := fin_dept_account(v_d.department_id, v_d.currency);
    END IF;

    v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);
    IF v_tgt = v_acc THEN RETURN jsonb_build_object('ok', false, 'error', 'Источник и получатель совпадают'); END IF;
    v_res := fin_create_transfer(jsonb_build_object(
      'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
      'source_account_id', v_acc, 'target_account_id', v_tgt,
      'source_amount', v_d.amount, 'target_amount', v_d.amount,
      'comment', format('Из чата: %s', v_d.raw_text)));
  END IF;

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_res#>>'{error,message}', 'fail'));
  END IF;

  v_op := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
  UPDATE tg_drafts SET status='posted', operation_id=v_op, resolved_by=v_actor, resolved_at=now() WHERE id = v_d.id;
  PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👍');
  RETURN jsonb_build_object('ok', true, 'operation_id', v_op);
END;
$function$;
