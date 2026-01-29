// ==================== LAYOUT.JS ====================
// Общие компоненты: хедер, футер, меню, локации, модули

(function() {
'use strict';

// ==================== CONFIG ====================
// Используем централизованный CONFIG из config.js
const db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const DESKTOP_BP = 1200;

// ==================== MODULES ====================
const modules = {
    kitchen: {
        id: 'kitchen',
        nameKey: 'module_kitchen',
        icon: '🍳',
        hasLocations: true,
        defaultLocation: 'main',
        defaultPage: 'kitchen/menu.html',
        menuConfig: [
            { id: 'kitchen', items: [
                { id: 'menu', href: 'kitchen/menu.html' },
                { id: 'menu_templates', href: 'kitchen/menu-templates.html' },
                { id: 'recipes', href: 'kitchen/recipes.html' },
                { id: 'products', href: 'kitchen/products.html' }
            ]},
            { id: 'stock', items: [
                { id: 'stock_balance', href: 'stock/stock.html' },
                { id: 'requests', href: 'stock/requests.html' },
                { id: 'receive', href: 'stock/receive.html' },
                { id: 'issue', href: 'stock/issue.html' },
                { id: 'inventory', href: 'stock/inventory.html' },
                { id: 'stock_settings', href: 'stock/stock-settings.html' }
            ]},
            { id: 'ashram', items: [
                { id: 'retreats', href: 'ashram/retreats.html' },
                { id: 'vaishnavas_team', href: 'vaishnavas/team.html' }
            ]},
            { id: 'settings', items: [
                { id: 'dictionaries', href: 'kitchen/dictionaries.html' },
                { id: 'translations', href: 'settings/translations.html' },
                { id: 'festivals', href: 'ashram/festivals.html' }
            ]}
        ]
    },
    housing: {
        id: 'housing',
        nameKey: 'module_housing',
        icon: '🏠',
        hasLocations: false,
        defaultPage: 'placement/timeline.html',
        menuConfig: [
            { id: 'vaishnavas', items: [
                { id: 'vaishnavas_all', href: 'vaishnavas/index.html' },
                { id: 'vaishnavas_guests', href: 'vaishnavas/guests.html' },
                { id: 'vaishnavas_team', href: 'vaishnavas/team.html' }
            ]},
            { id: 'placement', items: [
                { id: 'retreat_guests', href: 'vaishnavas/retreat-guests.html' },
                { id: 'preliminary', href: 'vaishnavas/preliminary.html' },
                { id: 'arrivals', href: 'placement/arrivals.html' },
                { id: 'transfers', href: 'placement/transfers.html' }
            ]},
            { id: 'reception', items: [
                { id: 'timeline', href: 'placement/timeline.html' },
                { id: 'bookings', href: 'placement/bookings.html' },
                { id: 'cleaning', href: 'reception/cleaning.html' }
            ]},
            { id: 'ashram', items: [
                { id: 'retreats', href: 'ashram/retreats.html' },
                { id: 'festivals', href: 'ashram/festivals.html' }
            ]},
            { id: 'settings', items: [
                { id: 'buildings', href: 'reception/buildings.html' },
                { id: 'rooms', href: 'reception/rooms.html' },
                { id: 'housing_dictionaries', href: 'reception/dictionaries.html' }
            ]}
        ]
    }
};

// ==================== STATE ====================
let currentModule = localStorage.getItem('srsk_module') || 'kitchen';
let currentLang = localStorage.getItem('srsk_lang') || 'ru';
let currentLocation = localStorage.getItem('srsk_location') || 'main';
let locations = [];
let translations = {}; // { key: { ru: '...', en: '...', hi: '...' } }

// Текущая страница (задаётся при инициализации)
let currentPage = { menuId: 'kitchen', itemId: null };

// Получить текущий menuConfig
function getMenuConfig() {
    return modules[currentModule]?.menuConfig || modules.kitchen.menuConfig;
}

// Список всех подпапок модулей
const MODULE_FOLDERS = ['kitchen', 'stock', 'ashram', 'vaishnavas', 'placement', 'reception', 'settings'];

// Определить текущую подпапку (если есть)
function getCurrentFolder() {
    const path = window.location.pathname;
    for (const folder of MODULE_FOLDERS) {
        if (path.includes('/' + folder + '/')) return folder;
    }
    return null;
}

// Определить базовый путь (находимся ли в подпапке)
function getBasePath() {
    return getCurrentFolder() ? '../' : '';
}

// Корректировать href с учётом текущего расположения
function adjustHref(href) {
    const currentFolder = getCurrentFolder();

    // Если мы в корне - ничего не меняем
    if (!currentFolder) return href;

    // Определить папку назначения из href
    const targetFolder = MODULE_FOLDERS.find(f => href.startsWith(f + '/'));

    // Если href ведёт в ту же папку где мы - убираем префикс папки
    if (targetFolder === currentFolder) {
        return href.replace(targetFolder + '/', '');
    }

    // Если href ведёт в другую папку или корень - добавляем ../
    if (!href.startsWith('../') && !href.startsWith('http')) {
        return '../' + href;
    }

    return href;
}

// ==================== HELPERS ====================
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => ctx.querySelectorAll(sel);
const setColor = color => document.documentElement.style.setProperty('--current-color', color);

// ==================== DELEGATING WRAPPERS ====================
// Делегирование к Utils (из utils.js)
function pluralize(n, forms) {
    return Utils.pluralize(n, forms, currentLang);
}

function debounce(fn, delay) {
    return Utils.debounce(fn, delay);
}

function escapeHtml(str) {
    return Utils.escapeHtml(str);
}

// Делегирование к Translit (из translit.js)
function transliterate(text) {
    return Translit.ru(text);
}

function transliterateHindi(hindi) {
    return Translit.hi(hindi);
}

// Делегирование к AutoTranslate (из auto-translate.js)
function translate(text, from, to) {
    return AutoTranslate.translate(text, from, to);
}

function setupAutoTranslate(formSelector, fieldPrefixes) {
    return AutoTranslate.setup(formSelector, fieldPrefixes);
}

function resetAutoTranslate() {
    return AutoTranslate.reset();
}

// ==================== LOADER ====================
let loaderElement = null;

function showLoader() {
    if (loaderElement) return;

    loaderElement = document.createElement('div');
    loaderElement.id = 'page-loader';
    loaderElement.innerHTML = `
        <div class="fixed inset-0 bg-base-200/80 flex items-center justify-center z-40">
            <span class="loading loading-spinner loading-lg" style="color: var(--current-color);"></span>
        </div>
    `;
    document.body.appendChild(loaderElement);
}

function hideLoader() {
    if (!loaderElement) return;
    loaderElement.remove();
    loaderElement = null;
}

/** Получить локализованное имя объекта (name_ru, name_en, name_hi) */
function getName(item, lang = currentLang) {
    if (!item) return '';
    const name = item[`name_${lang}`];
    if (name) return name;
    // Fallback: хинди → английский → русский
    if (lang === 'hi') return item.name_en || item.name_ru || '';
    // Fallback: английский → русский
    return item.name_ru || '';
}

/** Имя человека с автотранслитерацией для не-русского языка */
function getPersonName(person, lang = currentLang) {
    if (!person) return '—';
    const name = person.spiritual_name || person.first_name || '';
    return lang === 'ru' ? name : transliterate(name);
}

// ==================== TRANSLATIONS ====================
async function loadTranslations() {
    const data = await Cache.getOrLoad('translations', async () => {
        const { data, error } = await db.from('translations').select('key, ru, en, hi');
        if (error) {
            console.error('Error loading translations:', error);
            return null;
        }
        return data;
    });

    if (!data) return;

    // Проверка на наличие новых переводов (для автоинвалидации устаревшего кэша)
    const requiredKeys = ['self_accommodation'];
    const hasAllKeys = requiredKeys.every(key => data.some(row => row.key === key));

    if (!hasAllKeys) {
        // Кэш устарел, инвалидируем и перезагружаем
        Cache.invalidate('translations');
        return loadTranslations();
    }

    // Преобразуем массив в объект { key: { ru, en, hi } }
    translations = {};
    data.forEach(row => {
        translations[row.key] = { ru: row.ru, en: row.en, hi: row.hi };
    });
}

function t(key, lang = currentLang) {
    const tr = translations[key];
    if (!tr) return key; // Возвращаем ключ если перевод не найден
    const val = tr[lang];
    if (val) return val;
    // Fallback: хинди → английский → русский
    if (lang === 'hi') return tr.en || tr.ru || key;
    // Fallback: английский → русский
    return tr.ru || key;
}

// Обновление всех элементов с data-i18n на странице
function updateAllTranslations() {
    $$('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const val = t(key);
        if (val !== key) el.textContent = val;
    });

    $$('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        const val = t(key);
        if (val !== key) el.placeholder = val;
    });
}

// ==================== HEADER HTML ====================
function getHeaderHTML() {
    const menuConfig = getMenuConfig();

    return `
    <header class="bg-base-100 shadow-sm sticky top-0 z-50">
        <div class="container mx-auto px-4">
            <div class="flex items-center justify-between h-20">

                <!-- Logo + Location/Module Selector -->
                <div class="flex items-center gap-3 flex-shrink-0">
                    <a href="${adjustHref('index.html')}" class="hover:opacity-80 transition-opacity">
                        <svg class="h-14 w-auto logo-svg" viewBox="0 0 122.03 312.54" xmlns="http://www.w3.org/2000/svg">
                            <path fill="var(--current-color)" d="M102,15.99h-15.18v81.89c0,6.21.12,11.58-.88,15.98-1.01,4.45-2.6,7.98-4.77,10.58-2.02,2.81-4.85,4.83-8.51,6.05-2.38,1-5.08,1.62-8.1,1.83-1.01.21-2.02.32-3.02.32h-.64c-3.81-.21-7.23-.83-10.25-1.83-3.81-1.22-7.02-3.13-9.62-5.73-2.65-2.81-4.56-6.44-5.73-10.89-1.22-4.4-1.83-9.83-1.83-16.3V15.99h-15.1v89.12c0,13.68,3.81,23.94,11.45,30.77,3.81,3.44,8.56,5.96,14.23,7.55,1.17.42,2.57.74,4.21.96-13.89,5.03-23.35,11.87-28.38,20.51-7.05,10.65-7.26,24.14-.64,40.46l41.34,100.45,39.91-100.45c6.41-16.32,6.2-29.82-.64-40.46-4.82-8.48-13.97-15.21-27.43-20.2,1.59-.43,3.18-.85,4.77-1.27,5.25-1.59,9.67-4.19,13.27-7.79,3.82-3.66,6.65-8.18,8.51-13.59,2.02-5.62,3.02-12.27,3.02-19.95V15.99M87.45,172.46c4.03,7.26,3.84,16.4-.56,27.43l-26.31,68.13-27.75-68.13c-4.61-11.03-4.8-20.17-.55-27.43,4.61-7.47,13.76-13.01,27.43-16.62,13.67,3.61,22.93,9.15,27.75,16.62"/>
                        </svg>
                    </a>

                    <!-- Desktop: full name + selector -->
                    <div class="hidden md:flex flex-col">
                        <a href="${adjustHref('index.html')}" class="text-xl font-semibold whitespace-nowrap hover:opacity-80 transition-opacity" data-i18n="app_name">Шри Рупа Сева Кунджа</a>
                        <div class="relative location-selector" id="locationDesktop">
                            <button class="flex items-center justify-between gap-2 w-full text-xl opacity-70 hover:opacity-100 transition-opacity" data-toggle="location">
                                <span class="location-name">${currentModule === 'housing' ? t('module_housing') : ''}</span>
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 transition-transform location-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                            </button>
                            <div class="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg py-1 w-full hidden z-50 location-dropdown"></div>
                        </div>
                    </div>

                    <!-- Mobile: короткое название + selector -->
                    <div class="flex items-center gap-2 md:hidden">
                        <span class="text-xl font-semibold whitespace-nowrap" data-i18n="app_name_short">ШРСК</span>
                        <span class="text-xl opacity-50">·</span>
                        <div class="relative location-selector" id="locationMobile">
                            <button class="flex items-center gap-1 text-xl opacity-70" data-toggle="location">
                                <span class="location-name">${currentModule === 'housing' ? t('module_housing') : ''}</span>
                                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 transition-transform location-arrow" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                                </svg>
                            </button>
                            <div class="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg py-1 min-w-44 hidden z-50 location-dropdown"></div>
                        </div>
                    </div>
                </div>

                <!-- Desktop Navigation -->
                <nav class="hidden desktop:flex items-center gap-2" id="mainNav">
                    ${menuConfig.map(({ id, items }) => {
                        // Single-item menu: direct link without submenu
                        if (items.length === 1) {
                            return `<a href="${adjustHref(items[0].href)}" class="nav-link px-5 py-6 text-base font-semibold tracking-wide uppercase ${id === currentPage.menuId ? 'active' : 'opacity-60'}" data-menu-id="${id}">${t('nav_' + id)}</a>`;
                        }
                        // Multi-item menu: submenu trigger
                        return `<a href="#" class="nav-link px-5 py-6 text-base font-semibold tracking-wide uppercase ${id === currentPage.menuId ? 'active' : 'opacity-60'}" data-submenu="${id}" data-menu-id="${id}">${t('nav_' + id)}</a>`;
                    }).join('')}
                </nav>

                <!-- Right: Language, User, Mobile Menu Button -->
                <div class="flex items-center gap-3 sm:gap-5">
                    <div class="hidden md:flex join">
                        <button class="join-item btn btn-sm lang-btn ${currentLang === 'ru' ? 'active' : ''}" data-lang="ru">RU</button>
                        <button class="join-item btn btn-sm lang-btn ${currentLang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
                        <button class="join-item btn btn-sm lang-btn ${currentLang === 'hi' ? 'active' : ''}" data-lang="hi">HI</button>
                    </div>
                    <div class="hidden desktop:block">
                        <div class="w-10 h-10 rounded-full overflow-hidden ring-2 ring-base-200">
                            <img src="https://i.pravatar.cc/150?img=5" alt="User" class="w-full h-full object-cover" />
                        </div>
                    </div>
                    <button class="btn btn-ghost btn-md btn-square desktop:hidden" id="mobileMenuBtn">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7 menu-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7 close-icon hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
            </div>

            <!-- Mobile Menu -->
            <div class="mobile-menu desktop:hidden border-t border-base-200" id="mobileMenu">
                <nav class="py-3 space-y-0" id="mobileNav"></nav>
                <div class="border-t border-base-200 py-4 px-4">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-full overflow-hidden ring-2 ring-base-200">
                                <img src="https://i.pravatar.cc/150?img=5" alt="User" class="w-full h-full object-cover" />
                            </div>
                            <!-- TODO: заменить на данные из auth -->
                            <span class="font-medium" id="userName">Ганга деви даси</span>
                        </div>
                        <div class="md:hidden join">
                            <button class="join-item btn btn-sm lang-btn ${currentLang === 'ru' ? 'active' : ''}" data-lang="ru">RU</button>
                            <button class="join-item btn btn-sm lang-btn ${currentLang === 'en' ? 'active' : ''}" data-lang="en">EN</button>
                            <button class="join-item btn btn-sm lang-btn ${currentLang === 'hi' ? 'active' : ''}" data-lang="hi">HI</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Submenu Bar (Desktop) -->
        <div class="-mt-1" id="submenuBar"></div>
    </header>`;
}

// ==================== FOOTER HTML ====================
function getFooterHTML() {
    const menuConfig = getMenuConfig();
    // Собираем ссылки из текущего раздела меню (второй уровень)
    const currentMenu = menuConfig.find(m => m.id === currentPage.menuId);
    const footerLinks = currentMenu ? currentMenu.items : menuConfig[0].items;

    return `
    <footer class="bg-base-100 border-t border-base-200 mt-auto">
        <div class="container mx-auto px-4 py-6">
            <!-- Первый уровень меню -->
            <nav class="flex flex-wrap justify-center gap-4 sm:gap-6 mb-3" id="footerMainNav">
                ${menuConfig.map(menu => `
                    <a href="${adjustHref(menu.items[0].href)}" class="text-sm font-bold uppercase tracking-wide ${menu.id === currentPage.menuId ? 'text-primary' : 'opacity-60 hover:opacity-100'}" data-menu-id="${menu.id}">${t('nav_' + menu.id)}</a>
                `).join('')}
            </nav>

            <!-- Второй уровень меню (только если больше одного пункта) -->
            ${footerLinks.length > 1 ? `
            <nav class="flex flex-wrap justify-center gap-4 sm:gap-6 mb-4" id="footerNav">
                ${footerLinks.map(item => `
                    <a href="${adjustHref(item.href)}" class="text-sm font-medium uppercase tracking-wide ${item.id === currentPage.itemId ? 'text-primary' : 'opacity-60 hover:opacity-100'}">${t('nav_' + item.id)}</a>
                `).join('')}
            </nav>
            ` : '<div id="footerNav"></div>'}

            <!-- Кнопка наверх -->
            <div class="flex justify-center">
                <button onclick="window.scrollTo({top: 0, behavior: 'smooth'})" class="btn btn-ghost btn-sm gap-1 opacity-60 hover:opacity-100">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7" />
                    </svg>
                    <span data-i18n="back_to_top">${t('back_to_top')}</span>
                </button>
            </div>

            <div class="text-center mt-4 text-xs opacity-40" id="footerMotto">${currentLang === 'ru' ? 'ниджа-никат̣а-нива̄сам̇ дехи говардхана твам' : 'nija-nikaṭa-nivāsaṁ dehi govardhana tvam'}</div>
        </div>
    </footer>

    <!-- Photo Modal -->
    <dialog id="photoModal" class="modal">
        <div class="modal-box max-w-3xl p-0">
            <button class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2 z-10 bg-base-100/80" onclick="document.getElementById('photoModal').close()">✕</button>
            <img id="photoModalImage" src="" alt="" class="w-full h-auto rounded-lg">
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>`;
}

// ==================== HEADER FUNCTIONS ====================
function buildLocationOptions() {
    const isHousing = currentModule === 'housing';

    $$('.location-dropdown').forEach(el => {
        // Очищаем содержимое
        el.replaceChildren();

        // Добавляем локации (кухни)
        locations.forEach(loc => {
            const button = document.createElement('button');
            button.className = 'w-full text-left px-4 py-2 hover:bg-base-200 text-base-content';
            if (!isHousing && loc.slug === currentLocation) {
                button.classList.add('font-medium');
            }
            button.dataset.loc = loc.slug;
            button.textContent = getName(loc); // безопасно
            el.appendChild(button);
        });

        // Разделитель
        const divider = document.createElement('div');
        divider.className = 'border-t border-base-200 my-1';
        el.appendChild(divider);

        // Кнопка "Проживание"
        const housingBtn = document.createElement('button');
        housingBtn.className = 'w-full text-left px-4 py-2 hover:bg-base-200 text-base-content';
        if (isHousing) {
            housingBtn.classList.add('font-medium');
        }
        housingBtn.dataset.module = 'housing';
        housingBtn.textContent = t('module_housing'); // безопасно
        el.appendChild(housingBtn);
    });
}

function buildMobileMenu() {
    const nav = $('#mobileNav');
    if (!nav) return;
    const menuConfig = getMenuConfig();

    nav.innerHTML = menuConfig.map(({ id, items }) => {
        // Single-item menu: direct link
        if (items.length === 1) {
            return `
                <div class="mobile-nav-item">
                    <a href="${adjustHref(items[0].href)}" class="block px-4 py-3 text-base font-semibold uppercase tracking-wide hover:bg-base-200 rounded-lg ${id === currentPage.menuId ? 'text-primary' : ''}">${t('nav_' + id)}</a>
                </div>
            `;
        }
        // Multi-item menu: accordion
        return `
            <div class="mobile-nav-item ${id === currentPage.menuId ? 'open' : ''}" data-has-submenu>
                <button class="w-full flex items-center px-4 py-3 text-base font-semibold uppercase tracking-wide hover:bg-base-200 rounded-lg">
                    ${t('nav_' + id)}
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 ml-2 transition-transform arrow-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </button>
                <div class="submenu pl-4">
                    ${items.map(item => `<a href="${adjustHref(item.href)}" class="block px-4 py-3 text-base font-medium rounded-lg hover:bg-base-200 ${item.id === currentPage.itemId ? 'text-primary' : ''}">${t('nav_' + item.id)}</a>`).join('')}
                </div>
            </div>
        `;
    }).join('');

    $$('.mobile-nav-item[data-has-submenu] button', nav).forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.mobile-nav-item');
            const wasOpen = item.classList.contains('open');
            $$('.mobile-nav-item.open', nav).forEach(i => i.classList.remove('open'));
            if (!wasOpen) item.classList.add('open');
        });
    });
}

function buildSubmenuBar() {
    const bar = $('#submenuBar');
    if (!bar) return;
    const menuConfig = getMenuConfig();

    bar.innerHTML = menuConfig.map(({ id, items }) => {
        // Don't render submenu for single-item menus
        if (items.length === 1) return '';
        return `
            <nav class="container mx-auto px-4 flex items-center submenu-group ${id !== currentPage.menuId ? 'hidden' : ''}" data-group="${id}">
                ${items.map(item => `<a href="${adjustHref(item.href)}" class="submenu-link px-5 py-2 text-base font-semibold tracking-wide uppercase ${item.id === currentPage.itemId ? 'active' : 'text-white/70 hover:text-white'}">${t('nav_' + item.id)}</a>`).join('')}
            </nav>
        `;
    }).join('');

    initSubmenuMargins();

    // Пересчитать после загрузки шрифтов (кэш может вернуть данные до загрузки шрифтов)
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => initSubmenuMargins());
    }
}

// ==================== LANGUAGE UPDATE ====================
function updateHeaderLanguage() {
    // Обновляем все элементы с data-i18n (включая app_name)
    updateAllTranslations();

    // Обновляем главное меню (используем ключи nav_kitchen, nav_stock, etc.)
    $$('.nav-link[data-menu-id]').forEach(link => {
        const menuId = link.dataset.menuId;
        const key = `nav_${menuId}`;
        link.textContent = t(key);
    });

    // Обновляем название в селекторе
    if (currentModule === 'housing') {
        $$('.location-name').forEach(el => el.textContent = t('module_housing'));
    } else {
        const loc = locations.find(l => l.slug === currentLocation);
        if (loc) {
            $$('.location-name').forEach(el => el.textContent = getName(loc));
        }
    }

    // Обновляем выпадашку локаций
    buildLocationOptions();
}

function updateFooterLanguage() {
    const menuConfig = getMenuConfig();

    // Обновляем первый уровень меню
    const footerMainNav = $('#footerMainNav');
    if (footerMainNav) {
        footerMainNav.innerHTML = menuConfig.map(menu => `
            <a href="${adjustHref(menu.items[0].href)}" class="text-sm font-bold uppercase tracking-wide ${menu.id === currentPage.menuId ? 'text-primary' : 'opacity-60 hover:opacity-100'}" data-menu-id="${menu.id}">${t('nav_' + menu.id)}</a>
        `).join('');
    }

    // Обновляем второй уровень меню (только если больше одного пункта)
    const footerNav = $('#footerNav');
    if (footerNav) {
        const currentMenu = menuConfig.find(m => m.id === currentPage.menuId);
        const footerLinks = currentMenu ? currentMenu.items : menuConfig[0].items;

        // Показываем только если больше одного пункта
        if (footerLinks.length > 1) {
            footerNav.innerHTML = footerLinks.map(item => {
                const key = `nav_${item.id}`;
                return `<a href="${adjustHref(item.href)}" class="text-sm font-medium uppercase tracking-wide ${item.id === currentPage.itemId ? 'text-primary' : 'opacity-60 hover:opacity-100'}">${t(key)}</a>`;
            }).join('');
        } else {
            footerNav.innerHTML = '';
        }
    }

    // Обновляем девиз
    const footerMotto = $('#footerMotto');
    if (footerMotto) {
        footerMotto.textContent = currentLang === 'ru'
            ? 'ниджа-никат̣а-нива̄сам̇ дехи говардхана твам'
            : 'nija-nikaṭa-nivāsaṁ dehi govardhana tvam';
    }
}

// ==================== SUBMENU ALIGNMENT ====================
const submenuMargins = {};

function calcSubmenuMargin(groupId) {
    // Берём первый пункт меню текущего модуля для выравнивания
    const menuConfig = getMenuConfig();
    const firstMenuId = menuConfig[0]?.id || 'kitchen';
    const firstNavLink = $(`.nav-link[data-submenu="${firstMenuId}"]`);
    const submenuBar = $('#submenuBar');
    const group = $(`.submenu-group[data-group="${groupId}"]`);
    if (!firstNavLink || !submenuBar || !group) return 0;

    const firstLink = group.querySelector('.submenu-link');
    if (!firstLink) return 0;

    const wasHidden = group.classList.contains('hidden');
    group.classList.remove('hidden');
    firstLink.style.transition = 'none';
    firstLink.style.marginLeft = '0';
    // Force reflow — нужно чтобы браузер применил стили до измерения позиции
    void firstLink.offsetWidth;

    const navRect = firstNavLink.getBoundingClientRect();
    const barRect = submenuBar.getBoundingClientRect();
    const linkRect = firstLink.getBoundingClientRect();

    const kitchenCenterX = navRect.left + navRect.width / 2 - barRect.left;
    const linkLeftRelative = linkRect.left - barRect.left;
    const margin = kitchenCenterX - linkLeftRelative - linkRect.width / 2;

    firstLink.style.marginLeft = margin + 'px';
    firstLink.style.transition = '';

    if (wasHidden) group.classList.add('hidden');

    return margin;
}

function initSubmenuMargins() {
    const menuConfig = getMenuConfig();
    menuConfig.forEach(({ id }) => {
        submenuMargins[id] = calcSubmenuMargin(id);
    });
}

function alignSubmenu() {
    const activeGroup = $('.submenu-group:not(.hidden)');
    if (!activeGroup) return;

    const groupId = activeGroup.dataset.group;
    const firstLink = activeGroup.querySelector('.submenu-link');
    if (!firstLink || !groupId) return;

    if (submenuMargins[groupId] !== undefined) {
        firstLink.style.marginLeft = submenuMargins[groupId] + 'px';
    }
}

// ==================== LOCATION ====================
function selectLocation(slug, isInitial = false) {
    const changed = currentLocation !== slug;
    currentLocation = slug;
    localStorage.setItem('srsk_location', slug);
    const loc = locations.find(l => l.slug === slug);
    if (!loc) return;

    // Обновляем название в селекторе (для housing показываем "Проживание")
    if (currentModule === 'housing') {
        $$('.location-name').forEach(el => el.textContent = t('module_housing'));
    } else {
        $$('.location-name').forEach(el => el.textContent = getName(loc));
        setColor(loc.color);
    }

    $$('.location-dropdown').forEach(d => d.classList.add('hidden'));
    $$('.location-arrow').forEach(a => a.classList.remove('rotate-180'));
    buildLocationOptions();

    // Вызываем колбэк страницы при смене локации (но не при инициализации)
    if (changed && !isInitial && typeof window.onLocationChange === 'function') {
        window.onLocationChange(slug);
    }
}

async function loadLocations() {
    const data = await Cache.getOrLoad('locations', async () => {
        const { data, error } = await db.from('locations').select('*');
        if (error) { console.error('Error loading locations:', error); return null; }
        return data;
    });

    if (!data) return;
    locations = data;
    buildLocationOptions();
    selectLocation(currentLocation, true); // isInitial = true, чтобы не вызывать колбэк при загрузке
}

// ==================== EVENT HANDLERS ====================
function initHeaderEvents() {
    // Mobile menu toggle
    const mobileMenuBtn = $('#mobileMenuBtn');
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            $('#mobileMenu').classList.toggle('open');
            $('.menu-icon').classList.toggle('hidden');
            $('.close-icon').classList.toggle('hidden');
        });
    }

    // Location selector
    $$('[data-toggle="location"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const selector = btn.closest('.location-selector');
            const dropdown = $('.location-dropdown', selector);
            const arrow = $('.location-arrow', selector);
            dropdown.classList.toggle('hidden');
            arrow.classList.toggle('rotate-180');
        });
    });

    // Global click handler
    document.addEventListener('click', e => {
        if (e.target.dataset.module === 'housing') {
            // Клик на "Проживание" - переключаемся на модуль housing
            switchModule('housing');
        } else if (e.target.dataset.loc) {
            // Клик на локацию (кухню) - если в housing, сначала переключаемся на kitchen
            if (currentModule === 'housing') {
                currentModule = 'kitchen';
                localStorage.setItem('srsk_module', 'kitchen');
                // Выбираем локацию и переходим на страницу кухни
                localStorage.setItem('srsk_location', e.target.dataset.loc);
                window.location.href = adjustHref(modules.kitchen.defaultPage);
            } else {
                selectLocation(e.target.dataset.loc);
            }
        } else if (!e.target.closest('.location-selector')) {
            $$('.location-dropdown').forEach(d => d.classList.add('hidden'));
            $$('.location-arrow').forEach(a => a.classList.remove('rotate-180'));
        }
    });

    // Desktop nav
    $$('.nav-link').forEach(link => {
        link.addEventListener('click', e => {
            const submenuId = link.dataset.submenu;

            // Single-item menus: allow navigation (don't preventDefault)
            if (!submenuId) {
                // Let the link navigate normally
                return;
            }

            // Multi-item menus: show submenu
            e.preventDefault();
            $$('.nav-link').forEach(l => { l.classList.remove('active'); l.classList.add('opacity-60'); });
            link.classList.add('active');
            link.classList.remove('opacity-60');

            $$('.submenu-group').forEach(g => g.classList.add('hidden'));

            if (innerWidth >= DESKTOP_BP) {
                $('#submenuBar').classList.remove('hidden');
                const group = $(`.submenu-group[data-group="${submenuId}"]`);
                if (group) group.classList.remove('hidden');
                alignSubmenu();
            } else {
                $('#submenuBar').classList.add('hidden');
            }
        });
    });

    // Language switcher
    $$('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            currentLang = btn.dataset.lang;
            localStorage.setItem('srsk_lang', currentLang);

            // Обновляем весь интерфейс
            updateHeaderLanguage();
            updateFooterLanguage();
            buildMobileMenu();
            buildSubmenuBar();

            // Обновляем кнопки языка
            $$('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === currentLang));

            // Вызываем колбэк страницы если он задан
            if (typeof window.onLanguageChange === 'function') {
                window.onLanguageChange(currentLang);
            }
        });
    });

    // Window resize with debounce
    addEventListener('resize', Utils.debounce(() => {
        initSubmenuMargins();
    }, 300));
}

// ==================== MODULE SWITCHING ====================
function switchModule(moduleId) {
    if (!modules[moduleId]) return;

    currentModule = moduleId;
    localStorage.setItem('srsk_module', moduleId);

    // Переходим на главную страницу модуля
    const module = modules[moduleId];
    window.location.href = adjustHref(module.defaultPage);
}

// ==================== INIT LAYOUT ====================
async function initLayout(page = { module: null, menuId: 'kitchen', itemId: null }) {
    // Устанавливаем модуль (из параметра или из localStorage)
    if (page.module) {
        currentModule = page.module;
        localStorage.setItem('srsk_module', currentModule);
    }

    currentPage = page;

    // Сначала загружаем переводы из БД
    await loadTranslations();

    // Вставляем хедер
    const headerPlaceholder = $('#header-placeholder');
    if (headerPlaceholder) {
        headerPlaceholder.outerHTML = getHeaderHTML();
    }

    // Вставляем футер
    const footerPlaceholder = $('#footer-placeholder');
    if (footerPlaceholder) {
        footerPlaceholder.outerHTML = getFooterHTML();
    }

    // Загружаем локации всегда (для выпадающего списка)
    await loadLocations();

    // Устанавливаем цвет для модуля housing
    if (currentModule === 'housing') {
        setColor('#8b5cf6');
        $$('.location-name').forEach(el => el.textContent = t('module_housing'));
    }

    buildMobileMenu();
    buildSubmenuBar();
    initHeaderEvents();

    // На главной странице (без menuId) скрываем селектор локаций
    if (!page.menuId) {
        $$('.location-selector').forEach(el => el.classList.add('hidden'));
    }

    // Показываем submenu bar
    const submenuBar = $('#submenuBar');
    if (submenuBar) submenuBar.classList.remove('hidden');

    return { db, currentLang, currentLocation, currentModule, locations };
}

/** Универсальная система уведомлений */
function showNotification(message, type = 'info') {
    const colors = {
        info: 'alert-info',
        success: 'alert-success',
        warning: 'alert-warning',
        error: 'alert-error'
    };

    const toast = document.createElement('div');
    toast.className = 'toast toast-top toast-end z-[100]';
    toast.innerHTML = `
        <div class="alert ${colors[type] || colors.info} shadow-lg">
            <span>${escapeHtml(message)}</span>
        </div>
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

/** Унифицированная обработка ошибок */
function handleError(error, context = '') {
    const message = error?.message || String(error);
    console.error(`[${context}]`, error);

    // Используем showNotification для уведомления
    showNotification(context ? `${context}: ${message}` : message, 'error');
}

// Форматирование количества с округлением вверх
// g, ml, tsp, tbsp — до 1 знака после запятой
// остальные (kg, l, pcs, cup) — до 2 знаков
function formatQuantity(amount, unit) {
    if (['g', 'ml', 'tsp', 'tbsp'].includes(unit)) {
        return Math.ceil(amount * 10) / 10;
    }
    return Math.ceil(amount * 100) / 100;
}

// Открыть модальное окно с фотографией
function openPhotoModal(photoUrl) {
    if (!photoUrl) return;
    const modal = document.getElementById('photoModal');
    const img = document.getElementById('photoModalImage');
    if (modal && img) {
        img.src = photoUrl;
        modal.showModal();
    }
}

// Экспортируем в глобальную область
window.Layout = {
    init: initLayout,
    db,
    $,
    $$,
    getName,
    getPersonName,
    transliterate,
    transliterateHindi,
    translate,
    setupAutoTranslate,
    setColor,
    t,
    pluralize,
    debounce,
    escapeHtml,
    updateAllTranslations,
    switchModule,
    showLoader,
    hideLoader,
    showNotification,
    handleError,
    formatQuantity,
    openPhotoModal,
    get currentLang() { return currentLang; },
    get currentLocation() { return currentLocation; },
    get currentModule() { return currentModule; },
    get locations() { return locations; },
    get translations() { return translations; },
    get modules() { return modules; }
};

})();
