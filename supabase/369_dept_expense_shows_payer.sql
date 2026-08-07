-- В чат департамента-получателя приходило «Потратил: <ответственный получателя>».
-- Так Кафе увидело «Потратил: Джамбала Малика дд», хотя стулья купил Завод:
-- ответственная Кафе денег в руки не брала. Для департаментов это прямая путаница.
-- Теперь, когда платит один департамент, а расход относится на другой, в уведомлении
-- стоит плательщик: «Оплатил: «Завод» (Виктория)». Когда департамент тратит своё —
-- по-прежнему «Потратил: <человек>».
--
-- ВНИМАНИЕ: тело функции далее перекрыто миграцией 372 (там исправлена обработка
-- пустого автора). Файл оставлен для истории.

create or replace function public.tg_notify_dept_expense(
  p_operation_id uuid,
  p_account_id uuid,
  p_who text default null,
  p_what text default null,
  p_payer_dept text default null)
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
  v_кто   text;
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

  -- Платил другой департамент — называем его, иначе получатель решит, что тратил свой человек
  IF p_payer_dept IS NOT NULL AND p_payer_dept IS DISTINCT FROM v_dept THEN
    v_кто := format('Оплатил: «%s»', tg_escape(p_payer_dept))
             || COALESCE(format(' (%s)', tg_escape(NULLIF(btrim(v_who), ''))), '');
  ELSE
    v_кто := COALESCE('Потратил: ' || tg_escape(NULLIF(btrim(v_who), '')), '');
  END IF;

  PERFORM tg_send_chat(v_chat,
    format('💸 <b>Расход по «%s»: %s</b>', tg_escape(v_dept), fin_fmt_money(v_total, v_cur))
    -- одна статья читается строкой, несколько — списком
    || CASE WHEN v_rows = 1 THEN COALESCE(E'\n' || tg_escape(v_one), '')
            ELSE E'\n' || v_lines END
    || COALESCE(E'\nНа что: ' || tg_escape(NULLIF(btrim(v_what), '')), '')
    || format(E'\nДата: %s', to_char(v_when, 'DD.MM.YYYY'))
    || COALESCE(E'\n' || NULLIF(v_кто, ''), '')
    || format(E'\nНа руках: %s',
              fin_fmt_money(fin_private_account_balance(p_account_id), v_cur)));
END;
$function$;

revoke all on function public.tg_notify_dept_expense(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.tg_notify_dept_expense(uuid, uuid, text, text, text) to authenticated, service_role;
