// ==================== PORTAL-LAYOUT.JS ====================
// Header, Footer, переводы и общие утилиты для Guest Portal

(function() {
'use strict';

const db = window.portalSupabase;

// Хранилище переводов
let translations = {};
let currentLang = localStorage.getItem('srsk_lang') || 'ru';

// Навигация портала
const NAV_ITEMS = [
    { id: 'dashboard', href: 'index.html', icon: 'home', key: 'portal_nav_dashboard' },
    { id: 'profile', href: 'profile.html', icon: 'user', key: 'portal_nav_profile' },
    { id: 'retreats', href: 'retreats.html', icon: 'calendar', key: 'portal_nav_retreats' },
    { id: 'materials', href: 'materials.html', icon: 'book-open', key: 'portal_nav_materials' },
    { id: 'contacts', href: 'contacts.html', icon: 'phone', key: 'portal_nav_contacts' }
];

/**
 * Инициализация Layout
 * @param {object} options - { activeNav: 'dashboard' }
 */
async function init(options = {}) {
    // Загружаем переводы
    await loadTranslations();

    // Рендерим header и footer
    renderHeader(options.activeNav);
    renderFooter();

    // Обновляем все переводы
    updateAllTranslations();

    // Инициализируем переключатель языка
    initLanguageSwitcher();

    return true;
}

/**
 * Загрузка переводов из БД
 */
async function loadTranslations() {
    try {
        // Пробуем из localStorage кэша
        const cached = localStorage.getItem('portal_translations');
        const cacheTime = localStorage.getItem('portal_translations_time');

        // Кэш валиден 1 час
        if (cached && cacheTime && (Date.now() - parseInt(cacheTime)) < 3600000) {
            translations = JSON.parse(cached);
            return;
        }

        // Загружаем из БД
        const { data, error } = await db
            .from('translations')
            .select('key, ru, en, hi');

        if (error) {
            console.error('Ошибка загрузки переводов:', error);
            return;
        }

        // Преобразуем в объект
        translations = {};
        for (const row of data) {
            translations[row.key] = {
                ru: row.ru,
                en: row.en,
                hi: row.hi
            };
        }

        // Сохраняем в кэш
        localStorage.setItem('portal_translations', JSON.stringify(translations));
        localStorage.setItem('portal_translations_time', Date.now().toString());

    } catch (error) {
        console.error('Ошибка загрузки переводов:', error);
    }
}

/**
 * Получить перевод по ключу
 * @param {string} key
 * @param {string} lang - Опционально, по умолчанию currentLang
 * @returns {string}
 */
function t(key, lang) {
    lang = lang || currentLang;

    if (!translations[key]) {
        console.warn('Перевод не найден:', key);
        return key;
    }

    // Fallback: запрошенный язык → en → ru
    return translations[key][lang] ||
           translations[key]['en'] ||
           translations[key]['ru'] ||
           key;
}

/**
 * Обновить все элементы с data-i18n
 */
function updateAllTranslations() {
    // Текстовое содержимое
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        el.textContent = t(key);
    });

    // Placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        el.placeholder = t(key);
    });

    // Title атрибут
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.dataset.i18nTitle;
        el.title = t(key);
    });
}

/**
 * Установить язык
 * @param {string} lang - 'ru', 'en', 'hi'
 */
function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('srsk_lang', lang);
    document.documentElement.lang = lang;
    updateAllTranslations();

    // Обновляем кнопки языка
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === lang);
    });
}

/**
 * Получить текущий язык
 * @returns {string}
 */
function getLang() {
    return currentLang;
}

/**
 * Рендер Header
 * @param {string} activeNav - Активный пункт навигации
 */
function renderHeader(activeNav) {
    const header = document.getElementById('header-placeholder');
    if (!header) return;

    const guest = window.currentGuest;
    const guestName = guest ? (guest.spiritualName || guest.firstName || 'Гость') : '';
    const guestPhoto = guest?.photoUrl || '';

    header.innerHTML = `
        <header class="bg-white shadow-sm sticky top-0 z-50">
            <div class="container mx-auto px-4">
                <!-- Верхняя строка: логотип и профиль -->
                <div class="flex items-center justify-between h-16">
                    <!-- Логотип -->
                    <a href="index.html" class="flex items-center gap-3">
                        <div class="w-10 h-10 bg-srsk-green rounded-full flex items-center justify-center">
                            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
                            </svg>
                        </div>
                        <span class="text-xl font-semibold text-gray-800">Rupa Seva</span>
                    </a>

                    <!-- Правая часть: язык + профиль -->
                    <div class="flex items-center gap-4">
                        <!-- Переключатель языка -->
                        <div class="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                            <button class="lang-btn px-2 py-1 text-sm rounded ${currentLang === 'ru' ? 'bg-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}" data-lang="ru">RU</button>
                            <button class="lang-btn px-2 py-1 text-sm rounded ${currentLang === 'en' ? 'bg-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}" data-lang="en">EN</button>
                            <button class="lang-btn px-2 py-1 text-sm rounded ${currentLang === 'hi' ? 'bg-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-700'}" data-lang="hi">HI</button>
                        </div>

                        <!-- Профиль -->
                        ${guest ? `
                        <div class="relative" id="profile-dropdown">
                            <button class="flex items-center gap-2 hover:bg-gray-100 rounded-lg px-2 py-1" onclick="toggleProfileDropdown()">
                                ${guestPhoto
                                    ? `<img src="${escapeHtml(guestPhoto)}" alt="" class="w-8 h-8 rounded-full object-cover">`
                                    : `<div class="w-8 h-8 rounded-full bg-srsk-green text-white flex items-center justify-center text-sm font-medium">${getInitials(guestName)}</div>`
                                }
                                <span class="text-sm font-medium text-gray-700 hidden sm:block">${escapeHtml(guestName)}</span>
                                <svg class="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                                </svg>
                            </button>
                            <div id="profile-menu" class="hidden absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg py-1 border">
                                <a href="profile.html" class="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
                                    </svg>
                                    <span data-i18n="portal_my_profile">Мой профиль</span>
                                </a>
                                ${guest.isStaff ? `
                                <hr class="my-1">
                                <a href="materials-admin.html" class="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
                                    </svg>
                                    <span data-i18n="portal_materials_admin">Управление материалами</span>
                                </a>
                                ` : ''}
                                <hr class="my-1">
                                <button onclick="PortalAuth.logout()" class="flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-gray-100 w-full text-left">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                                    </svg>
                                    <span data-i18n="portal_logout">Выход</span>
                                </button>
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </div>

                <!-- Навигация -->
                <nav class="flex items-center gap-1 -mb-px overflow-x-auto pb-px">
                    ${NAV_ITEMS.map(item => `
                        <a href="${item.href}"
                           class="flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors
                                  ${activeNav === item.id
                                      ? 'border-srsk-green text-srsk-green'
                                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}">
                            ${getNavIcon(item.icon)}
                            <span data-i18n="${item.key}">${t(item.key)}</span>
                        </a>
                    `).join('')}
                </nav>
            </div>
        </header>
    `;
}

/**
 * Рендер Footer
 */
function renderFooter() {
    const footer = document.getElementById('footer-placeholder');
    if (!footer) return;

    footer.innerHTML = `
        <footer class="bg-white border-t mt-auto">
            <div class="container mx-auto px-4 py-6">
                <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
                    <div class="text-sm text-gray-500">
                        &copy; ${new Date().getFullYear()} Rupa Seva Ashram
                    </div>
                    <div class="flex items-center gap-4">
                        <a href="contacts.html" class="text-sm text-gray-500 hover:text-srsk-green" data-i18n="portal_nav_contacts">Контакты</a>
                        <a href="materials.html" class="text-sm text-gray-500 hover:text-srsk-green" data-i18n="portal_nav_materials">Материалы</a>
                    </div>
                </div>
            </div>
        </footer>
    `;
}

/**
 * Инициализация переключателя языка
 */
function initLanguageSwitcher() {
    document.addEventListener('click', (e) => {
        const langBtn = e.target.closest('.lang-btn');
        if (langBtn) {
            setLanguage(langBtn.dataset.lang);
        }
    });
}

/**
 * Получить SVG иконку навигации
 */
function getNavIcon(name) {
    const icons = {
        'home': '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>',
        'user': '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
        'calendar': '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
        'book-open': '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>',
        'phone': '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>'
    };
    return icons[name] || '';
}

/**
 * Получить инициалы из имени
 */
function getInitials(name) {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.substring(0, 2).toUpperCase();
}

/**
 * Экранирование HTML
 */
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Показать уведомление
 * @param {string} message
 * @param {string} type - 'success', 'error', 'warning', 'info'
 */
function showNotification(message, type = 'info') {
    const colors = {
        success: 'bg-green-500',
        error: 'bg-red-500',
        warning: 'bg-yellow-500',
        info: 'bg-blue-500'
    };

    const toast = document.createElement('div');
    toast.className = `fixed bottom-4 right-4 ${colors[type]} text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-slide-up`;
    toast.textContent = message;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('animate-fade-out');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Показать loader
 */
function showLoader() {
    let loader = document.getElementById('portal-loader');
    if (!loader) {
        loader = document.createElement('div');
        loader.id = 'portal-loader';
        loader.className = 'fixed inset-0 bg-white/80 flex items-center justify-center z-50';
        loader.innerHTML = `
            <div class="flex flex-col items-center gap-3">
                <div class="w-10 h-10 border-4 border-srsk-green border-t-transparent rounded-full animate-spin"></div>
                <span class="text-gray-600" data-i18n="loading">Загрузка...</span>
            </div>
        `;
        document.body.appendChild(loader);
    }
    loader.classList.remove('hidden');
}

/**
 * Скрыть loader
 */
function hideLoader() {
    const loader = document.getElementById('portal-loader');
    if (loader) {
        loader.classList.add('hidden');
    }
}

/**
 * Форматирование даты
 * @param {string} dateStr - ISO дата
 * @param {object} options - Intl.DateTimeFormat options
 */
function formatDate(dateStr, options = {}) {
    if (!dateStr) return '';

    const date = DateUtils.parseDate(dateStr);
    const locale = currentLang === 'ru' ? 'ru-RU' : currentLang === 'hi' ? 'hi-IN' : 'en-US';

    const defaultOptions = {
        day: 'numeric',
        month: 'long',
        ...options
    };

    return date.toLocaleDateString(locale, defaultOptions);
}

/**
 * Форматирование диапазона дат
 */
function formatDateRange(startDate, endDate) {
    if (!startDate || !endDate) return '';

    const start = DateUtils.parseDate(startDate);
    const end = DateUtils.parseDate(endDate);
    const locale = currentLang === 'ru' ? 'ru-RU' : currentLang === 'hi' ? 'hi-IN' : 'en-US';

    // Если один месяц
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
        return `${start.getDate()}–${end.getDate()} ${start.toLocaleDateString(locale, { month: 'long', year: 'numeric' })}`;
    }

    // Разные месяцы
    return `${start.toLocaleDateString(locale, { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * Получить локализованное имя объекта
 */
function getName(item, lang) {
    lang = lang || currentLang;
    const key = `name_${lang}`;
    return item[key] || item.name_en || item.name_ru || '';
}

/**
 * Toggle dropdown профиля
 */
window.toggleProfileDropdown = function() {
    const menu = document.getElementById('profile-menu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
};

// Закрытие dropdown при клике вне
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('profile-dropdown');
    const menu = document.getElementById('profile-menu');
    if (dropdown && menu && !dropdown.contains(e.target)) {
        menu.classList.add('hidden');
    }
});

// Экспорт
window.PortalLayout = {
    init,
    t,
    getLang,
    setLanguage,
    updateAllTranslations,
    showNotification,
    showLoader,
    hideLoader,
    formatDate,
    formatDateRange,
    getName,
    escapeHtml,
    db
};

})();
