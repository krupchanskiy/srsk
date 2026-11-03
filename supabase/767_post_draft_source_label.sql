-- Подпись источника в заявке из чата: имя и остаток — с одного и того же счёта.
-- Было: имя из заявки (department_id), остаток со счёта-источника. При выдаче из кассы
-- в чате Поклонения бот писал «На руках у «Поклонение»: 72 505», хотя это остаток Касса (₹).
-- Теперь у счёта департамента — «На руках у «Завод»», у остальных — «Осталось в «Касса (₹)»»;
-- то же имя идёт в комментарии («выдано …», «оплатил …») и в «Оплатил:» сообщения бота.
-- Правка точечная, текстом по действующей функции: каждая замена обязана найтись.

DO $mig$
DECLARE
  v_oid regprocedure := 'public.tg_post_draft(uuid, jsonb, uuid, text, uuid, boolean)';
  v_def text := pg_get_functiondef(v_oid);
  v_pair text[];
  v_src_select CONSTANT text := E'      SELECT COALESCE(d.name, a.name), d.id IS NOT NULL\n'
    || E'        INTO v_payer_dept, v_src_is_dept\n'
    || E'        FROM fin_accounts a LEFT JOIN fin_departments d ON d.id = a.department_id\n'
    || E'       WHERE a.id = v_acc;\n';
  v_bal_old CONSTANT text := E'fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency))';
BEGIN
  FOREACH v_pair SLICE 1 IN ARRAY ARRAY[
    -- имя больше не берётся из заявки
    [E'  SELECT name INTO v_payer_dept FROM fin_departments WHERE id = v_d.department_id;\n', ''],
    [E'  v_tgt_holder uuid; v_tgt_holders int; v_note_tg text := \'\';\n',
     E'  v_tgt_holder uuid; v_tgt_holders int; v_note_tg text := \'\';\n  v_src_is_dept boolean; v_bal_line text;\n'],
    -- счёт-источник выбран: расход
    [E'      v_comment := btrim(v_d.purpose) || v_chat_note;',
     v_src_select || E'      v_comment := btrim(v_d.purpose) || v_chat_note;'],
    -- счёт-источник выбран: выдача
    [E'      v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);',
     v_src_select || E'      v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);'],
    [E'  IF v_suppress THEN\n    IF v_has_dept THEN',
     E'  IF v_suppress THEN\n'
     || E'    v_bal_line := format(CASE WHEN v_src_is_dept THEN E\'\\nНа руках у «%s»: %s\' ELSE E\'\\nОсталось в «%s»: %s\' END,\n'
     || E'                         tg_escape(v_payer_dept),\n'
     || E'                         fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency));\n'
     || E'    IF v_has_dept THEN'],
    [E'format(E\'\\nНа руках у «%s»: %s\', tg_escape(v_payer_dept),\n                  ' || v_bal_old, 'v_bal_line'],
    [E'format(E\'\\nНа руках у департамента: %s\',\n                  ' || v_bal_old, 'v_bal_line']
  ] LOOP
    IF position(v_pair[1] IN v_def) = 0 THEN
      RAISE EXCEPTION 'tg_post_draft: не найдено: %', v_pair[1];
    END IF;
    v_def := replace(v_def, v_pair[1], v_pair[2]);
  END LOOP;
  EXECUTE v_def;
END
$mig$;
