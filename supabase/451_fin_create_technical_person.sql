-- =============================================================
-- Payroll: техническая запись человека для ведомости.
--
-- Часть сотрудников — местные жители без компьютера и интернета: они
-- никогда не зарегистрируются, но им платят зарплату, а ведомость и весь
-- финмодуль ссылаются на vaishnavas (ВГ, 21.09.2026). Запись без
-- user_id — так уже заведены другие сотрудники (is_team_member, staff).
-- Дубли по имени не создаём: сначала нужно найти человека в поиске.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fin_create_technical_person(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
  v_id uuid;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['name']);

  v_name := NULLIF(regexp_replace(btrim(COALESCE(payload->>'name', '')), '\s+', ' ', 'g'), '');
  IF v_name IS NULL OR length(v_name) < 2 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Укажите имя';
  END IF;

  IF EXISTS (
    SELECT 1 FROM vaishnavas
     WHERE is_deleted = false
       AND lower(btrim(concat_ws(' ', first_name, last_name))) = lower(v_name)
  ) OR EXISTS (
    SELECT 1 FROM vaishnavas
     WHERE is_deleted = false AND lower(btrim(COALESCE(spiritual_name, ''))) = lower(v_name)
  ) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Человек с таким именем уже есть — найдите его в поиске';
  END IF;

  INSERT INTO vaishnavas (first_name, is_team_member, user_type, notes)
  VALUES (v_name, true, 'staff', 'Техническая запись для зарплатной ведомости (не пользователь системы)')
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id, 'name', v_name));
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

REVOKE ALL ON FUNCTION public.fin_create_technical_person(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_create_technical_person(jsonb) TO authenticated;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_payroll_create_person', 'Нет в базе? Создать', 'Not in the database? Create', 'डेटाबेस में नहीं है? बनाएँ', 'Финансы'),
  ('fin_payroll_create_person_prompt', 'Имя нового человека (техническая запись, без регистрации)', 'Name of the new person (technical record, no registration)', 'नए व्यक्ति का नाम (तकनीकी रिकॉर्ड, पंजीकरण के बिना)', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
