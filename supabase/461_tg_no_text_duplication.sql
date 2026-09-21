-- Не дублируем текст сообщения там, где на него можно сослаться (ВГ, 21.09.2026):
--  • ответ на сообщение в том же чате — без строки «На что: …» (текст уже виден в ответе);
--  • уведомление в другой чат — ссылка на исходное сообщение с цитатой, без «На что»;
--  • комментарий проведённой операции — текст один раз, без «(из чата: …)»,
--    если описание и есть дословный текст сообщения;
--  • «Заявка не проведена» — без повтора текста, только сумма, причина и кто отклонил.
-- Строка «На что» остаётся там, где сообщения-источника нет (операции с сайта).

CREATE OR REPLACE FUNCTION public.tg_source_link_line(p_draft uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d tg_drafts%ROWTYPE;
  v_name text;
  v_topic int;
  v_url text;
  v_snip text;
BEGIN
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_draft;
  IF NOT FOUND OR v_d.source_message_id IS NULL THEN RETURN NULL; END IF;
  IF v_d.chat_id::text NOT LIKE '-100%' THEN RETURN NULL; END IF;

  SELECT l.department_name, l.topic_finance INTO v_name, v_topic
    FROM tg_chat_links l WHERE l.chat_id = v_d.chat_id AND l.is_active;

  v_url := 'https://t.me/c/' || substr(v_d.chat_id::text, 5) || '/'
           || COALESCE(v_topic::text || '/', '') || v_d.source_message_id;

  v_snip := regexp_replace(btrim(COALESCE(v_d.raw_text, '')), E'\\s+', ' ', 'g');
  IF length(v_snip) > 200 THEN v_snip := left(v_snip, 200) || '…'; END IF;

  RETURN format('↩ <a href="%s">Заявка из чата «%s»</a>: «%s»',
                v_url, tg_escape(COALESCE(v_name, '?')), tg_escape(v_snip));
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_source_link_line(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tg_notify_dept_expense(p_operation_id uuid, p_account_id uuid, p_who text DEFAULT NULL::text, p_what text DEFAULT NULL::text, p_payer_dept text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chat  bigint;
  v_dept  text;
  v_cur   text;
  v_when  date;
  v_total numeric;
  v_lines text;
  v_one   text;
  v_rows  int;
  v_what  text;
  v_who   text;
  v_подпись text;
  v_dr uuid; v_src_chat bigint; v_src_msg bigint;
  v_reply bigint; v_link text;
BEGIN
  SELECT l.chat_id, d.name, a.currency_code, o.occurred_on,
         COALESCE(p_what, o.comment),
         COALESCE(p_who, NULLIF(v.spiritual_name, ''),
                  NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''))
    INTO v_chat, v_dept, v_cur, v_when, v_what, v_who
    FROM fin_operations o
    JOIN fin_accounts a ON a.id = p_account_id
    JOIN fin_departments d ON d.id = a.department_id
    LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
    LEFT JOIN vaishnavas v ON v.id = o.created_by
   WHERE o.id = p_operation_id;

  IF v_chat IS NULL THEN RETURN; END IF;   -- чат не привязан — сообщать некуда

  SELECT COALESCE(sum(p.amount), 0), count(*), min(c.name),
         string_agg(format('• %s — %s', tg_escape(COALESCE(c.name, '—')),
                           fin_fmt_money(p.amount, p.currency_code)), E'\n' ORDER BY p.amount DESC)
    INTO v_total, v_rows, v_one, v_lines
    FROM fin_postings p
    LEFT JOIN fin_categories c ON c.id = p.category_id
   WHERE p.operation_id = p_operation_id AND p.account_id = p_account_id AND p.direction = 'out';

  IF v_rows = 0 THEN RETURN; END IF;

  v_who := NULLIF(btrim(COALESCE(v_who, '')), '');

  -- Платил другой департамент — называем его: иначе получатель решит,
  -- что деньги тратил его собственный ответственный.
  IF p_payer_dept IS NOT NULL AND p_payer_dept IS DISTINCT FROM v_dept THEN
    v_подпись := format('Оплатил: «%s»', tg_escape(p_payer_dept))
                 || CASE WHEN v_who IS NULL THEN '' ELSE format(' (%s)', tg_escape(v_who)) END;
  ELSIF v_who IS NOT NULL THEN
    v_подпись := 'Потратил: ' || tg_escape(v_who);
  ELSE
    v_подпись := '';
  END IF;

  -- К какому сообщению относится уведомление
  SELECT dr.id, dr.chat_id, dr.source_message_id INTO v_dr, v_src_chat, v_src_msg
    FROM tg_drafts dr
   WHERE dr.id IN (SELECT dop.draft_id FROM tg_draft_operations dop WHERE dop.operation_id = p_operation_id)
      OR dr.operation_id = p_operation_id
      OR dr.id = p_operation_id
   LIMIT 1;
  IF v_dr IS NOT NULL THEN
    IF v_src_chat = v_chat THEN v_reply := v_src_msg;
    ELSE v_link := tg_source_link_line(v_dr);
    END IF;
  END IF;

  PERFORM tg_send_chat(v_chat,
    COALESCE(v_link || E'\n', '')
    || format('💸 <b>Расход по «%s»: %s</b>', tg_escape(v_dept), fin_fmt_money(v_total, v_cur))
    -- одна статья читается строкой, несколько — списком
    || CASE WHEN v_rows = 1 THEN COALESCE(E'\n' || tg_escape(v_one), '')
            ELSE E'\n' || v_lines END
    || CASE WHEN v_dr IS NULL THEN COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(v_what), '')), '') ELSE '' END
    || format(E'\nДата: %s', to_char(v_when, 'DD.MM.YYYY'))
    || CASE WHEN v_подпись = '' THEN '' ELSE E'\n' || v_подпись END
    || format(E'\nНа руках: %s',
              fin_fmt_money(fin_private_account_balance(p_account_id), v_cur)),
    v_reply);
END;
$function$;

-- «Получено от «X»» и прочие уведомления по проводкам: ссылка, если заявка из другого чата
CREATE OR REPLACE FUNCTION public.tg_notify_dept_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_orig_op uuid;
  v_reason text;
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
  v_amount text;
  v_text text;
  v_other_acc text;
  v_other_dept text;
  v_purpose text;
  v_reply_to bigint;
  v_src_chat bigint;
  v_dr uuid;
  v_link text;
BEGIN
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id),
         o.original_operation_id,
         NULLIF(btrim(o.reason), '')
    INTO v_optype, v_orig_type, v_orig_op, v_reason
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  SELECT a2.name, d2.name
    INTO v_other_acc, v_other_dept
    FROM fin_postings p2
    JOIN fin_accounts a2 ON a2.id = p2.account_id
    LEFT JOIN fin_departments d2 ON d2.id = a2.department_id
   WHERE p2.operation_id = NEW.operation_id
     AND p2.direction <> NEW.direction
   LIMIT 1;

  -- Заявку ищем и по связям, и по совпадению id: у основной операции заявки
  -- id равен id заявки, а связь operation_id записывается уже после проводок.
  SELECT NULLIF(btrim(dr.purpose), ''),
         dr.source_message_id,
         dr.chat_id,
         dr.id
    INTO v_purpose, v_reply_to, v_src_chat, v_dr
    FROM tg_drafts dr
   WHERE dr.id IN (SELECT dop.draft_id FROM tg_draft_operations dop
                    WHERE dop.operation_id = COALESCE(v_orig_op, NEW.operation_id))
      OR dr.operation_id = COALESCE(v_orig_op, NEW.operation_id)
      OR dr.id = COALESCE(v_orig_op, NEW.operation_id)
   LIMIT 1;

  -- ответить можно только на сообщение из этого же чата, иначе — ссылка на него
  IF v_src_chat IS DISTINCT FROM v_chat THEN
    v_reply_to := NULL;
    IF v_dr IS NOT NULL THEN v_link := tg_source_link_line(v_dr); END IF;
  END IF;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;
  v_amount := v_sign || fin_fmt_money(NEW.amount, v_acc.currency_code);

  v_head := CASE
    WHEN v_optype = 'transfer' AND NEW.direction = 'in' AND v_other_dept IS NOT NULL
      THEN format('📥 <b>Получено от «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'
      THEN format('📥 <b>Выдано под отчёт: %s</b>', v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' AND v_other_dept IS NOT NULL
      THEN format('🔁 <b>Передано «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out'
      THEN format('📤 <b>Возвращено в кассу: %s</b>', v_amount)
    WHEN v_optype = 'expense'  THEN format('💸 <b>Проведён расход: %s</b>', v_amount)
    WHEN v_optype = 'refund'   THEN format('↩️ <b>Возврат: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer'
      THEN format('❌ <b>Выдача отменена: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'
      THEN format('❌ <b>Расход отменён: %s</b>', v_amount)
    WHEN v_optype = 'reversal' THEN format('❌ <b>Операция отменена: %s</b>', v_amount)
    WHEN NEW.direction = 'in'  THEN format('📥 <b>Приход: %s</b>', v_amount)
    ELSE format('📤 <b>Списание: %s</b>', v_amount)
  END;

  v_text := v_head;

  IF v_optype = 'transfer' AND v_other_acc IS NOT NULL THEN
    v_text := v_text || format(E'\n%s: %s',
      CASE WHEN NEW.direction = 'in' THEN 'Со счёта' ELSE 'На счёт' END,
      tg_escape(v_other_acc));
  END IF;

  IF v_purpose IS NOT NULL AND v_reply_to IS NULL AND v_link IS NULL THEN
    v_text := v_text || format(E'\nНа что: %s', tg_escape(v_purpose));
  END IF;

  IF v_optype = 'reversal' THEN
    v_text := v_text || format(E'\nПричина: %s', tg_escape(COALESCE(v_reason, 'не указана')));
  END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  v_text := v_text || format(E'\nНа руках у департамента: %s',
                             fin_fmt_money(v_bal, v_acc.currency_code));

  PERFORM tg_send_chat(v_chat, COALESCE(v_link || E'\n', '') || v_text, v_reply_to);
  RETURN NEW;
END;
$function$;

-- «Заявка не проведена»: ответ на сообщение уже цитирует текст — не повторяем
CREATE OR REPLACE FUNCTION public.tg_dismiss_draft(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d       tg_drafts%ROWTYPE;
  v_reason  text := nullif(trim(coalesce(p_reason, '')), '');
  v_who     text;
  v_text    text;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  UPDATE tg_drafts SET status = 'dismissed', resolved_by = auth.uid(), resolved_at = now()
  WHERE id = p_id AND status = 'pending'
  RETURNING * INTO v_d;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT coalesce(v.spiritual_name, nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''))
    INTO v_who
  FROM vaishnavas v WHERE v.user_id = auth.uid();

  IF v_d.chat_id IS NOT NULL THEN
    v_text := '✖️ <b>Заявка не проведена</b>'
           || coalesce(' · ' || v_d.amount::text || ' ' || tg_escape(v_d.currency), '')
           || coalesce(E'\nПричина: ' || tg_escape(v_reason), '')
           || coalesce(E'\nОтклонил: ' || tg_escape(v_who), '');
    PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id);
    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

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
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  -- описание = дословный текст сообщения (20.09.2026): дублировать его в комментарии не нужно
  v_chat_note := CASE WHEN btrim(COALESCE(v_d.purpose, '')) = btrim(COALESCE(v_d.raw_text, ''))
                      THEN '' ELSE format(' (из чата: %s)', v_d.raw_text) END;
  IF v_d.kind IS NULL OR v_d.currency IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указан вид или валюта');
  END IF;
  IF v_d.kind = 'expense' AND COALESCE(length(btrim(v_d.purpose)), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Заявка неполная: не указано, на что потрачено');
  END IF;

  -- ---------- проверка разбивки ----------
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
