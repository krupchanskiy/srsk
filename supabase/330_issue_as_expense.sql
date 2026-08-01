-- Выдача под отчёт, которая сразу становится расходом получателя.
--
-- Ответ ВГ на снимок экрана (01.08.2026): «Да и если ставим галочку — учесть
-- сразу как расход, помимо прихода в департаменте получателя указываем и то
-- кто, на что и сколько потратил».
--
-- Олег выдал Кухне 5000 на продукты, и деньги уже потрачены. Раньше это были
-- две ручные операции: провести выдачу, потом отдельно завести расход Кухни.
-- Теперь заявка с галочкой делает обе одной транзакцией: перевод на подотчёт
-- получателя и его же расход по указанным статьям. У получателя ноль на руках,
-- расход числится за ним.
--
-- Механизм тот же, что у разбивки расхода по департаментам (325), только
-- получатель один и он назван в самой заявке.

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
  v_has_dept boolean := false;
  v_main uuid; v_seq int := 0; v_detail text;
  v_author text; v_payer_dept text;
  v_summary text := ''; v_bal_before numeric;
  v_suppress boolean := false; v_tgt_dept text; v_who text;
  v_grp record; v_tgt_acc uuid; v_grp_op uuid;
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
    -- У расхода строки делят трату между статьями и департаментами.
    -- У выдачи они означают другое: «эти деньги получатель уже потратил» —
    -- поэтому департамент в строке не нужен, он назван в самой заявке.
    IF v_d.kind = 'transfer' THEN
      SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
       WHERE NULLIF(r->>'department_id','') IS NOT NULL;
      IF v_bad > 0 THEN
        RETURN jsonb_build_object('ok', false, 'error',
          'У выдачи получатель указан в самой заявке — департамент в строке лишний');
      END IF;
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

    -- Департамент-получатель: тот, за кем числится трата.
    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'department_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_departments d WHERE d.id = (r->>'department_id')::uuid);
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'В разбивке указан несуществующий департамент');
    END IF;

    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'department_id','')::uuid = v_d.department_id;
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error',
        'Департамент-получатель совпадает с автором заявки: оставьте поле пустым');
    END IF;

    SELECT count(*) > 0 INTO v_has_dept FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'department_id','') IS NOT NULL;

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

  SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                  NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''))
    INTO v_author FROM vaishnavas v WHERE v.id = v_d.author_vaishnava_id;
  SELECT name INTO v_payer_dept FROM fin_departments WHERE id = v_d.department_id;

  -- Пока пишем — триггер молчит, сообщения соберём сами. Глушим только там,
  -- где одна заявка даёт несколько проводок: иначе чат завалит обрывками.
  v_suppress := v_has_dept OR (v_d.kind = 'transfer' AND p_rows IS NOT NULL);
  IF v_suppress THEN PERFORM set_config('tg.suppress_chat_notify', '1', true); END IF;

  -- ---------- запись: всё или ничего ----------
  BEGIN
    IF v_d.kind = 'expense' THEN
      v_acc := fin_dept_account(v_d.department_id, v_d.currency);
      v_comment := format('%s (из чата: %s)', btrim(v_d.purpose), v_d.raw_text);
      -- запоминаем остаток до заявки: о минусе скажем один раз и по итогу
      IF v_has_dept THEN v_bal_before := fin_private_account_balance(v_acc); END IF;

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
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
         WHERE NULLIF(r->>'department_id','') IS NULL;
      END IF;

      -- своих строк может не остаться: всю сумму разнесли по чужим департаментам
      IF v_rows IS NOT NULL THEN
        v_res := fin_create_expense(jsonb_build_object(
          'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
          'comment', v_comment, 'rows', v_rows));
        IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'chat_post_failed'
            USING DETAIL = COALESCE(v_res#>>'{error,message}', 'не удалось создать расход');
        END IF;
        v_main := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
        INSERT INTO tg_draft_operations (draft_id, operation_id, role, seq)
        VALUES (v_d.id, v_main, 'expense', 0)
        ON CONFLICT DO NOTHING;
      END IF;

      -- ---------- чужие департаменты ----------
      FOR v_grp IN
        SELECT g.dept, g.as_expense, g.total, g.grp_rows, d.name AS dept_name
          FROM (
            SELECT (r->>'department_id')::uuid AS dept,
                   COALESCE((r->>'as_expense')::boolean, true) AS as_expense,
                   sum((r->>'amount')::numeric) AS total,
                   jsonb_agg(r ORDER BY ord) AS grp_rows
              FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS t(r, ord)
             WHERE NULLIF(r->>'department_id','') IS NOT NULL
             GROUP BY 1, 2
          ) g
          JOIN fin_departments d ON d.id = g.dept
         ORDER BY d.name, g.as_expense
      LOOP
        v_seq := v_seq + 1;
        v_tgt_acc := fin_dept_account(v_grp.dept, v_d.currency);
        IF v_tgt_acc = v_acc THEN
          RAISE EXCEPTION 'chat_post_failed'
            USING DETAIL = 'Счёт получателя совпадает со счётом плательщика';
        END IF;

        -- деньги уехали от того, кто платил, к тому, за кем числится трата
        v_res := fin_create_transfer(jsonb_build_object(
          'request_id', fin_private_child_uuid(v_d.id, 'chat-transfer-' || v_seq::text),
          'occurred_on', v_d.created_at::date,
          'source_account_id', v_acc, 'target_account_id', v_tgt_acc,
          'source_amount', v_grp.total, 'target_amount', v_grp.total,
          'comment', format('%s — за департамент «%s» (из чата: %s)',
                            btrim(v_d.purpose), v_grp.dept_name, v_d.raw_text)));
        IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'chat_post_failed'
            USING DETAIL = format('«%s»: %s', v_grp.dept_name,
                                  COALESCE(v_res#>>'{error,message}', 'не удалось передать сумму'));
        END IF;
        v_op := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
        v_main := COALESCE(v_main, v_op);
        INSERT INTO tg_draft_operations (draft_id, operation_id, role, seq)
        VALUES (v_d.id, v_op, 'transfer', v_seq)
        ON CONFLICT DO NOTHING;

        IF v_grp.as_expense THEN
          SELECT jsonb_agg(jsonb_build_object(
                   'id', fin_private_child_uuid(v_d.id, format('chat-dept-row-%s-%s', v_seq, ord)),
                   'account_id', v_tgt_acc,
                   'amount', (r->>'amount')::numeric,
                   'category_id', (r->>'category_id')::uuid,
                   'object_id', NULLIF(r->>'object_id','')::uuid) ORDER BY ord)
            INTO v_rows
            FROM jsonb_array_elements(v_grp.grp_rows) WITH ORDINALITY AS t(r, ord);

          v_res := fin_create_expense(jsonb_build_object(
            'request_id', fin_private_child_uuid(v_d.id, 'chat-dept-expense-' || v_seq::text),
            'occurred_on', v_d.created_at::date,
            'comment', format('%s — оплатил «%s» (из чата: %s)',
                              btrim(v_d.purpose), v_payer_dept, v_d.raw_text),
            'rows', v_rows));
          IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
            RAISE EXCEPTION 'chat_post_failed'
              USING DETAIL = format('«%s»: %s', v_grp.dept_name,
                                    COALESCE(v_res#>>'{error,message}', 'не удалось провести расход'));
          END IF;
          v_grp_op := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
          INSERT INTO tg_draft_operations (draft_id, operation_id, role, seq)
          VALUES (v_d.id, v_grp_op, 'dept_expense', v_seq)
          ON CONFLICT DO NOTHING;

          PERFORM tg_notify_dept_expense(v_grp_op, v_tgt_acc,
                                         COALESCE(v_author, v_payer_dept), btrim(v_d.purpose));
        ELSE
          PERFORM tg_notify_dept_incoming(v_grp.dept, v_grp.total, v_d.currency,
                                          btrim(v_d.purpose), COALESCE(v_author, v_payer_dept));
        END IF;

        v_summary := v_summary || format(E'\n• %s — %s', tg_escape(v_grp.dept_name),
                                         fin_fmt_money(v_grp.total, v_d.currency));
      END LOOP;

    ELSE
      IF v_d.target_department_id IS NULL THEN
        RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'no_target';
      END IF;

      IF v_d.source_account_id IS NOT NULL THEN
        SELECT currency_code INTO v_src_cur FROM fin_accounts WHERE id = v_d.source_account_id;
        IF v_src_cur IS DISTINCT FROM v_d.currency THEN
          RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'Валюта счёта не совпадает с валютой заявки';
        END IF;
        v_acc := v_d.source_account_id;
      ELSE
        v_acc := fin_dept_account(v_d.department_id, v_d.currency);
      END IF;

      v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);
      IF v_tgt = v_acc THEN
        RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'Источник и получатель совпадают';
      END IF;
      IF p_rows IS NOT NULL THEN v_bal_before := fin_private_account_balance(v_acc); END IF;

      v_res := fin_create_transfer(jsonb_build_object(
        'request_id', v_d.id, 'occurred_on', v_d.created_at::date,
        'source_account_id', v_acc, 'target_account_id', v_tgt,
        'source_amount', v_d.amount, 'target_amount', v_d.amount,
        'comment', format('Из чата: %s', v_d.raw_text)));
      IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'chat_post_failed'
          USING DETAIL = COALESCE(v_res#>>'{error,message}', 'не удалось провести выдачу');
      END IF;
      v_main := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
      INSERT INTO tg_draft_operations (draft_id, operation_id, role, seq)
      VALUES (v_d.id, v_main, 'transfer', 0)
      ON CONFLICT DO NOTHING;

      -- ---------- «уже потрачено»: расход получателя следом за выдачей ----------
      IF p_rows IS NOT NULL THEN
        SELECT name INTO v_tgt_dept FROM fin_departments WHERE id = v_d.target_department_id;

        SELECT jsonb_agg(jsonb_build_object(
                 'id', fin_private_child_uuid(v_d.id, 'chat-issue-row-' || ord::text),
                 'account_id', v_tgt,
                 'amount', (r->>'amount')::numeric,
                 'category_id', (r->>'category_id')::uuid,
                 'object_id', NULLIF(r->>'object_id','')::uuid) ORDER BY ord)
          INTO v_rows
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord);

        v_res := fin_create_expense(jsonb_build_object(
          'request_id', fin_private_child_uuid(v_d.id, 'chat-issue-expense'),
          'occurred_on', v_d.created_at::date,
          'comment', format('%s — выдано «%s» и сразу потрачено (из чата: %s)',
                            COALESCE(NULLIF(btrim(v_d.purpose), ''), 'Расход департамента'),
                            v_payer_dept, v_d.raw_text),
          'rows', v_rows));
        IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
          RAISE EXCEPTION 'chat_post_failed'
            USING DETAIL = format('«%s»: %s', v_tgt_dept,
                                  COALESCE(v_res#>>'{error,message}', 'не удалось провести расход'));
        END IF;
        v_grp_op := NULLIF(v_res#>>'{result,operation_id}', '')::uuid;
        INSERT INTO tg_draft_operations (draft_id, operation_id, role, seq)
        VALUES (v_d.id, v_grp_op, 'dept_expense', 1)
        ON CONFLICT DO NOTHING;

        -- «Потратил» — сам получатель: деньги выдали ему, он их и израсходовал
        SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                        NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''))
          INTO v_who
          FROM fin_departments d
          LEFT JOIN vaishnavas v ON v.id = d.responsible_person_id
         WHERE d.id = v_d.target_department_id;

        PERFORM tg_notify_dept_expense(v_grp_op, v_tgt, COALESCE(v_who, v_tgt_dept),
                                       COALESCE(NULLIF(btrim(v_d.purpose), ''), v_d.raw_text));
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- вложенный блок — это точка отката: всё записанное выше отменено,
    -- заявка осталась pending. Полупроведённой заявки не бывает.
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(NULLIF(v_detail, ''), SQLERRM));
  END;

  UPDATE tg_drafts SET status='posted', operation_id=v_main, resolved_by=v_actor, resolved_at=now()
   WHERE id = v_d.id;
  PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👍');

  -- Сводка автору — вместо обрывочных сообщений от триггера
  IF v_suppress THEN
    IF v_has_dept THEN
      PERFORM tg_send_chat(v_d.chat_id,
        format('✅ <b>Проведено: %s</b>', fin_fmt_money(v_d.amount, v_d.currency))
        || COALESCE(E'\n' || tg_escape(NULLIF(btrim(v_d.purpose), '')), '')
        || E'\nОтнесено на департаменты:' || v_summary
        || format(E'\nНа руках у «%s»: %s', tg_escape(v_payer_dept),
                  fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
        v_d.card_message_id);
    ELSE
      PERFORM tg_send_chat(v_d.chat_id,
        format('✅ <b>Выдано «%s»: %s</b>', tg_escape(v_tgt_dept),
               fin_fmt_money(v_d.amount, v_d.currency))
        || E'\nСразу учтено как расход получателя'
        || format(E'\nНа руках у «%s»: %s', tg_escape(v_payer_dept),
                  fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
        v_d.card_message_id);
    END IF;

    -- триггер на проводках молчал: считаем переход через ноль за всю заявку
    IF COALESCE(v_bal_before, 0) >= 0 AND fin_private_account_balance(v_acc) < 0 THEN
      PERFORM tg_notify_negative(v_acc);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'operation_id', v_main);
END;
$function$;
