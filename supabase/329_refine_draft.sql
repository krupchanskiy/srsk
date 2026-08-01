-- Уточнение заявки на выдачу перед проведением.
--
-- Замечание ВГ (01.08.2026, снимок экрана): при выдаче под отчёт некуда
-- поставить департамент — если бот угадал получателя неверно, заявку
-- оставалось только отклонить и просить переписать сообщение.
--
-- Меняем только адресацию: кому выдаём и с какого счёта. Сумма, автор и
-- исходный текст неприкосновенны — иначе в учёт попадёт не то, что человек
-- написал в чате.

create or replace function tg_refine_draft(
  p_id uuid, p_target_department uuid, p_source_account uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_actor uuid; v_d tg_drafts%ROWTYPE; v_cur text;
BEGIN
  v_actor := auth.uid();
  IF NOT fin_is_admin(v_actor) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;

  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_d.kind <> 'transfer' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Уточнять получателя можно только у выдачи');
  END IF;

  IF p_target_department IS NULL
     OR NOT EXISTS (SELECT 1 FROM fin_departments WHERE id = p_target_department) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Не выбран департамент-получатель');
  END IF;
  IF p_target_department = v_d.department_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Получатель совпадает с автором заявки');
  END IF;

  IF p_source_account IS NOT NULL THEN
    SELECT currency_code INTO v_cur FROM fin_accounts
     WHERE id = p_source_account AND is_active;
    IF v_cur IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Счёт-источник не найден или деактивирован');
    END IF;
    IF v_cur IS DISTINCT FROM v_d.currency THEN
      RETURN jsonb_build_object('ok', false, 'error', 'Валюта счёта не совпадает с валютой заявки');
    END IF;
  END IF;

  UPDATE tg_drafts
     SET target_department_id = p_target_department,
         source_account_id    = p_source_account
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

grant execute on function tg_refine_draft(uuid, uuid, uuid) to authenticated;

-- Витрине заявок нужны идентификаторы, чтобы модалка открылась с текущими
-- значениями, а не с пустыми полями.
create or replace view fin_v_chat_drafts as
 SELECT t.id,
    t.chat_id,
    t.source_message_id,
    t.kind,
    t.amount,
    t.currency,
    t.raw_text,
    t.purpose,
    c.name AS category,
    a.name AS source_account,
    t.created_at,
    d.name AS department,
    td.name AS target_department,
    COALESCE(NULLIF(v.spiritual_name, ''::text),
             TRIM(BOTH FROM (COALESCE(v.first_name, ''::text) || ' '::text) || COALESCE(v.last_name, ''::text))) AS author,
    t.category_id,
    t.department_id,
    t.target_department_id,
    t.source_account_id
   FROM tg_drafts t
     JOIN fin_departments d ON d.id = t.department_id
     LEFT JOIN fin_departments td ON td.id = t.target_department_id
     LEFT JOIN fin_categories c ON c.id = t.category_id
     LEFT JOIN fin_accounts a ON a.id = t.source_account_id
     LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending'::text AND fin_can_read_all(auth.uid());
