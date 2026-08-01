-- Уведомление в чат департамента о его расходе.
--
-- Требование ВГ (31.07.2026): при отнесении траты на департамент в его чат
-- должно приходить сообщение — «кто, когда, на что и сколько потратил».
-- О приходе департаменту бот уже сообщает (tg_notify_dept_credit), а о расходе
-- молчал: департамент видел только, что деньги пришли, но не что их списали.
--
-- Функция вызывается из проведения заявки (этап 2) и годится для любой
-- операции: ей достаточно проводки.

create or replace function tg_notify_dept_expense(p_posting_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_chat   bigint;
  v_dept   text;
  v_who    text;
  v_what   text;
  v_when   date;
  v_amount numeric;
  v_cur    text;
  v_cat    text;
BEGIN
  SELECT l.chat_id, d.name, o.occurred_on, p.amount, p.currency_code,
         c.name,
         coalesce(o.comment, ''),
         coalesce(nullif(v.spiritual_name, ''),
                  nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''))
    INTO v_chat, v_dept, v_when, v_amount, v_cur, v_cat, v_what, v_who
  FROM fin_postings p
  JOIN fin_operations o  ON o.id = p.operation_id
  JOIN fin_accounts   a  ON a.id = p.account_id
  JOIN fin_departments d ON d.id = a.department_id
  LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
  LEFT JOIN fin_categories c ON c.id = p.category_id
  LEFT JOIN vaishnavas v ON v.id = o.created_by
  WHERE p.id = p_posting_id AND p.direction = 'out';

  IF v_chat IS NULL THEN RETURN; END IF;   -- чат не привязан — сообщать некуда

  PERFORM tg_send_chat(v_chat,
    format('💸 <b>Расход по «%s»: %s %s</b>', tg_escape(v_dept),
           -- FM999999990.99 у целой суммы оставляет висячую точку («50000. INR»)
           rtrim(trim(to_char(v_amount, 'FM999999990.99')), '.'), tg_escape(coalesce(v_cur, '')))
    || coalesce(E'\n' || tg_escape(v_cat), '')
    || coalesce(E'\nНа что: ' || tg_escape(nullif(v_what, '')), '')
    || format(E'\nДата: %s', to_char(v_when, 'DD.MM.YYYY'))
    || coalesce(E'\nПровёл: ' || tg_escape(v_who), ''));
END;
$function$;
