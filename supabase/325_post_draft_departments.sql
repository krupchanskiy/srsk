-- Проведение заявки из чата: строка разбивки несёт департамент-получателя.
--
-- Замечание ВГ (01.08.2026): «расход идёт в департамент получателя!… с баланса
-- Ашиша списывается расход, так как он конкретно потратил эти деньги… и если
-- есть галочка — учитывать как расход Гест-хауса, сразу заносится как расход
-- Гест-хауса (тоже с уведомлением в чате об операции, кто, когда, на что и
-- сколько потратил)». И: «может быть одна отметка у Ашиша например такси из
-- аэропорта 6000, едут 2 или 3 человека из разных департаментов».
--
-- Такси 6000 у Ашиша: 1750 Гест-хаусу, 4250 Зелёным — четыре операции:
--   передача Ашиш → Гест-хаус 1750, расход Гест-хауса 1750,
--   передача Ашиш → Зелёные 4250, расход Зелёных 4250.
-- У Ашиша минус 6000 (он реально потратил), у получателей ноль на руках,
-- а расход числится за ними и за нужным ретритом.
--
-- Соблазн сделать один расход со строками на чужих счетах отвергнут: отчёт был
-- бы верным, а касса лживой — деньги ушли у Ашиша, а списались бы у чужих.

-- ---------------------------------------------------------------------------
-- 1. Уведомление о расходе департамента: теперь по операции и счёту, а не по
--    одной проводке — у получателя может оказаться несколько статей сразу.
-- ---------------------------------------------------------------------------
drop function if exists tg_notify_dept_expense(uuid);

create or replace function tg_notify_dept_expense(
  p_operation_id uuid, p_account_id uuid, p_who text default null, p_what text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  PERFORM tg_send_chat(v_chat,
    format('💸 <b>Расход по «%s»: %s</b>', tg_escape(v_dept), fin_fmt_money(v_total, v_cur))
    -- одна статья читается строкой, несколько — списком
    || CASE WHEN v_rows = 1 THEN COALESCE(E'\n' || tg_escape(v_one), '')
            ELSE E'\n' || v_lines END
    || COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(v_what), '')), '')
    || format(E'\nДата: %s', to_char(v_when, 'DD.MM.YYYY'))
    || COALESCE(E'\nПотратил: ' || tg_escape(v_who), '')
    || format(E'\nНа руках: %s',
              fin_fmt_money(fin_private_account_balance(p_account_id), v_cur)));
END;
$function$;

-- Департаменту отнесли трату, но статью он проставит сам: денег на руках у него
-- физически нет, поэтому говорим об этом прямо.
create or replace function tg_notify_dept_incoming(
  p_department uuid, p_amount numeric, p_currency text, p_what text, p_who text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_chat bigint; v_name text; v_acc uuid;
BEGIN
  SELECT d.name, l.chat_id INTO v_name, v_chat
    FROM fin_departments d
    LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
   WHERE d.id = p_department;
  IF v_chat IS NULL THEN RETURN; END IF;

  v_acc := fin_dept_account(p_department, p_currency);
  PERFORM tg_send_chat(v_chat,
    format('📥 <b>На «%s» отнесена трата: %s</b>', tg_escape(v_name),
           fin_fmt_money(p_amount, p_currency))
    || COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(p_what), '')), '')
    || COALESCE(E'\nПотратил: ' || tg_escape(p_who), '')
    || E'\n⚠️ Сумма пока числится на вашем остатке — отметьте, на что она ушла.'
    || format(E'\nНа руках: %s',
              fin_fmt_money(fin_private_account_balance(v_acc), p_currency)));
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Триггер уведомлений умеет замолкать.
--    Заявка с разбивкой по департаментам даёт до шести проводок по подотчётным
--    счетам — шесть сообщений в три чата, и ни одно не говорит, за что. На
--    время такого проведения триггер глушится, а tg_post_draft шлёт по одному
--    осмысленному сообщению в каждый затронутый чат. Флаг ставится локально
--    внутри функции и снимается сам при выходе из неё.
-- ---------------------------------------------------------------------------
create or replace function tg_notify_dept_credit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
BEGIN
  -- заявка из чата с разбивкой по департаментам сообщает о себе сама
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id)
    INTO v_optype, v_orig_type
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;

  v_head := CASE
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'  THEN '📥 <b>Выдано под отчёт: %s%s</b>'
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' THEN '🔁 <b>Передано другому департаменту: %s%s</b>'
    WHEN v_optype = 'expense'                            THEN '💸 <b>Проведён расход: %s%s</b>'
    WHEN v_optype = 'refund'                             THEN '↩️ <b>Возврат: %s%s</b>'
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer' THEN '❌ <b>Выдача отменена: %s%s</b>'
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'  THEN '❌ <b>Расход отменён: %s%s</b>'
    WHEN v_optype = 'reversal'                           THEN '❌ <b>Операция отменена: %s%s</b>'
    WHEN NEW.direction = 'in'                            THEN '📥 <b>Приход: %s%s</b>'
    ELSE '📤 <b>Списание: %s%s</b>'
  END;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  PERFORM tg_send_chat(v_chat, format(
    v_head || E'\nНа руках у департамента: %s',
    v_sign, fin_fmt_money(NEW.amount, v_acc.currency_code),
    fin_fmt_money(v_bal, v_acc.currency_code)));
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Проведение заявки.
-- ---------------------------------------------------------------------------
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

  -- Пока пишем — триггер молчит, сообщения соберём сами.
  IF v_has_dept THEN PERFORM set_config('tg.suppress_chat_notify', '1', true); END IF;

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

  -- Сводка автору — вместо шести сообщений от триггера
  IF v_has_dept THEN
    PERFORM tg_send_chat(v_d.chat_id,
      format('✅ <b>Проведено: %s</b>', fin_fmt_money(v_d.amount, v_d.currency))
      || COALESCE(E'\n' || tg_escape(NULLIF(btrim(v_d.purpose), '')), '')
      || E'\nОтнесено на департаменты:' || v_summary
      || format(E'\nНа руках у «%s»: %s', tg_escape(v_payer_dept),
                fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency)),
      v_d.card_message_id);

    -- триггер на проводках молчал: считаем переход через ноль за всю заявку
    IF COALESCE(v_bal_before, 0) >= 0 AND fin_private_account_balance(v_acc) < 0 THEN
      PERFORM tg_notify_negative(v_acc);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'operation_id', v_main);
END;
$function$;
