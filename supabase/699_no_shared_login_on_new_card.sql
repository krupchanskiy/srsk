-- 699: новая карточка не цепляется к чужому входу.
-- Триггер при заведении карточки привязывал её к любому входу с той же почтой.
-- Родственников и группы часто заводят на почту плательщика (а безымянных —
-- на test@rupaseva.com), и все они оказывались на одном входе: портал гостя
-- такой вход не пускает. Теперь, если вход уже принадлежит живой карточке,
-- новая остаётся без входа; общий кабинет семьи — через family_links.

create or replace function public.auto_create_auth_for_vaishnava()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
DECLARE
    v_auth_id UUID;
BEGIN
    IF NEW.email IS NULL OR NEW.email = '' OR NEW.user_id IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT id INTO v_auth_id FROM auth.users WHERE email = LOWER(NEW.email);
    IF v_auth_id IS NOT NULL THEN
        -- вход уже чей-то (родственник, плательщик группы) — не делим его
        IF NOT EXISTS (SELECT 1 FROM vaishnavas
                        WHERE user_id = v_auth_id AND NOT coalesce(is_deleted, false)) THEN
            NEW.user_id := v_auth_id;
        END IF;
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
