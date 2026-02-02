-- ============================================
-- Функция для самостоятельной регистрации гостя
-- Позволяет новому пользователю создать запись vaishnavas для себя
-- ============================================

CREATE OR REPLACE FUNCTION register_guest(
    p_email TEXT,
    p_first_name TEXT,
    p_last_name TEXT,
    p_spiritual_name TEXT DEFAULT NULL,
    p_phone TEXT DEFAULT NULL,
    p_telegram_username TEXT DEFAULT NULL,
    p_country TEXT DEFAULT NULL,
    p_city TEXT DEFAULT NULL
)
RETURNS TABLE(
    success BOOLEAN,
    vaishnava_id UUID,
    error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user_id UUID;
    v_existing_id UUID;
    v_new_id UUID;
BEGIN
    -- Получаем ID текущего пользователя
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RETURN QUERY SELECT FALSE, NULL::UUID, 'not_authenticated'::TEXT;
        RETURN;
    END IF;

    -- Проверяем, нет ли уже записи с этим user_id
    SELECT id INTO v_existing_id FROM vaishnavas WHERE user_id = v_user_id;

    IF v_existing_id IS NOT NULL THEN
        RETURN QUERY SELECT FALSE, v_existing_id, 'already_exists'::TEXT;
        RETURN;
    END IF;

    -- Проверяем, нет ли записи с таким email (без user_id)
    SELECT id INTO v_existing_id
    FROM vaishnavas
    WHERE LOWER(email) = LOWER(p_email)
      AND user_id IS NULL;

    IF v_existing_id IS NOT NULL THEN
        -- Связываем существующую запись с auth user
        UPDATE vaishnavas
        SET user_id = v_user_id,
            updated_at = NOW()
        WHERE id = v_existing_id;

        RETURN QUERY SELECT TRUE, v_existing_id, NULL::TEXT;
        RETURN;
    END IF;

    -- Создаём новую запись
    INSERT INTO vaishnavas (
        user_id,
        email,
        first_name,
        last_name,
        spiritual_name,
        phone,
        telegram_username,
        country,
        city,
        user_type,
        approval_status,
        is_active
    ) VALUES (
        v_user_id,
        LOWER(p_email),
        p_first_name,
        p_last_name,
        NULLIF(p_spiritual_name, ''),
        NULLIF(p_phone, ''),
        NULLIF(p_telegram_username, ''),
        NULLIF(p_country, ''),
        NULLIF(p_city, ''),
        'guest',
        'approved',
        TRUE
    )
    RETURNING id INTO v_new_id;

    RETURN QUERY SELECT TRUE, v_new_id, NULL::TEXT;
END;
$$;

-- Даём права на выполнение функции authenticated пользователям
GRANT EXECUTE ON FUNCTION register_guest TO authenticated;

-- Комментарий
COMMENT ON FUNCTION register_guest IS 'Безопасная самостоятельная регистрация гостя с обходом RLS';
