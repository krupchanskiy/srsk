-- Функция для связывания auth user с vaishnava по email
-- SECURITY DEFINER позволяет обойти RLS
CREATE OR REPLACE FUNCTION link_auth_user_to_vaishnava()
RETURNS TABLE (success boolean, vaishnava_id uuid, error_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_id uuid;
    v_email text;
    v_vaishnava_id uuid;
    v_existing_user_id uuid;
BEGIN
    -- Получаем текущего auth user
    v_auth_id := auth.uid();
    IF v_auth_id IS NULL THEN
        RETURN QUERY SELECT false, NULL::uuid, 'no_session'::text;
        RETURN;
    END IF;

    -- Получаем email из auth.users
    SELECT email INTO v_email FROM auth.users WHERE id = v_auth_id;
    IF v_email IS NULL THEN
        RETURN QUERY SELECT false, NULL::uuid, 'no_email'::text;
        RETURN;
    END IF;

    -- Проверяем, может уже связан
    SELECT id INTO v_vaishnava_id FROM vaishnavas WHERE user_id = v_auth_id LIMIT 1;
    IF v_vaishnava_id IS NOT NULL THEN
        -- Уже связан
        RETURN QUERY SELECT true, v_vaishnava_id, NULL::text;
        RETURN;
    END IF;

    -- Ищем vaishnava по email
    SELECT id, user_id INTO v_vaishnava_id, v_existing_user_id
    FROM vaishnavas
    WHERE LOWER(email) = LOWER(v_email)
    LIMIT 1;

    IF v_vaishnava_id IS NULL THEN
        -- Не найден
        RETURN QUERY SELECT false, NULL::uuid, 'not_found'::text;
        RETURN;
    END IF;

    IF v_existing_user_id IS NOT NULL AND v_existing_user_id != v_auth_id THEN
        -- Уже связан с другим auth user
        RETURN QUERY SELECT false, NULL::uuid, 'conflict'::text;
        RETURN;
    END IF;

    -- Связываем
    UPDATE vaishnavas SET user_id = v_auth_id WHERE id = v_vaishnava_id;

    RETURN QUERY SELECT true, v_vaishnava_id, NULL::text;
END;
$$;

-- Даём права на выполнение
GRANT EXECUTE ON FUNCTION link_auth_user_to_vaishnava() TO authenticated;
