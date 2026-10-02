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
            .maybeSingle();

        if (vError || !vaishnava) {
            console.error('Failed to load vaishnava:', vError);
            // Пользователя нет в vaishnavas или RLS скрыла — выход
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
            // Суперпользователь - все права, КРОМЕ финансов (fin_* — только явно выданные)
            const [{ data: allPerms }, { data: ownPerms }] = await Promise.all([
                db.from('permissions').select('code'),
                db.rpc('get_user_permissions', { p_user_id: session.user.id })
            ]);
            const granted = new Set(ownPerms ? ownPerms.map(p => p.permission_code) : []);
            permissions = (allPerms ? allPerms.map(p => p.code) : [])
                .filter(code => !code.startsWith('fin_') || granted.has(code));
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
            // Финансы отвязаны от superuser: fin_* — только явно выданные права (миграция 201)
            if (permCode && permCode.startsWith('fin_')) {
                return !!window.currentUser?.permissions.includes(permCode);
            }
            return window.currentUser?.is_superuser || window.currentUser?.permissions.includes(permCode);
        };

        // Пользователь только desktop-приложения AB Kitchen не получает доступ
        // к публичному BackOffice даже при наличии кухонных permissions.
        if (!vaishnava.is_superuser) {
            const { data: hasMainAccess, error: mainAccessError } = await db.rpc('has_main_backoffice_access');
            if (mainAccessError || !hasMainAccess) {
                window.location.replace('/guest-portal/');
                return;
            }
        }

        // Проверка доступа: основное приложение или гостевой портал
        // Если у пользователя есть права кроме базовых гостевых — пускаем в основное приложение
        const guestOnlyPerms = new Set(['view_own_profile', 'edit_own_profile', 'view_own_bookings']);
        const isGuestOnly = !vaishnava.is_superuser
            && (permissions.length === 0 || permissions.every(p => guestOnlyPerms.has(p)));

        if (isGuestOnly) {
            const path = window.location.pathname;

            // Гость без доп. прав — только гостевой портал
            if (path.startsWith('/guest-portal/')) {
                // Гостевой портал — разрешаем
            } else {
                // Любая страница основного приложения — редирект в гостевой портал
                window.location.href = '/guest-portal/';
                return;
            }
        }

        debug('✅ User authenticated');
        debug('📋 Permissions loaded:', permissions.length);
        debug('👤 User type:', vaishnava.user_type);

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

        debug('✅ Permissions system ready');

        // Предупреждение об общем пароле — не блокирует загрузку страницы
        checkSharedPassword(db);

        // Отправить событие о готовности авторизации
        window.dispatchEvent(new CustomEvent('authReady', { detail: window.currentUser }));

    } catch (err) {
        console.error('Auth check exception:', err);
        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/login.html?redirect=' + returnUrl;
    }

    // ==================== ОБЩИЙ ПАРОЛЬ ====================
    // Раньше аккаунты создавались с общим паролем. Пока пароль не сменён —
    // при открытии страницы показываем окно с просьбой сменить его, но не чаще
    // раза в 30 минут (решение ВГ 02.10). Временно: убрать вместе с auth_uses_shared_password().
    async function checkSharedPassword(db) {
        const SHARED_PW_INTERVAL_MS = 30 * 60 * 1000;
        try {
            const last = Number(localStorage.getItem('srsk_shared_pw_shown_at')) || 0;
            if (Date.now() - last < SHARED_PW_INTERVAL_MS) return;
        } catch (e) { /* хранилище недоступно — просто покажем окно */ }

        const { data: isShared, error } = await db.rpc('auth_uses_shared_password');
        if (error || !isShared) return;

        try { localStorage.setItem('srsk_shared_pw_shown_at', String(Date.now())); } catch (e) { /* ignore */ }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', showSharedPasswordModal);
        } else {
            showSharedPasswordModal();
        }
    }

    function showSharedPasswordModal() {
        const SHARED_PW_TEXTS = {
            ru: {
                title: 'Смените, пожалуйста, пароль',
                text: 'У вашего аккаунта общий пароль, известный многим людям. Под ним может войти любой, кто знает вашу почту. Скоро общие пароли будут отключены — задайте, пожалуйста, свой.',
                change: 'Сменить пароль сейчас',
                later: 'Напомнить позже'
            },
            en: {
                title: 'Please change your password',
                text: 'Your account uses a shared password known to many people. Anyone who knows your email can sign in as you. Shared passwords will soon be disabled — please set your own.',
                change: 'Change password now',
                later: 'Remind me later'
            },
            hi: {
                title: 'कृपया अपना पासवर्ड बदलें',
                text: 'आपके खाते का पासवर्ड साझा है और कई लोगों को पता है। जो भी आपका ईमेल जानता है, वह आपके नाम से लॉग इन कर सकता है। साझा पासवर्ड जल्द ही बंद कर दिए जाएंगे — कृपया अपना पासवर्ड सेट करें।',
                change: 'अभी पासवर्ड बदलें',
                later: 'बाद में याद दिलाएं'
            }
        };

        let lang = 'ru';
        try { lang = localStorage.getItem('srsk_lang') || 'ru'; } catch (e) { /* ignore */ }
        const tx = SHARED_PW_TEXTS[lang] || SHARED_PW_TEXTS.ru;
        const redirect = encodeURIComponent(window.location.pathname + window.location.search);

        const modal = document.createElement('div');
        modal.className = 'modal modal-open';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
            <div class="modal-box max-w-md text-center">
                <div class="w-14 h-14 rounded-full bg-warning/20 flex items-center justify-center mx-auto mb-4">
                    <svg class="w-8 h-8 text-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
                    </svg>
                </div>
                <h3 class="font-bold text-lg mb-2">${tx.title}</h3>
                <p class="text-sm opacity-80 mb-6">${tx.text}</p>
                <div class="flex flex-col gap-2">
                    <a href="/reset-password/?redirect=${redirect}" class="btn btn-primary">${tx.change}</a>
                    <button type="button" class="btn btn-ghost" data-shared-pw-later>${tx.later}</button>
                </div>
            </div>`;
        modal.querySelector('[data-shared-pw-later]').addEventListener('click', () => modal.remove());
        document.body.appendChild(modal);
    }
})();
