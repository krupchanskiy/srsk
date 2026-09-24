-- Держатели наличных внутри одного счёта департамента (идея ВГ, 22.09.2026).
-- Счёт департамента остаётся один — как и был, никакой правки fin_dept_account
-- и её ~20 вызывающих мест. Вместо этого у каждой проводки по счёту появляется
-- необязательная метка «у кого на руках»: расход бот ставит по автору
-- сообщения, приход — по названному получателю (это отдельный шаг следом).
-- Итог по департаменту как был суммой всех проводок счёта, так и остался —
-- отчёты меняются только добавлением разбивки по держателям.
--
-- fin_department_holders — реестр «кто вообще может держать наличные этого
-- департамента»: нужен для автосопоставления по автору в боте, для выпадашки
-- на сайте и для проверки личности при подтверждении передачи (следующий шаг).

ALTER TABLE public.fin_postings
  ADD COLUMN holder_person_id uuid REFERENCES public.vaishnavas(id);

CREATE INDEX fin_postings_holder_idx ON public.fin_postings (account_id, holder_person_id)
  WHERE holder_person_id IS NOT NULL;

CREATE TABLE public.fin_department_holders (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.fin_departments(id),
  vaishnava_id   uuid not null references public.vaishnavas(id),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  unique (department_id, vaishnava_id)
);

ALTER TABLE public.fin_department_holders ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_department_holders_admin_all ON public.fin_department_holders
  FOR ALL TO authenticated
  USING (fin_is_admin(auth.uid()))
  WITH CHECK (fin_is_admin(auth.uid()));

CREATE OR REPLACE FUNCTION public.fin_set_department_holder(p_department uuid, p_vaishnava uuid, p_active boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  INSERT INTO fin_department_holders (department_id, vaishnava_id, is_active, created_by)
  VALUES (p_department, p_vaishnava, p_active, auth.uid())
  ON CONFLICT (department_id, vaishnava_id) DO UPDATE SET is_active = p_active;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_set_department_holder(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_set_department_holder(uuid, uuid, boolean) TO authenticated;

-- Разметка держателя расхода из чата: если автор сообщения — зарегистрированный
-- держатель ЭТОГО департамента, помечаем его строку расхода. Правим точечным
-- UPDATE по уже известному детерминированному id проводки — так контракт
-- fin_create_expense/fin_create_transfer не меняется вообще, задел безопасен
-- для всех остальных мест, где эти функции вызываются не из бота.
CREATE OR REPLACE FUNCTION public.tg_post_draft(p_id uuid, p_rows jsonb, p_source_account uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_acc uuid; v_tgt uuid; v_cat uuid;
  v_res jsonb; v_op uuid; v_comment text; v_src_cur text;
  v_rows jsonb; v_sum numeric; v_bad int;
  v_has_dept boolean := false;
  v_own_split boolean := false; v_own_summary text;
  v_main uuid; v_seq int := 0; v_detail text;
  v_author text; v_payer_dept text;
  v_summary text := ''; v_bal_before numeric;
  v_suppress boolean := false; v_tgt_dept text; v_who text;
  v_grp record; v_tgt_acc uuid; v_grp_op uuid;
  v_ptag record;
  v_chat_note text;
  v_holder uuid;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  v_chat_note := CASE WHEN btrim(COALESCE(v_d.purpose, '')) = btrim(COALESCE(v_d.raw_text, ''))
                      THEN '' ELSE format(' (из чата: %s)', v_d.raw_text) END;
  IF v_d.kind IS NULL OR v_d.currency IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указан вид или валюта');
  END IF;
  IF v_d.kind = 'expense' AND COALESCE(length(btrim(v_d.purpose)), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указано, на что потрачено');
  END IF;

  -- держатель: автор заявки, если он зарегистрирован как держатель ИМЕННО
  -- этого департамента (реестр fin_department_holders)
  IF v_d.author_vaishnava_id IS NOT NULL THEN
    SELECT vaishnava_id INTO v_holder FROM fin_department_holders
     WHERE department_id = v_d.department_id AND vaishnava_id = v_d.author_vaishnava_id AND is_active;
  END IF;

  IF p_rows IS NOT NULL AND jsonb_typeof(p_rows) = 'array' AND jsonb_array_length(p_rows) > 0 THEN
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

    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'object_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_accounting_objects ao
                        WHERE ao.id = (r->>'object_id')::uuid);
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'В разбивке указан несуществующий ретрит');
    END IF;

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

    SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'payroll_position_id','') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM fin_payroll_positions pp
                        WHERE pp.id = (r->>'payroll_position_id')::uuid AND pp.effective_to IS NULL);
    IF v_bad > 0 THEN
      RETURN jsonb_build_object('ok', false, 'error',
        'В разбивке указана несуществующая или уже закрытая позиция ведомости');
    END IF;

    SELECT count(*) > 0 INTO v_has_dept FROM jsonb_array_elements(p_rows) r
     WHERE NULLIF(r->>'department_id','') IS NOT NULL;

    SELECT (v_d.kind = 'expense') AND
           (SELECT count(*) FROM jsonb_array_elements(p_rows) r
             WHERE NULLIF(r->>'department_id','') IS NULL) > 1
      INTO v_own_split;

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

  v_suppress := v_has_dept OR (v_d.kind = 'transfer' AND p_rows IS NOT NULL) OR v_own_split;
  IF v_suppress THEN PERFORM set_config('tg.suppress_chat_notify', '1', true); END IF;

  BEGIN
    IF v_d.kind = 'expense' THEN
      IF COALESCE(p_source_account, v_d.source_account_id) IS NOT NULL THEN
        v_acc := COALESCE(p_source_account, v_d.source_account_id);
        IF (SELECT currency_code FROM fin_accounts WHERE id = v_acc) IS DISTINCT FROM v_d.currency THEN
          RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'Валюта счёта не совпадает с валютой заявки';
        END IF;
      ELSE
        v_acc := fin_dept_account(v_d.department_id, v_d.currency);
      END IF;
      v_comment := btrim(v_d.purpose) || v_chat_note;
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

      IF v_own_split THEN
        SELECT string_agg(format('• %s — %s', tg_escape(c.name),
                                 fin_fmt_money((r->>'amount')::numeric, v_d.currency)),
                          E'\n' ORDER BY (r->>'amount')::numeric DESC)
          INTO v_own_summary
          FROM jsonb_array_elements(p_rows) r
          JOIN fin_categories c ON c.id = (r->>'category_id')::uuid
         WHERE NULLIF(r->>'department_id','') IS NULL;
      END IF;

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

        -- держатель проставляется точечно, только на строки самого департамента
        -- (v_acc) — строки, отнесённые на другой департамент (department_id
        -- в p_rows), к держателям ЭТОГО департамента отношения не имеют.
        IF v_holder IS NOT NULL THEN
          IF p_rows IS NULL THEN
            UPDATE fin_postings SET holder_person_id = v_holder
             WHERE id = fin_private_child_uuid(v_d.id, 'chat-expense-row') AND account_id = v_acc;
          ELSE
            UPDATE fin_postings SET holder_person_id = v_holder
             WHERE account_id = v_acc
               AND id IN (SELECT fin_private_child_uuid(v_d.id, 'chat-expense-row-' || ord::text)
                            FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
                           WHERE NULLIF(r->>'department_id','') IS NULL);
          END IF;
        END IF;

        FOR v_ptag IN
          SELECT ord, (r->>'payroll_position_id')::uuid AS pos_id
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
          WHERE NULLIF(r->>'department_id','') IS NULL
            AND NULLIF(r->>'payroll_position_id','') IS NOT NULL
        LOOP
          INSERT INTO fin_payroll_payments (posting_id, position_id)
          VALUES (fin_private_child_uuid(v_d.id, 'chat-expense-row-' || v_ptag.ord::text), v_ptag.pos_id)
          ON CONFLICT DO NOTHING;
        END LOOP;
      END IF;

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

        v_res := fin_create_transfer(jsonb_build_object(
          'request_id', fin_private_child_uuid(v_d.id, 'chat-transfer-' || v_seq::text),
          'occurred_on', v_d.created_at::date,
          'source_account_id', v_acc, 'target_account_id', v_tgt_acc,
          'source_amount', v_grp.total, 'target_amount', v_grp.total,
          'comment', format('%s — за департамент «%s»%s',
                            btrim(v_d.purpose), v_grp.dept_name, v_chat_note)));
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

        IF v_holder IS NOT NULL THEN
          UPDATE fin_postings SET holder_person_id = v_holder
           WHERE id = fin_private_child_uuid(v_d.id, 'chat-transfer-' || v_seq::text) AND account_id = v_acc;
        END IF;

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
            'comment', format('%s — оплатил «%s»%s',
                              btrim(v_d.purpose), v_payer_dept, v_chat_note),
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

          FOR v_ptag IN
            SELECT ord, (r->>'payroll_position_id')::uuid AS pos_id
            FROM jsonb_array_elements(v_grp.grp_rows) WITH ORDINALITY AS t(r, ord)
            WHERE NULLIF(r->>'payroll_position_id','') IS NOT NULL
          LOOP
            INSERT INTO fin_payroll_payments (posting_id, position_id)
            VALUES (fin_private_child_uuid(v_d.id, format('chat-dept-row-%s-%s', v_seq, v_ptag.ord)), v_ptag.pos_id)
            ON CONFLICT DO NOTHING;
          END LOOP;

          PERFORM tg_notify_dept_expense(v_grp_op, v_tgt_acc,
                                         v_author, btrim(v_d.purpose), v_payer_dept);
        ELSE
          PERFORM tg_notify_dept_incoming(v_grp.dept, v_grp.total, v_d.currency,
                                          btrim(v_d.purpose), COALESCE(v_author, v_payer_dept), v_d.id);
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
        IF COALESCE(p_source_account, v_d.source_account_id) IS NOT NULL THEN
        v_acc := COALESCE(p_source_account, v_d.source_account_id);
        IF (SELECT currency_code FROM fin_accounts WHERE id = v_acc) IS DISTINCT FROM v_d.currency THEN
          RAISE EXCEPTION 'chat_post_failed' USING DETAIL = 'Валюта счёта не совпадает с валютой заявки';
        END IF;
      ELSE
        v_acc := fin_dept_account(v_d.department_id, v_d.currency);
      END IF;
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

      IF v_holder IS NOT NULL THEN
        UPDATE fin_postings SET holder_person_id = v_holder
         WHERE id = v_d.id AND account_id = v_acc;
      END IF;

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
          'comment', format('%s — выдано «%s» и сразу потрачено%s',
                            COALESCE(NULLIF(btrim(v_d.purpose), ''), 'Расход департамента'),
                            v_payer_dept, v_chat_note),
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

        FOR v_ptag IN
          SELECT ord, (r->>'payroll_position_id')::uuid AS pos_id
          FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS t(r, ord)
          WHERE NULLIF(r->>'payroll_position_id','') IS NOT NULL
        LOOP
          INSERT INTO fin_payroll_payments (posting_id, position_id)
          VALUES (fin_private_child_uuid(v_d.id, 'chat-issue-row-' || v_ptag.ord::text), v_ptag.pos_id)
          ON CONFLICT DO NOTHING;
        END LOOP;

        PERFORM tg_notify_dept_expense(v_grp_op, v_tgt, v_author,
                                       COALESCE(NULLIF(btrim(v_d.purpose), ''), v_d.raw_text),
                                       v_payer_dept);
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', COALESCE(NULLIF(v_detail, ''), SQLERRM));
  END;

  UPDATE tg_drafts SET status='posted', operation_id=v_main, resolved_by=v_actor, resolved_at=now()
   WHERE id = v_d.id;
  PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👍');

  IF v_suppress THEN
    IF v_has_dept THEN
      PERFORM tg_send_chat(v_d.chat_id,
        format('✅ <b>Проведено: %s</b>', fin_fmt_money(v_d.amount, v_d.currency))
        || E'\nОтнесено на департаменты:' || v_summary
        || format(E'\nНа руках у «%s»: %s', tg_escape(v_payer_dept),
                  fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
        v_d.source_message_id);
    ELSIF v_d.kind = 'transfer' THEN
      PERFORM tg_send_chat(v_d.chat_id,
        format('✅ <b>Выдано «%s»: %s</b>', tg_escape(v_tgt_dept),
               fin_fmt_money(v_d.amount, v_d.currency))
        || E'\nСразу учтено как расход получателя'
        || format(E'\nНа руках у «%s»: %s', tg_escape(v_payer_dept),
                  fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
        v_d.source_message_id);
    ELSE
      PERFORM tg_send_chat(v_d.chat_id,
        format('💸 <b>Проведён расход: %s</b>', fin_fmt_money(v_d.amount, v_d.currency))
        || COALESCE(E'\n' || v_own_summary, '')
        || format(E'\nНа руках у департамента: %s',
                  fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
        v_d.source_message_id);
    END IF;

    IF COALESCE(v_bal_before, 0) >= 0 AND fin_private_account_balance(v_acc) < 0 THEN
      PERFORM tg_notify_negative(v_acc);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'operation_id', v_main);
END;
$function$;

-- /баланс: разбивка по держателям вторым слоем, после общего итога.
-- Только если у департамента вообще зарегистрированы держатели — иначе
-- ничего не меняется для департаментов без этой фичи.
CREATE OR REPLACE FUNCTION public.tg_department_balance(p_chat bigint)
 RETURNS TABLE(department_name text, balance numeric, currency_code text, pending_drafts integer, formatted text, holders_line text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_dept uuid;
BEGIN
  SELECT l.department_id INTO v_dept FROM tg_chat_links l
   WHERE l.chat_id = p_chat AND l.is_active;
  IF v_dept IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT d.name::text,
         COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)::numeric,
         a.currency_code::text,
         (SELECT count(*)::int FROM tg_drafts dr
           WHERE dr.department_id = v_dept AND dr.status = 'pending'),
         fin_fmt_money(COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0),
                       a.currency_code)::text,
         (SELECT string_agg(
                   format('  — %s: %s', tg_escape(h.label), fin_fmt_money(h.amt, a.currency_code)),
                   E'\n' ORDER BY h.amt DESC)
            FROM (
              SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                              NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                              'не привязано') AS label,
                     SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) AS amt
                FROM fin_postings p2
                LEFT JOIN vaishnavas v ON v.id = p2.holder_person_id
               WHERE p2.account_id = a.id
                 AND (p2.holder_person_id IS NOT NULL
                      OR EXISTS (SELECT 1 FROM fin_department_holders fh WHERE fh.department_id = v_dept AND fh.is_active))
               GROUP BY v.spiritual_name, v.first_name, v.last_name, p2.holder_person_id
              HAVING SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) <> 0
            ) h)
  FROM fin_accounts a
  JOIN fin_departments d ON d.id = a.department_id
  LEFT JOIN fin_postings p ON p.account_id = a.id
  WHERE a.department_id = v_dept AND a.kind = 'custodial' AND a.is_active
  GROUP BY d.name, a.currency_code, a.id;
END;
$function$;
