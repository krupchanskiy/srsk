-- Уведомление получателю в ДРУГОЙ чат — со ссылкой на исходное сообщение
-- (правило ВГ, 21.09.2026: любое сообщение бота должно быть привязано к
-- сообщению, по которому оно отправлено). Заявку пишут в чате одного
-- департамента («Завод»), а уведомление о расходе уходит получателю («Кафе»),
-- где исходного сообщения нет, — Telegram-ответ там невозможен. Поэтому первой
-- строкой ставим ссылку на исходное сообщение в его чате.
-- Если заявка пришла из того же чата — обычный ответ (reply_to), как в 459.

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
  -- ссылки вида t.me/c/… бывают только у супергрупп (id вида -100…)
  IF v_d.chat_id::text NOT LIKE '-100%' THEN RETURN NULL; END IF;

  SELECT l.department_name, l.topic_finance INTO v_name, v_topic
    FROM tg_chat_links l WHERE l.chat_id = v_d.chat_id AND l.is_active;

  v_url := 'https://t.me/c/' || substr(v_d.chat_id::text, 5) || '/'
           || COALESCE(v_topic::text || '/', '') || v_d.source_message_id;

  v_snip := regexp_replace(btrim(COALESCE(v_d.raw_text, '')), E'\\s+', ' ', 'g');
  IF length(v_snip) > 70 THEN v_snip := left(v_snip, 70) || '…'; END IF;

  RETURN format('↩ <a href="%s">Заявка из чата «%s»</a>: «%s»',
                v_url, tg_escape(COALESCE(v_name, '?')), tg_escape(v_snip));
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_source_link_line(uuid) FROM PUBLIC, anon, authenticated;

-- «Расход по «X»»: ответ на исходное (тот же чат) либо ссылка на него (другой чат)
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
    || COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(v_what), '')), '')
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

  IF v_purpose IS NOT NULL THEN
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
