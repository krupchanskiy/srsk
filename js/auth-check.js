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

    try {
        // Создаем Supabase клиент
        const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

        // Проверяем текущую сессию
        const { data: { session }, error } = await db.auth.getSession();

        if (error) {
            console.error('Auth check error:', error);
        }

        // Если нет сессии - редирект на логин
        if (!session) {
            localStorage.setItem('srsk_redirect_after_login', window.location.pathname + window.location.search);
            window.location.href = '/login.html';
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
            window.location.href = '/login.html';
            return;
        }

        // Проверка статуса одобрения
        if (vaishnava.approval_status === 'pending') {
            window.location.href = '/pending-approval.html';
            return;
        }

        if (vaishnava.approval_status === 'rejected' || vaishnava.approval_status === 'blocked' || !vaishnava.is_active) {
            await db.auth.signOut();
            alert('Ваш аккаунт заблокирован или отклонён. Свяжитесь с администратором.');
            window.location.href = '/login.html';
            return;
        }

        // Загрузить права пользователя
        let permissions = [];

        if (vaishnava.is_superuser) {
            // Суперпользователь - все права
            const { data: allPerms } = await db
                .from('permissions')
                .select('code');
            permissions = allPerms ? allPerms.map(p => p.code) : [];
        } else {
            // Загрузить права через роли
            const { data: userRoles } = await db
                .from('user_roles')
                .select(`
                    role_id,
                    roles!inner (
                        id,
                        code
                    )
                `)
                .eq('user_id', session.user.id)
                .eq('is_active', true);

            if (userRoles && userRoles.length > 0) {
                const roleIds = userRoles.map(r => r.role_id);
                const { data: rolePerms } = await db
                    .from('role_permissions')
                    .select(`
                        permission_id,
                        permissions!inner (
                            code
                        )
                    `)
                    .in('role_id', roleIds);

                permissions = rolePerms ? rolePerms.map(rp => rp.permissions.code) : [];
            }

            // Загрузить индивидуальные права (переопределения)
            const { data: userPerms } = await db
                .from('user_permissions')
                .select(`
                    is_granted,
                    permissions!inner (
                        code
                    )
                `)
                .eq('user_id', session.user.id);

            if (userPerms) {
                userPerms.forEach(up => {
                    if (up.is_granted) {
                        // Добавить право
                        if (!permissions.includes(up.permissions.code)) {
                            permissions.push(up.permissions.code);
                        }
                    } else {
                        // Убрать право
                        permissions = permissions.filter(p => p !== up.permissions.code);
                    }
                });
            }
        }

        // DEBUG: проверить данные перед созданием currentUser
        console.log('🔍 DEBUG vaishnava.user_type:', vaishnava.user_type);
        console.log('🔍 DEBUG vaishnava.is_superuser:', vaishnava.is_superuser);
        console.log('🔍 DEBUG permissions:', permissions);

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

        // DEBUG: проверить что получилось
        console.log('🔍 DEBUG currentUser.user_type:', window.currentUser.user_type);
        console.log('🔍 DEBUG currentUser.is_superuser:', window.currentUser.is_superuser);
        console.log('🔍 DEBUG currentUser.permissions:', window.currentUser.permissions);

        // Создать глобальную функцию hasPermission()
        window.hasPermission = function(permCode) {
            return window.currentUser?.is_superuser || window.currentUser?.permissions.includes(permCode);
        };

        // Проверка доступа для гостей
        if (vaishnava.user_type === 'guest') {
            const path = window.location.pathname;

            // Гость может ТОЛЬКО на свою страницу профиля
            if (path.endsWith('/vaishnavas/person.html')) {
                const urlParams = new URLSearchParams(window.location.search);
                const personId = urlParams.get('id');
                if (!personId || personId !== vaishnava.id) {
                    // Гость пытается зайти на чужую страницу или без ID
                    window.location.href = `/vaishnavas/person.html?id=${vaishnava.id}`;
                    return;
                }
            } else {
                // Гость на любой другой странице - редирект на свой профиль
                window.location.href = `/vaishnavas/person.html?id=${vaishnava.id}`;
                return;
            }
        }

        console.log('✅ User authenticated:', session.user.email);
        console.log('📋 Permissions loaded:', permissions.length, 'permissions');
        console.log('👤 User type:', vaishnava.user_type, '| Superuser:', vaishnava.is_superuser);

    } catch (err) {
        console.error('Auth check exception:', err);
        window.location.href = '/login.html';
    }
})();
