-- Ответ бота на заявку: в чате департамента — остаток департамента, а не кассы (правка к 767).
-- Деньги из кассы или с другого счёта без департамента: при выдаче показываем подотчёт
-- получателя, при расходе — подотчёт департамента заявки. Счёт департамента — как раньше.

DO $mig$
DECLARE
  v_oid regprocedure := 'public.tg_post_draft(uuid, jsonb, uuid, text, uuid, boolean)';
  v_def text := pg_get_functiondef(v_oid);
  v_old CONSTANT text :=
       E'    v_bal_line := format(CASE WHEN v_src_is_dept THEN E\'\\nНа руках у «%s»: %s\' ELSE E\'\\nОсталось в «%s»: %s\' END,\n'
    || E'                         tg_escape(v_payer_dept),\n'
    || E'                         fin_fmt_money(fin_private_account_balance(v_acc), v_d.currency));\n';
  v_new CONSTANT text :=
       E'    v_bal_acc := CASE WHEN v_src_is_dept THEN v_acc\n'
    || E'                      WHEN v_d.kind = \'transfer\' THEN v_tgt\n'
    || E'                      WHEN v_d.department_id IS NOT NULL THEN fin_dept_account(v_d.department_id, v_d.currency)\n'
    || E'                 END;\n'
    || E'    IF v_bal_acc IS NOT NULL THEN\n'
    || E'      SELECT format(E\'\\nНа руках у «%s»: %s\', tg_escape(d.name),\n'
    || E'                    fin_fmt_money(fin_private_account_balance(a.id), v_d.currency))\n'
    || E'        INTO v_bal_line\n'
    || E'        FROM fin_accounts a JOIN fin_departments d ON d.id = a.department_id\n'
    || E'       WHERE a.id = v_bal_acc;\n'
    || E'    END IF;\n'
    || E'    v_bal_line := COALESCE(v_bal_line, \'\');\n';
  v_decl_old CONSTANT text := E'  v_src_is_dept boolean; v_bal_line text;\n';
  v_decl_new CONSTANT text := E'  v_src_is_dept boolean; v_bal_line text; v_bal_acc uuid;\n';
BEGIN
  IF position(v_old IN v_def) = 0 OR position(v_decl_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'tg_post_draft: текст 767 не найден';
  END IF;
  EXECUTE replace(replace(v_def, v_old, v_new), v_decl_old, v_decl_new);
END
$mig$;
