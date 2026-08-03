// Устойчивое создание Auth-пользователя для форм самостоятельной регистрации.
// Восстанавливает регистрацию, если Auth-запись уже создана, а профиль ещё нет.
(function() {
    'use strict';

    function authError(code, cause = null) {
        const error = new Error(code);
        error.code = code;
        error.cause = cause;
        return error;
    }

    function isInvalidCredentials(error) {
        return error?.message?.includes('Invalid login credentials') || error?.code === 'invalid_credentials';
    }

    async function ensureUser(db, { email, password, metadata = {} }) {
        const normalizedEmail = email.trim().toLowerCase();

        // Сначала пробуем войти. Это восстанавливает регистрацию, которая ранее
        // оборвалась после создания auth.users, но до создания профиля vaishnavas.
        const { data: signInData, error: signInError } = await db.auth.signInWithPassword({
            email: normalizedEmail,
            password
        });

        if (!signInError && signInData?.user) {
            return { user: signInData.user, session: signInData.session, recovered: true };
        }

        if (signInError && !isInvalidCredentials(signInError)) {
            throw signInError;
        }

        // Вход не удался: для нового email создаём Auth-пользователя.
        const { data: signUpData, error: signUpError } = await db.auth.signUp({
            email: normalizedEmail,
            password,
            options: { data: metadata }
        });

        if (signUpError) {
            if (signUpError.message?.toLowerCase().includes('already registered')) {
                throw authError('account_exists_password_mismatch', signUpError);
            }
            throw signUpError;
        }

        // Supabase намеренно не возвращает ошибку для существующего подтверждённого
        // email. Пустой identities позволяет отличить такой ответ от новой регистрации.
        if (signUpData?.user && Array.isArray(signUpData.user.identities) && signUpData.user.identities.length === 0) {
            throw authError('account_exists_password_mismatch');
        }

        if (signUpData?.session && signUpData?.user) {
            return { user: signUpData.user, session: signUpData.session, recovered: false };
        }

        // На проектах с подтверждением email сессия появится только после письма.
        throw authError('email_confirmation_required');
    }

    window.SignupAuth = { ensureUser };
})();
