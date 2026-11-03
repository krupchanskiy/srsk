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

    // карточка и права с прошлой страницы: ключ и срок жизни
    const КЛЮЧ_ДОСТУПА = 'srsk_access_v1';
    const ДОСТУП_ЖИВЁТ = 10 * 60 * 1000;

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

        // Свежая проверка уходит сразу. Если есть карточка и права, запомненные
        // на прошлой странице (не старше 10 минут), страница рисуется по ним,
        // не дожидаясь ответа: на мобильной сети этот круг до базы стоил
        // от 0,15 до 1 с на КАЖДОЙ странице. Ответ сверяется с запомненным —
        // если права изменились, страница перезагружается, если доступ
        // отозван — уводим, как и раньше. Данные всё равно охраняет RLS.
        const свежее = загрузитьДоступ(db, session.user.id);
        const запомненное = прочитатьЗапомненное(session.user.id);

        // запомненное — только ускорение: любая его поломка не должна
        // уводить человека на вход, тогда просто идём обычным путём
        let поЗапомненному = false;
        if (запомненное) {
            try { поЗапомненному = await применить(запомненное, session, db) === 'ok'; }
            catch (e) { console.error('Запомненный доступ не применился:', e); забыть(); }
        }

        if (поЗапомненному) {
            завершить(db);
            свежее.then(async д => {
                // сбой сети — не повод выкидывать человека: остаёмся на запомненном
                if (д.ошибкаСети) return;
                if (подпись(д) === подпись(запомненное)) return запомнить(session.user.id, д);
                забыть();
                // что-то изменилось: пусть решает полная проверка — она уведёт,
                // если доступа больше нет, а если есть — перерисуем с новыми правами
                if (await применить(д, session, db) === 'ok') {
                    запомнить(session.user.id, д);
                    window.location.reload();
                }
            }).catch(e => console.error('Фоновая проверка доступа:', e));
            return;
        }

        const д = await свежее;
        if (await применить(д, session, db) !== 'ok') return;
        if (!д.ошибкаСети) запомнить(session.user.id, д);
        завершить(db);

    } catch (err) {
        console.error('Auth check exception:', err);
        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/login.html?redirect=' + returnUrl;
    }

    // ==================== ЗАПОМНЕННЫЙ ДОСТУП ====================
    function прочитатьЗапомненное(uid) {
        try {
            const з = JSON.parse(localStorage.getItem(КЛЮЧ_ДОСТУПА) || 'null');
            if (з && з.uid === uid && Date.now() - з.at < ДОСТУП_ЖИВЁТ) return з.д;
        } catch (e) { /* хранилище недоступно — проверим как обычно */ }
        return null;
    }
    function запомнить(uid, д) {
        try { localStorage.setItem(КЛЮЧ_ДОСТУПА, JSON.stringify({ uid, at: Date.now(), д })); } catch (e) { /* ignore */ }
    }
    function забыть() {
        try { localStorage.removeItem(КЛЮЧ_ДОСТУПА); } catch (e) { /* ignore */ }
    }
    function подпись(д) {
        return JSON.stringify([д.vaishnava, д.userPerms, д.hasMainAccess, д.allPerms]);
    }

    // Карточка, права и доступ к основному приложению зависят только от
    // id пользователя — запрашиваем разом, одним кругом до базы.
    // Список всех прав нужен только суперпользователю, но он крошечный.
    async function загрузитьДоступ(db, uid) {
        const [
            { data: vaishnava, error: vError },
            { data: userPerms, error: permsError },
            { data: hasMainAccess, error: mainAccessError },
            { data: allPerms, error: allError },
        ] = await Promise.all([
            db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name, photo_url, user_type, approval_status, is_superuser, is_active')
                .eq('user_id', uid)
                .eq('is_deleted', false)
                .maybeSingle(),
            db.rpc('get_user_permissions', { p_user_id: uid }),
            db.rpc('has_main_backoffice_access'),
            db.from('permissions').select('code'),
        ]);
        return {
            vaishnava, userPerms, hasMainAccess, allPerms,
            vError, permsError, mainAccessError,
            ошибкаСети: !!(vError || permsError || mainAccessError || allError),
        };
    }

    /**
     * Проверки доступа и window.currentUser — по карточке и правам.
     * 'ok' — можно рисовать страницу; иначе уже идёт уход на вход или в портал.
     */
    async function применить(д, session, db) {
        const { vaishnava, userPerms, hasMainAccess, allPerms, vError, permsError, mainAccessError } = д;

        if (vError || !vaishnava) {
            console.error('Failed to load vaishnava:', vError);
            // Пользователя нет в vaishnavas или RLS скрыла — выход
            await db.auth.signOut();
            const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = '/login.html?redirect=' + returnUrl;
            return 'уход';
        }

        // Проверка статуса одобрения
        if (vaishnava.approval_status === 'pending') {
            window.location.href = '/pending-approval.html';
            return 'уход';
        }

        if (vaishnava.approval_status === 'rejected' || vaishnava.approval_status === 'blocked' || !vaishnava.is_active) {
            await db.auth.signOut();
            // Используем alert т.к. Layout может быть не загружен, и мы уходим на /login.html
            alert('Ваш аккаунт заблокирован или отклонён. Свяжитесь с администратором.');
            window.location.href = '/login.html';
            return 'уход';
        }

        // Загрузить права пользователя одним запросом через SQL функцию
        let permissions = [];

        if (vaishnava.is_superuser) {
            // Суперпользователь - все права, КРОМЕ финансов (fin_* — только явно выданные)
            const granted = new Set(userPerms ? userPerms.map(p => p.permission_code) : []);
            permissions = (allPerms ? allPerms.map(p => p.code) : [])
                .filter(code => !code.startsWith('fin_') || granted.has(code));
        } else {
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
            if (mainAccessError || !hasMainAccess) {
                window.location.replace('/guest-portal/');
                return 'уход';
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
                return 'уход';
            }
        }

        window.debug?.('✅ User authenticated');
        window.debug?.('📋 Permissions loaded:', permissions.length);
        window.debug?.('👤 User type:', vaishnava.user_type);
        return 'ok';
    }

    /** Всё, что делается после успешной проверки: классы, права на элементах, событие. */
    function завершить(db) {
        const vaishnava = window.currentUser;

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

        window.debug?.('✅ Permissions system ready');

        // Отправить событие о готовности авторизации
        window.dispatchEvent(new CustomEvent('authReady', { detail: window.currentUser }));
    }
})();
