-- Продолжение 298: сохранение набора статей департамента через ту же RPC.
-- Правило необязательных полей прежнее и здесь тоже: нет ключа в payload —
-- набор не трогаем; пустой массив — очищаем осознанно (значит «общий набор»).
CREATE OR REPLACE FUNCTION public.fin_save_department(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_name text;
  v_resp uuid;
  v_resp_given boolean;
  v_chat bigint;
  v_chat_given boolean;
  v_cats_given boolean;
  v_bad int;
  v_old_name text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload,
    ARRAY['id', 'name', 'responsible_person_id', 'chat_id', 'category_ids']);

  v_name := NULLIF(btrim(COALESCE(payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Название департамента обязательно';
  END IF;

  v_id   := fin_private_get_uuid(payload, 'id');
  v_resp_given := payload ? 'responsible_person_id';
  v_resp := fin_private_get_uuid(payload, 'responsible_person_id');
  v_chat_given := payload ? 'chat_id';
  v_chat := NULLIF(payload->>'chat_id', '')::bigint;
  v_cats_given := payload ? 'category_ids';

  IF v_resp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_resp) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ответственный не найден в справочнике людей';
  END IF;

  IF EXISTS (SELECT 1 FROM fin_departments
              WHERE lower(name) = lower(v_name) AND (v_id IS NULL OR id <> v_id)) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Департамент «%s» уже есть', v_name);
  END IF;

  IF v_chat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tg_known_chats WHERE chat_id = v_chat) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Такого чата бот ещё не видел — добавьте бота в чат, он появится в списке';
  END IF;

  -- В наборе департамента могут быть только действующие расходные статьи:
  -- иначе бот предложил бы приходную статью или архивную.
  IF v_cats_given AND jsonb_typeof(payload->'category_ids') = 'array' THEN
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements_text(payload->'category_ids') x
     WHERE NOT EXISTS (SELECT 1 FROM fin_categories c
                        WHERE c.id = NULLIF(x, '')::uuid
                          AND c.is_active AND c.direction = 'out');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'В наборе есть статья, которая не является действующей статьёй расхода';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO fin_departments (name, responsible_person_id) VALUES (v_name, v_resp)
    RETURNING id INTO v_id;
  ELSE
    SELECT name INTO v_old_name FROM fin_departments WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
    END IF;

    UPDATE fin_departments
       SET name = v_name,
           responsible_person_id = CASE WHEN v_resp_given THEN v_resp ELSE responsible_person_id END
     WHERE id = v_id;

    IF v_old_name IS DISTINCT FROM v_name THEN
      UPDATE fin_accounts
         SET name = v_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')'
       WHERE department_id = v_id AND kind = 'custodial'
         AND name = v_old_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')';
      UPDATE tg_chat_links SET department_name = v_name WHERE department_id = v_id;
    END IF;
  END IF;

  IF v_chat_given THEN
    IF v_chat IS NOT NULL THEN
      UPDATE tg_chat_links SET is_active = false
       WHERE is_active AND (chat_id = v_chat OR department_id = v_id);
      INSERT INTO tg_chat_links (chat_id, department_id, department_name, is_active)
      VALUES (v_chat, v_id, v_name, true)
      ON CONFLICT (chat_id) DO UPDATE
        SET department_id = EXCLUDED.department_id,
            department_name = EXCLUDED.department_name,
            is_active = true;
    ELSE
      UPDATE tg_chat_links SET is_active = false WHERE department_id = v_id AND is_active;
    END IF;
  END IF;

  IF v_cats_given THEN
    DELETE FROM fin_department_categories WHERE department_id = v_id;
    INSERT INTO fin_department_categories (department_id, category_id)
    SELECT v_id, NULLIF(x, '')::uuid
      FROM jsonb_array_elements_text(COALESCE(payload->'category_ids', '[]'::jsonb)) x
     WHERE NULLIF(x, '') IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;
