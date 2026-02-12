// ==================== PORTAL-AUTH.JS ====================
// Авторизация для Personal Portal
// Доступ для гостей (guest) и команды (staff)

(function() {
'use strict';

const db = window.portalSupabase;

// Глобальный объект текущего пользователя
window.currentGuest = null;

/**
 * Проверка авторизации гостя
 * @returns {Promise<object|null>} Данные гостя или null
 */
async function checkGuestAuth() {
    try {
        // Проверяем сессию
        const { data: { session }, error: sessionError } = await db.auth.getSession();

        if (sessionError || !session) {
            redirectToLogin('no_session');
            return null;
        }

        // Загружаем данные пользователя
        const { data: vaishnava, error: userError } = await db
            .from('vaishnavas')
            .select(`
                id,
                first_name,
                last_name,
                spiritual_name,
                email,
                phone,
                has_whatsapp,
                telegram,
                telegram_username,
                telegram_chat_id,
                country,
                city,
                photo_url,
                user_type,
                spiritual_teacher,
                no_spiritual_teacher,
                birth_date,
                is_active,
                is_profile_public
            `)
            .eq('user_id', session.user.id)
            .maybeSingle();

        if (userError) {
            console.error('[Portal Auth] Query error:', userError);
            redirectToLogin('error');
            return null;
        }

        if (!vaishnava) {
            console.error('[Portal Auth] User not found for auth.uid:', session.user.id);
            redirectToLogin('user_not_found');
            return null;
        }

        // Проверяем активность аккаунта
        if (vaishnava.is_active === false) {
            console.error('Аккаунт деактивирован');
            await db.auth.signOut();
            redirectToLogin('account_disabled');
            return null;
        }

        // Сохраняем данные пользователя глобально
        window.currentGuest = {
            id: vaishnava.id,
            authId: session.user.id,
            email: session.user.email,
            firstName: vaishnava.first_name,
            lastName: vaishnava.last_name,
            spiritualName: vaishnava.spiritual_name,
            phone: vaishnava.phone,
            hasWhatsapp: vaishnava.has_whatsapp,
            telegram: vaishnava.telegram,
            telegramUsername: vaishnava.telegram_username,
            telegram_chat_id: vaishnava.telegram_chat_id,
            country: vaishnava.country,
            city: vaishnava.city,
            photoUrl: vaishnava.photo_url,
            spiritualTeacher: vaishnava.spiritual_teacher,
            noSpiritualTeacher: vaishnava.no_spiritual_teacher || false,
            birthDate: vaishnava.birth_date,
            userType: vaishnava.user_type,
            isStaff: vaishnava.user_type === 'staff',
            isProfilePublic: vaishnava.is_profile_public !== false // default true
        };

        return window.currentGuest;

    } catch (error) {
        console.error('Ошибка проверки авторизации:', error);
        redirectToLogin('error');
        return null;
    }
}

/**
 * Редирект на страницу входа
 * @param {string} reason - Причина редиректа
 */
function redirectToLogin(reason) {
    const currentPage = window.location.pathname;
    // Не редиректим если уже на странице логина
    if (currentPage.includes('/login')) return;

    window.location.href = `/login/?reason=${reason}&redirect=${encodeURIComponent(currentPage)}`;
}

/**
 * Выход из аккаунта
 */
async function logout() {
    try {
        await db.auth.signOut();
        window.currentGuest = null;
        window.location.href = '/login/';
    } catch (error) {
        console.error('Ошибка выхода:', error);
        // Принудительно очищаем и редиректим
        window.currentGuest = null;
        window.location.href = '/login/';
    }
}

/**
 * Отправка magic link на email
 * @param {string} email
 * @returns {Promise<{success: boolean, error?: string, isNewUser?: boolean}>}
 */
async function sendMagicLink(email) {
    try {
        // Проверяем есть ли vaishnava с таким email
        const { data: vaishnava, error: checkError } = await db
            .from('vaishnavas')
            .select('id, email, user_id, is_active')
            .ilike('email', email)
            .maybeSingle();

        if (checkError) {
            console.error('[Magic Link] Check error:', checkError);
            return { success: false, error: 'check_failed' };
        }

        // Если нет записи — предлагаем зарегистрироваться
        if (!vaishnava) {
            return { success: false, error: 'not_registered', isNewUser: true };
        }

        // Если аккаунт деактивирован
        if (vaishnava.is_active === false) {
            return { success: false, error: 'account_disabled' };
        }

        // Отправляем magic link
        const redirectUrl = window.location.origin + '/auth-callback/';
        const { error: otpError } = await db.auth.signInWithOtp({
            email: email,
            options: {
                emailRedirectTo: redirectUrl,
                shouldCreateUser: true // Создаст auth user если его нет
            }
        });

        if (otpError) {
            console.error('[Magic Link] OTP error:', otpError);
            return { success: false, error: 'send_failed' };
        }

        return { success: true };

    } catch (error) {
        console.error('[Magic Link] Error:', error);
        return { success: false, error: 'unknown_error' };
    }
}

/**
 * Связывание auth user с существующим vaishnava
 * Вызывается после успешного входа по magic link
 * Использует database function для обхода RLS
 * @returns {Promise<{success: boolean, vaishnavId?: string, error?: string}>}
 */
async function linkAuthUserToVaishnava() {
    try {
        const { data: { session } } = await db.auth.getSession();
        if (!session) {
            return { success: false, error: 'no_session' };
        }

        // Вызываем database function
        const { data, error } = await db.rpc('link_auth_user_to_vaishnava');

        if (error) {
            console.error('[Link] RPC error:', error);
            return { success: false, error: 'rpc_failed' };
        }

        // Функция возвращает массив с одной строкой
        const result = data?.[0];
        if (!result) {
            console.error('[Link] No result from RPC');
            return { success: false, error: 'no_result' };
        }

        if (!result.success) {
            console.error('[Link] Function returned error:', result.error_code);
            return { success: false, error: result.error_code };
        }

        return { success: true, vaishnavId: result.vaishnava_id };

    } catch (error) {
        console.error('[Link] Error:', error);
        return { success: false, error: 'unknown_error' };
    }
}

/**
 * Вход по email/password
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function login(email, password) {
    try {
        const { data, error } = await db.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            return { success: false, error: error.message };
        }

        // Проверяем пользователя
        const { data: vaishnava, error: userError } = await db
            .from('vaishnavas')
            .select('user_type, is_active')
            .eq('user_id', data.user.id)
            .single();

        if (userError || !vaishnava) {
            await db.auth.signOut();
            return { success: false, error: 'user_not_found' };
        }

        if (vaishnava.is_active === false) {
            await db.auth.signOut();
            return { success: false, error: 'account_disabled' };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка входа:', error);
        return { success: false, error: 'unknown_error' };
    }
}

/**
 * Получить имя гостя для отображения
 * @returns {string}
 */
function getGuestDisplayName() {
    if (!window.currentGuest) return '';

    return window.currentGuest.spiritualName ||
           `${window.currentGuest.firstName || ''} ${window.currentGuest.lastName || ''}`.trim() ||
           'Гость';
}

/**
 * Вычислить процент заполнения профиля
 * @returns {number} 0-100
 */
function getProfileCompleteness() {
    if (!window.currentGuest) return 0;

    const fields = [
        'firstName',
        'lastName',
        'spiritualName',
        'email',
        'phone',
        'country',
        'city',
        'photoUrl',
        'spiritualTeacher',
        'birthDate'
    ];

    let filled = 0;
    for (const field of fields) {
        if (window.currentGuest[field]) filled++;
    }

    return Math.round((filled / fields.length) * 100);
}

// Экспорт
window.PortalAuth = {
    checkGuestAuth,
    login,
    logout,
    sendMagicLink,
    linkAuthUserToVaishnava,
    getGuestDisplayName,
    getProfileCompleteness,
    redirectToLogin
};

})();
