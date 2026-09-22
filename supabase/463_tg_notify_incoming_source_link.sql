-- «На департамент отнесена трата»: ссылка на исходное сообщение вместо повтора «На что»
-- (правило ВГ, 21.09.2026: где можно сослаться на сообщение — не дублировать текст).
-- Если заявки нет (p_draft IS NULL) — «На что» остаётся, как раньше.

DROP FUNCTION IF EXISTS public.tg_notify_dept_incoming(uuid, numeric, text, text, text);

CREATE OR REPLACE FUNCTION public.tg_notify_dept_incoming(p_department uuid, p_amount numeric, p_currency text, p_what text, p_who text, p_draft uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_chat bigint; v_name text; v_acc uuid; v_link text;
BEGIN
  SELECT d.name, l.chat_id INTO v_name, v_chat
    FROM fin_departments d
    LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
   WHERE d.id = p_department;
  IF v_chat IS NULL THEN RETURN; END IF;

  IF p_draft IS NOT NULL THEN v_link := tg_source_link_line(p_draft); END IF;

  v_acc := fin_dept_account(p_department, p_currency);
  PERFORM tg_send_chat(v_chat,
    COALESCE(v_link || E'\n', '')
    || format('📥 <b>На «%s» отнесена трата: %s</b>', tg_escape(v_name),
              fin_fmt_money(p_amount, p_currency))
    || CASE WHEN v_link IS NULL
            THEN COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(p_what), '')), '') ELSE '' END
    || COALESCE(E'\nПотратил: ' || tg_escape(p_who), '')
    || E'\n⚠️ Сумма пока числится на вашем остатке — отметьте, на что она ушла.'
    || format(E'\nНа руках: %s',
              fin_fmt_money(fin_private_account_balance(v_acc), p_currency)));
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_notify_dept_incoming(uuid, numeric, text, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- tg_post_draft передаёт id заявки в вызов (единственное изменение — последний аргумент)
DO $mig$
DECLARE
  v_def text := pg_get_functiondef('public.tg_post_draft(uuid, jsonb, uuid)'::regprocedure);
  v_old text := 'COALESCE(v_author, v_payer_dept));';
  v_new text;
BEGIN
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'ожидалось ровно одно вхождение вызова tg_notify_dept_incoming';
  END IF;
  v_new := replace(v_def, v_old, 'COALESCE(v_author, v_payer_dept), v_d.id);');
  EXECUTE v_new;
END
$mig$;
