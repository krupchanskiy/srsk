-- 676: объединение дублей — понятный отказ, если у обеих карточек есть сделка на один ретрит.
-- Сделки не сливаем автоматически: на 11.10 все такие пары — супруги/родственники с общим телефоном
-- или почтой, а не дубли (ВГ, 11.10). Если это всё же один человек — сделки сводит администратор.
CREATE OR REPLACE FUNCTION public.merge_vaishnavas(p_main uuid, p_dup uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_moved jsonb := '{}'::jsonb;
  v_cnt bigint;
  v_conflict text;
BEGIN
  IF p_main = p_dup THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Карточка не может поглотить сама себя');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = p_main) OR
     NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = p_dup) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Карточка не найдена');
  END IF;

  SELECT string_agg(ret.name_ru, ', ') INTO v_conflict
    FROM retreat_registrations a
    JOIN retreat_registrations b ON b.retreat_id = a.retreat_id AND b.vaishnava_id = p_main
    JOIN retreats ret ON ret.id = a.retreat_id
   WHERE a.vaishnava_id = p_dup;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      format('Обе карточки зарегистрированы на: %s — разберите вручную', v_conflict));
  END IF;

  -- Сделка на один ретрит у обеих (676): чаще всего это разные люди — супруги, родственники
  SELECT string_agg(ret.name_ru, ', ') INTO v_conflict
    FROM crm_deals a
    JOIN crm_deals b ON b.retreat_id = a.retreat_id AND b.vaishnava_id = p_main
    JOIN retreats ret ON ret.id = a.retreat_id
   WHERE a.vaishnava_id = p_dup;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      format('У обеих карточек есть сделка на: %s. Проверьте, точно ли это один человек — так часто выглядят супруги или родственники с общим телефоном или почтой. Разные люди — нажмите «Не дубль». Один человек — напишите администратору, сделки сведут вручную', v_conflict));
  END IF;

  FOR r IN
    SELECT tc.table_name AS tbl, kcu.column_name AS col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'vaishnavas' AND ccu.column_name = 'id'
       AND tc.table_schema = 'public'
     ORDER BY 1, 2
  LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col)
      USING p_main, p_dup;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN
      v_moved := v_moved || jsonb_build_object(r.tbl || '.' || r.col, v_cnt);
    END IF;
  END LOOP;

  DELETE FROM family_links WHERE vaishnava_id = relative_id;
  UPDATE vaishnavas SET parent_id = NULL WHERE id = p_main AND parent_id = p_main;
  UPDATE vaishnavas SET senior_id = NULL WHERE id = p_main AND senior_id = p_main;

  UPDATE vaishnavas SET is_deleted = true, user_id = NULL WHERE id = p_dup;

  RETURN jsonb_build_object('ok', true, 'moved', v_moved);
END;
$function$;
