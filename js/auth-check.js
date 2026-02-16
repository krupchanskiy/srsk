// AUTH-CHECK.JS
// Проверка авторизации на защищенных страницах
// Подключать ПЕРЕД layout.js на каждой странице (кроме login.html)

(async function() {
    'use strict';

    // Список публичных страниц (не требуют авторизации)
    const publicPages = ['login.html', 'team-signup.html', 'guest-signup.html', 'pending-approval.html'];
    const currentPage = window.location.pathname.split('/').pop();

    if (publicPages.includes(currentPage)) {
        return;
    }

    window._authInProgress = true;

    try {
        // Используем централизованный Supabase клиент из config.js
        const db = window.supabaseClient;

        // Проверяем текущую сессию
        const { data: { session }, error } = await db.auth.getSession();

        if (error) {
            console.error('Auth check error:', error);
        }

        // Если нет сессии - редирект на логин
        if (!session) {
            const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = '/login.html?redirect=' + returnUrl;
            return;
        }

        // Загружаем данные вайшнава
        const { data: vaishnava, error: vError } = await db
            .from('vaishnavas')
            .select('id, spiritual_name, first_name, last_name, photo_url, user_type, approval_status, is_superuser, is_active')
            .eq('user_id', session.user.id)
            .eq('is_deleted', false)
            .single();

        if (vError) {
            console.error('Failed to load vaishnava:', vError);
            // Если пользователя нет в vaishnavas - выход
            await db.auth.signOut();
            const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = '/login.html?redirect=' + returnUrl;
            return;
        }

        // Проверка статуса одобрения
        if (vaishnava.approval_status === 'pending') {
            window.location.href = '/pending-approval.html';
            return;
        }

        if (vaishnava.approval_status === 'rejected' || vaishnava.approval_status === 'blocked' || !vaishnava.is_active) {
            await db.auth.signOut();
            // Используем alert т.к. Layout может быть не загружен, и мы уходим на /login.html
            alert('Ваш аккаунт заблокирован или отклонён. Свяжитесь с администратором.');
            window.location.href = '/login.html';
            return;
        }

        // Загрузить права пользователя одним запросом через SQL функцию
        let permissions = [];

        if (vaishnava.is_superuser) {
            // Суперпользователь - все права
            const { data: allPerms } = await db
                .from('permissions')
                .select('code');
            permissions = allPerms ? allPerms.map(p => p.code) : [];
        } else {
            // Получить права через оптимизированную SQL функцию (1 запрос вместо 3)
            const { data: userPerms, error: permsError } = await db
                .rpc('get_user_permissions', { p_user_id: session.user.id });

            if (permsError) {
                console.error('Failed to load permissions:', permsError);
            }
            permissions = userPerms ? userPerms.map(p => p.permission_code) : [];
        }

        // Сохранить в window.currentUser
        window.currentUser = {
            ...session.user,
            vaishnava_id: vaishnava.id,
            name: vaishnava.spiritual_name || vaishnava.first_name,
            photo_url: vaishnava.photo_url,
            user_type: vaishnava.user_type,
            is_superuser: vaishnava.is_superuser,
            permissions: permissions
        };

        // Создать глобальную функцию hasPermission()
        window.hasPermission = function(permCode) {
            return window.currentUser?.is_superuser || window.currentUser?.permissions.includes(permCode);
        };

        // Проверка доступа: основное приложение или гостевой портал
        // Если у пользователя есть права кроме базовых гостевых — пускаем в основное приложение
        const guestOnlyPerms = new Set(['view_own_profile', 'edit_own_profile', 'view_own_bookings']);
        const isGuestOnly = !vaishnava.is_superuser
            && (permissions.length === 0 || permissions.every(p => guestOnlyPerms.has(p)));

        if (isGuestOnly) {
            const path = window.location.pathname;

            // Гость без доп. прав — только свой профиль и гостевой портал
            if (path.startsWith('/guest-portal/')) {
                // Гостевой портал — разрешаем
            } else if (path.endsWith('/vaishnavas/person.html')) {
                const urlParams = new URLSearchParams(window.location.search);
                const personId = urlParams.get('id');
                if (!personId || personId !== vaishnava.id) {
                    window.location.href = `/vaishnavas/person.html?id=${vaishnava.id}`;
                    return;
                }
            } else {
                window.location.href = `/vaishnavas/person.html?id=${vaishnava.id}`;
                return;
            }
        }

        console.log('✅ User authenticated');
        console.log('📋 Permissions loaded:', permissions.length);
        console.log('👤 User type:', vaishnava.user_type);

        // Добавить класс роли на body для CSS-контроля
        document.body.classList.add(`user-type-${vaishnava.user_type}`);
        if (vaishnava.is_superuser) {
            document.body.classList.add('is-superuser');
        }

        // Обновить аватар в хедере (Layout мог загрузиться раньше, чем auth завершился)
        if (typeof Layout !== 'undefined' && Layout.updateUserInfo) {
            Layout.updateUserInfo();
        }

        // Глобальная функция применения прав к UI-элементам
        window.applyPermissions = function() {
            if (!window.currentUser || !window.hasPermission) return;
            if (window.currentUser.is_superuser) {
                // Суперюзер видит всё — скрыть сообщения об отсутствии прав
                document.querySelectorAll('[data-no-permission]').forEach(el => {
                    el.style.display = 'none';
                });
                return;
            }

            // Скрыть элементы без нужных прав
            document.querySelectorAll('[data-permission]').forEach(el => {
                const perm = el.getAttribute('data-permission');
                if (!window.hasPermission(perm)) {
                    el.style.display = 'none';
                    el.classList.add('permission-hidden');
                    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') {
                        el.disabled = true;
                    }
                }
            });

            // Показать сообщения когда НЕТ прав (обратная логика)
            document.querySelectorAll('[data-no-permission]').forEach(el => {
                const perm = el.getAttribute('data-no-permission');
                if (window.hasPermission(perm)) {
                    el.style.display = 'none'; // Есть права — скрыть сообщение
                } else {
                    el.style.display = ''; // Нет прав — показать сообщение
                }
            });
        };

        // Применить права к статическим элементам
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', window.applyPermissions);
        } else {
            window.applyPermissions();
        }

        // Применить повторно через 500мс для динамического контента
        setTimeout(window.applyPermissions, 500);

        console.log('✅ Permissions system ready');

        // Отправить событие о готовности авторизации
        window.dispatchEvent(new CustomEvent('authReady', { detail: window.currentUser }));

    } catch (err) {
        console.error('Auth check exception:', err);
        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/login.html?redirect=' + returnUrl;
    }
})();
