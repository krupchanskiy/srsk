-- 698: перевод из ДДС — кому из держателей получателя легли деньги (ВГ, 15.10.2026)
--
-- Раньше выбор держателя был только у заявок из чата (689, tg_post_draft).
-- Перевод, который казначей делает сам в ДДС, ложился у Кафе и Зелёных
-- «не привязано». Теперь fin_create_transfer принимает необязательный
-- target_holder_person_id и ставит его на приход получателя.
-- Без поля — как раньше (holder пустой): у Кафе это и есть «выдано на сдачу».
-- Обязательность выбора — на странице, а не здесь: функцию зовут и внутренние
-- RPC (ведомость, касса кафе), им держатель не нужен.

DO $mig$
DECLARE
  def text := pg_get_functiondef('public.fin_create_transfer(jsonb)'::regprocedure);
  new text;
  procedure_step text;
BEGIN
  procedure_step := 'переменная';
  new := replace(def, E'  v_comment text;\n', E'  v_comment text;\n  v_target_holder uuid;\n');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'разрешённый ключ';
  new := replace(def, $$'source_amount', 'target_amount', 'comment'
  ]);$$, $$'source_amount', 'target_amount', 'comment', 'target_holder_person_id'
  ]);$$);
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'чтение поля';
  new := replace(def, E'  v_comment       := NULLIF(trim(COALESCE(payload->>''comment'', '''')), '''');\n',
                      E'  v_comment       := NULLIF(trim(COALESCE(payload->>''comment'', '''')), '''');\n'
                   || E'  v_target_holder := fin_private_get_uuid(payload, ''target_holder_person_id'', false);\n');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  -- в хэш только когда задан: старые вызовы дают тот же хэш, что и раньше
  procedure_step := 'хэш';
  new := replace(def, E'    ''comment'', v_comment\n  );\n',
                      E'    ''comment'', v_comment\n  );\n'
                   || E'  IF v_target_holder IS NOT NULL THEN\n'
                   || E'    v_canonical := v_canonical || jsonb_build_object(''target_holder_person_id'', lower(v_target_holder::text));\n'
                   || E'  END IF;\n');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'проверка держателя';
  new := replace(def, E'    RAISE EXCEPTION ''account_inactive'' USING DETAIL = ''Один из счетов деактивирован'';\n  END IF;\n',
                      E'    RAISE EXCEPTION ''account_inactive'' USING DETAIL = ''Один из счетов деактивирован'';\n  END IF;\n\n'
                   || E'  IF v_target_holder IS NOT NULL AND NOT EXISTS (\n'
                   || E'       SELECT 1 FROM fin_department_holders\n'
                   || E'        WHERE department_id = v_target.department_id\n'
                   || E'          AND vaishnava_id = v_target_holder AND is_active) THEN\n'
                   || E'    RAISE EXCEPTION ''invalid_payload''\n'
                   || E'      USING DETAIL = ''Выбранный человек не держит наличные департамента-получателя'';\n'
                   || E'  END IF;\n');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'держатель на приходе';
  new := replace(def, E'  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used)\n'
                   || E'  VALUES\n'
                   || E'    (fin_private_child_uuid(v_request_id, ''out''), v_request_id, v_source.id, ''out'',\n'
                   || E'     v_source_amount, v_source.currency_code, v_source_base, v_source_rate),\n'
                   || E'    (fin_private_child_uuid(v_request_id, ''in''), v_request_id, v_target.id, ''in'',\n'
                   || E'     v_target_amount, v_target.currency_code, v_source_base, v_target_rate);',
                      E'  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used, holder_person_id)\n'
                   || E'  VALUES\n'
                   || E'    (fin_private_child_uuid(v_request_id, ''out''), v_request_id, v_source.id, ''out'',\n'
                   || E'     v_source_amount, v_source.currency_code, v_source_base, v_source_rate, NULL),\n'
                   || E'    (fin_private_child_uuid(v_request_id, ''in''), v_request_id, v_target.id, ''in'',\n'
                   || E'     v_target_amount, v_target.currency_code, v_source_base, v_target_rate, v_target_holder);');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;

  EXECUTE new;
END
$mig$;
