-- Убираем старую четырёхаргументную перегрузку и переводим оба вызова в tg_post_draft
-- на новую: в чат получателя должен идти плательщик, а не ответственный получателя.
drop function if exists public.tg_notify_dept_expense(uuid, uuid, text, text);

do $$
declare
  v_def text;
  v_старый_групповой text;
  v_новый_групповой text;
  v_старый_одиночный text;
  v_новый_одиночный text;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_post_draft'
     and pg_get_function_identity_arguments(p.oid) like '%p_rows%';

  -- Групповая ветка: раньше имя автора подменялось названием департамента,
  -- теперь передаём их порознь — функция сама решит, как подписать.
  v_старый_групповой := 'PERFORM tg_notify_dept_expense(v_grp_op, v_tgt_acc,
                                         COALESCE(v_author, v_payer_dept), btrim(v_d.purpose));';
  v_новый_групповой := 'PERFORM tg_notify_dept_expense(v_grp_op, v_tgt_acc,
                                         v_author, btrim(v_d.purpose), v_payer_dept);';

  -- Одиночная ветка: больше не подставляем ответственного получателя —
  -- он денег не тратил, платил другой департамент.
  v_старый_одиночный := '-- «Потратил» — сам получатель: деньги выдали ему, он их и израсходовал
        SELECT COALESCE(NULLIF(v.spiritual_name, ''''),
                        NULLIF(TRIM(COALESCE(v.first_name,'''') || '' '' || COALESCE(v.last_name,'''')), ''''))
          INTO v_who
          FROM fin_departments d
          LEFT JOIN vaishnavas v ON v.id = d.responsible_person_id
         WHERE d.id = v_d.target_department_id;

        PERFORM tg_notify_dept_expense(v_grp_op, v_tgt, COALESCE(v_who, v_tgt_dept),
                                       COALESCE(NULLIF(btrim(v_d.purpose), ''''), v_d.raw_text));';
  v_новый_одиночный := '-- Платит один департамент, расход относится на другой: получателю важно
        -- видеть, что деньги дал плательщик, а не его собственный ответственный.
        PERFORM tg_notify_dept_expense(v_grp_op, v_tgt, v_author,
                                       COALESCE(NULLIF(btrim(v_d.purpose), ''''), v_d.raw_text),
                                       v_payer_dept);';

  if position(v_старый_групповой in v_def) = 0 then
    raise exception 'не найден групповой вызов tg_notify_dept_expense — правка отменена';
  end if;
  if position(v_старый_одиночный in v_def) = 0 then
    raise exception 'не найден одиночный вызов tg_notify_dept_expense — правка отменена';
  end if;

  v_def := replace(v_def, v_старый_групповой, v_новый_групповой);
  v_def := replace(v_def, v_старый_одиночный, v_новый_одиночный);
  execute v_def;
end $$;
