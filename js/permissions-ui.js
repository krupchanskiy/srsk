// PERMISSIONS-UI.JS
// Автоматическое скрытие UI элементов на основе прав пользователя
// Подключать ПОСЛЕ auth-check.js на каждой странице

(function() {
    'use strict';

    // Функция для проверки и скрытия элементов без нужных прав
    function applyPermissions() {
        // Проверяем что пользователь загружен и hasPermission доступна
        if (!window.currentUser || !window.hasPermission) {
            window.addEventListener('authReady', () => applyPermissions(), { once: true });
            return;
        }

        // Суперпользователи видят всё
        if (window.currentUser.is_superuser) {
            return;
        }

        // Найти все элементы с data-permission
        const elementsWithPermission = document.querySelectorAll('[data-permission]');

        elementsWithPermission.forEach(element => {
            const requiredPermission = element.getAttribute('data-permission');

            // Проверить наличие права
            if (!window.hasPermission(requiredPermission)) {
                // Скрыть элемент (не удаляем, чтобы можно было восстановить)
                element.style.display = 'none';
                // Добавить класс для идентификации
                element.classList.add('permission-hidden');

                // Если это кнопка, дополнительно отключить
                if (element.tagName === 'BUTTON') {
                    element.disabled = true;
                }
            }
        });

        console.log('✅ Permissions UI applied');
    }

    // Применить права при загрузке DOM
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyPermissions);
    } else {
        // DOM уже загружен
        applyPermissions();
    }

    // Экспортировать функцию для ручного применения (например, после динамической загрузки контента)
    window.applyPermissions = applyPermissions;
})();
