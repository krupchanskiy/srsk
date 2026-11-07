-- Оплата труда не уходит в чат другого департамента (ВГ, 07.11.2026).
--
-- 682 убрал зарплаты из чатов, но оставил ответ бота на сообщение
-- в том же чате, где человек сам написал о выдаче. Дыра: заявка из чата
-- «Гест-хаус» «Выдала Евгении Лебедевой 30000 рупий зп» отнесена на
-- «Зелёные» — tg_notify_dept_expense написал в чат «Зелёных» сумму
-- и «Оплата труда», хотя там об этом никто не писал.
--
-- Теперь: если все строки расхода — «Оплата труда» и сообщение не ответ
-- в исходном чате, бот молчит. Учёт не меняется.

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
  v_labor_rows int;
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

  IF v_chat IS NULL THEN RETURN; END IF;

  SELECT COALESCE(sum(p.amount), 0), count(*), min(c.name),
         string_agg(format('• %s — %s', tg_escape(COALESCE(c.name, '—')),
                           fin_fmt_money(p.amount, p.currency_code)), E'\n' ORDER BY p.amount DESC),
         count(*) FILTER (WHERE c.code = 'dept_labor')
    INTO v_total, v_rows, v_one, v_lines, v_labor_rows
    FROM fin_postings p
    LEFT JOIN fin_categories c ON c.id = p.category_id
   WHERE p.operation_id = p_operation_id AND p.account_id = p_account_id AND p.direction = 'out';

  IF v_rows = 0 THEN RETURN; END IF;

  v_who := NULLIF(btrim(COALESCE(v_who, '')), '');

  IF p_payer_dept IS NOT NULL AND p_payer_dept IS DISTINCT FROM v_dept THEN
    v_подпись := format('Оплатил: «%s»', tg_escape(p_payer_dept))
                 || CASE WHEN v_who IS NULL THEN '' ELSE format(' (%s)', tg_escape(v_who)) END;
  ELSIF v_who IS NOT NULL THEN
    v_подпись := 'Потратил: ' || tg_escape(v_who);
  ELSE
    v_подпись := '';
  END IF;

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

  -- Оплата труда — только ответом в чате, где о выдаче написали сами (774).
  IF v_reply IS NULL AND v_labor_rows = v_rows THEN RETURN; END IF;

  PERFORM tg_send_chat(v_chat,
    COALESCE(v_link || E'\n', '')
    || format('💸 <b>Расход по «%s»: %s</b>', tg_escape(v_dept), fin_fmt_money(v_total, v_cur))
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
