-- Триггер auto_create_auth_for_vaishnava: случайный пароль вместо общего.
--
-- Было: при вставке карточки с email без user_id триггер создавал
-- пользователя в auth.users с общим паролем (один на всех гостей и один
-- на всех сотрудников), email сразу подтверждён. Любой, кто знает чужую
-- почту, мог войти под этим человеком.
--
-- Стало: пароль случайный, никому не известен. Человек входит по ссылке
-- из почты («По ссылке») или задаёт свой пароль через «Забыли пароль?».
-- Email по-прежнему подтверждён — без этого не работают ни ссылка, ни сброс.
-- Уже созданные аккаунты не трогаются.
--
-- Применено на prod 2026-09-29.

CREATE OR REPLACE FUNCTION public.auto_create_auth_for_vaishnava()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_auth_id UUID;
BEGIN
    IF NEW.email IS NULL OR NEW.email = '' OR NEW.user_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT id INTO v_auth_id FROM auth.users WHERE email = LOWER(NEW.email);
    IF v_auth_id IS NOT NULL THEN
        NEW.user_id := v_auth_id;
        RETURN NEW;
    END IF;
    -- Пароль случайный и никому не известен: человек входит по ссылке из почты
    -- или задаёт свой пароль через «Забыли пароль?»
    INSERT INTO auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, recovery_token, reauthentication_token,
        email_change, email_change_token_new, email_change_token_current
    ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(), 'authenticated', 'authenticated',
        LOWER(NEW.email),
        crypt(encode(gen_random_bytes(32), 'hex'), gen_salt('bf')),
        now(), now(), now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        '{}'::jsonb,
        '', '', '', '', '', ''
    )
    RETURNING id INTO v_auth_id;
    INSERT INTO auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    VALUES (gen_random_uuid(), v_auth_id, v_auth_id::text, 'email',
        jsonb_build_object('sub', v_auth_id::text, 'email', LOWER(NEW.email)),
        now(), now(), now());
    NEW.user_id := v_auth_id;
    RETURN NEW;
END;
$function$;
