// ==================== LAYOUT.JS ====================
// Общие компоненты: хедер, футер, меню, локации

(function() {
'use strict';

// ==================== CONFIG ====================
const SUPABASE_URL = 'https://llttmftapmwebidgevmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdHRtZnRhcG13ZWJpZGdldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3MTksImV4cCI6MjA4NDQ1MDcxOX0.V0J4_5AFDxHH6GsD-eh4N7fTBMjexSxAkVp2LSfgHh0';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const DESKTOP_BP = 1200;

// Структура меню (переводы берутся из БД по ключам nav_kitchen, nav_menu и т.д.)
const menuConfig = [
    { id: 'kitchen', items: [
        { id: 'menu', href: 'menu.html' },
        { id: 'recipes', href: 'recipes.html' },
        { id: 'products', href: 'products.html' }
    ]},
    { id: 'stock', items: [
        { id: 'inventory', href: 'stock.html' },
        { id: 'requests', href: 'requests.html' },
        { id: 'receive', href: 'receive.html' },
        { id: 'issue', href: 'issue.html' },
        { id: 'stock_settings', href: 'stock-settings.html' }
    ]},
    { id: 'ashram', items: [
        { id: 'retreats', href: 'retreats.html' },
        { id: 'team', href: 'team.html' }
    ]},
    { id: 'settings', items: [
        { id: 'dictionaries', href: 'dictionaries.html' },
        { id: 'translations', href: 'translations.html' },
        { id: 'festivals', href: 'festivals.html' }
    ]}
];

// ==================== STATE ====================
let currentLang = localStorage.getItem('srsk_lang') || 'ru';
let currentLocation = localStorage.getItem('srsk_location') || 'main';
let locations = [];
let translations = {}; // { key: { ru: '...', en: '...', hi: '...' } }

// Текущая страница (задаётся при инициализации)
let currentPage = { menuId: 'kitchen', itemId: null };

// ==================== HELPERS ====================
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => ctx.querySelectorAll(sel);
const setColor = color => document.documentElement.style.setProperty('--current-color', color);

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

/** Таблица транслитерации кириллицы в латиницу */
const TRANSLIT_MAP = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y',
    'К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F',
    'Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
};

/** Транслитерация кириллицы в латиницу */
function transliterate(text) {
    if (!text) return '';
    return text.split('').map(c => TRANSLIT_MAP[c] || c).join('');
}

/** Транслитерация хинди (деванагари) в IAST */
function transliterateHindi(hindi) {
    if (!hindi) return '';

    const CONSONANTS = {
        'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ṅ',
        'च': 'c', 'छ': 'ch', 'ज': 'j', 'झ': 'jh', 'ञ': 'ñ',
        'ट': 'ṭ', 'ठ': 'ṭh', 'ड': 'ḍ', 'ढ': 'ḍh', 'ण': 'ṇ',
        'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
        'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
        'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
        'श': 'ś', 'ष': 'ṣ', 'स': 's', 'ह': 'h'
    };
    const VOWELS = { 'अ': 'a', 'आ': 'ā', 'इ': 'i', 'ई': 'ī', 'उ': 'u', 'ऊ': 'ū', 'ऋ': 'ṛ', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au' };
    const MATRAS = { 'ा': 'ā', 'ि': 'i', 'ी': 'ī', 'ु': 'u', 'ू': 'ū', 'ृ': 'ṛ', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au' };
    const NUKTA_MAP = { 'क': 'q', 'ख': 'kh', 'ग': 'ġ', 'ज': 'z', 'फ': 'f', 'ड': 'ṛ', 'ढ': 'ṛh' };
    const ANUSVARA_MAP = {
        'क': 'ṅ', 'ख': 'ṅ', 'ग': 'ṅ', 'घ': 'ṅ', 'ङ': 'ṅ',
        'च': 'ñ', 'छ': 'ñ', 'ज': 'ñ', 'झ': 'ñ', 'ञ': 'ñ',
        'ट': 'ṇ', 'ठ': 'ṇ', 'ड': 'ṇ', 'ढ': 'ṇ', 'ण': 'ṇ',
        'त': 'n', 'थ': 'n', 'द': 'n', 'ध': 'n', 'न': 'n',
        'प': 'm', 'फ': 'm', 'ब': 'm', 'भ': 'm', 'म': 'm'
    };

    const text = hindi.normalize('NFC');
    let result = '';
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (VOWELS[char]) {
            result += VOWELS[char];
            i++;
            continue;
        }

        if (CONSONANTS[char]) {
            if (next === '़') {
                result += NUKTA_MAP[char] || CONSONANTS[char];
                i += 2;
            } else {
                result += CONSONANTS[char];
                i++;
            }

            const after = text[i];
            if (after === '्') {
                i++;
            } else if (MATRAS[after]) {
                result += MATRAS[after];
                i++;
            } else if (after === 'ं') {
                result += 'a';
            } else if (after === 'ः') {
                result += 'aḥ';
                i++;
            } else if (after === 'ँ') {
                result += 'am̐';
                i++;
            } else if (!CONSONANTS[after] && !VOWELS[after] && after !== undefined) {
                result += 'a';
            } else if (after === undefined) {
                // Конец слова — НЕ добавляем 'a' (schwa deletion в хинди)
            } else {
                result += 'a';
            }
            continue;
        }

        if (char === 'ं') {
            const nextCons = text[i + 1];
            result += ANUSVARA_MAP[nextCons] || 'ṃ';
            i++;
            continue;
        }

        if (char === 'ः') { result += 'ḥ'; i++; continue; }
        if (char === 'ँ') { result += 'm̐'; i++; continue; }
        if (MATRAS[char]) { result += MATRAS[char]; i++; continue; }
        if (char === '्' || char === '़') { i++; continue; }

        result += char;
        i++;
    }
    return result;
}

/** Имя человека с автотранслитерацией для не-русского языка */
function getPersonName(person, lang = currentLang) {
    if (!person) return '—';
    const name = person.spiritual_name || person.first_name || '';
    return lang === 'ru' ? name : transliterate(name);
}

/**
 * Склонение слов для разных языков
 * @param {number} n - число
 * @param {Object} forms - формы слова { ru: ['рецепт', 'рецепта', 'рецептов'], en: ['recipe', 'recipes'], hi: 'व्यंजन' }
 * @returns {string} - "5 рецептов"
 */
function pluralize(n, forms) {
    const lang = currentLang;
    const langForms = forms[lang] || forms.ru;

    // Хинди: не склоняется
    if (typeof langForms === 'string') {
        return `${n} ${langForms}`;
    }

    // Английский: singular/plural
    if (lang === 'en' || langForms.length === 2) {
        return `${n} ${n === 1 ? langForms[0] : langForms[1]}`;
    }

    // Русский: one/few/many
    const mod10 = n % 10;
    const mod100 = n % 100;

    if (mod10 === 1 && mod100 !== 11) {
        return `${n} ${langForms[0]}`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
        return `${n} ${langForms[1]}`;
    }
    return `${n} ${langForms[2]}`;
}

/** Debounce функция для оптимизации частых вызовов */
function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/**
 * Автоперевод текста через MyMemory API
 * @param {string} text - текст для перевода
 * @param {string} from - исходный язык (ru, en, hi)
 * @param {string} to - целевой язык (ru, en, hi)
 * @returns {Promise<string>} - переведённый текст
 */
async function translate(text, from = 'ru', to = 'en') {
    if (!text || !text.trim()) return '';

    try {
        const response = await fetch(
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`
        );
        const data = await response.json();

        if (data.responseStatus === 200 && data.responseData?.translatedText) {
            // MyMemory иногда возвращает текст в верхнем регистре при ошибке
            const result = data.responseData.translatedText;
            if (result === text.toUpperCase()) {
                console.warn('Translation may have failed:', result);
                return text;
            }
            return result;
        }

        console.error('Translation error:', data);
        return text;
    } catch (error) {
        console.error('Translation fetch error:', error);
        return text;
    }
}

// ==================== TRANSLATIONS ====================
async function loadTranslations() {
    const { data, error } = await db.from('translations').select('key, ru, en, hi');
    if (error) {
        console.error('Error loading translations:', error);
        return;
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
    return `
    <header class="bg-base-100 shadow-sm sticky top-0 z-50">
        <div class="container mx-auto px-4">
            <div class="flex items-center justify-between h-20">

                <!-- Logo + Location Selector -->
                <div class="flex items-center gap-3 flex-shrink-0">
                    <a href="index.html" class="hover:opacity-80 transition-opacity">
                        <svg class="h-14 w-auto logo-svg" viewBox="0 0 122.03 312.54" xmlns="http://www.w3.org/2000/svg">
                            <path fill="var(--current-color)" d="M102,15.99h-15.18v81.89c0,6.21.12,11.58-.88,15.98-1.01,4.45-2.6,7.98-4.77,10.58-2.02,2.81-4.85,4.83-8.51,6.05-2.38,1-5.08,1.62-8.1,1.83-1.01.21-2.02.32-3.02.32h-.64c-3.81-.21-7.23-.83-10.25-1.83-3.81-1.22-7.02-3.13-9.62-5.73-2.65-2.81-4.56-6.44-5.73-10.89-1.22-4.4-1.83-9.83-1.83-16.3V15.99h-15.1v89.12c0,13.68,3.81,23.94,11.45,30.77,3.81,3.44,8.56,5.96,14.23,7.55,1.17.42,2.57.74,4.21.96-13.89,5.03-23.35,11.87-28.38,20.51-7.05,10.65-7.26,24.14-.64,40.46l41.34,100.45,39.91-100.45c6.41-16.32,6.2-29.82-.64-40.46-4.82-8.48-13.97-15.21-27.43-20.2,1.59-.43,3.18-.85,4.77-1.27,5.25-1.59,9.67-4.19,13.27-7.79,3.82-3.66,6.65-8.18,8.51-13.59,2.02-5.62,3.02-12.27,3.02-19.95V15.99M87.45,172.46c4.03,7.26,3.84,16.4-.56,27.43l-26.31,68.13-27.75-68.13c-4.61-11.03-4.8-20.17-.55-27.43,4.61-7.47,13.76-13.01,27.43-16.62,13.67,3.61,22.93,9.15,27.75,16.62"/>
                        </svg>
                    </a>

                    <!-- Desktop: full name + selector -->
                    <div class="hidden md:flex flex-col">
                        <a href="index.html" class="text-xl font-semibold whitespace-nowrap hover:opacity-80 transition-opacity" data-i18n="app_name">Шри Рупа Сева Кунджа</a>
                        <div class="relative location-selector" id="locationDesktop">
                            <button class="flex items-center justify-between gap-2 w-full text-xl opacity-70 hover:opacity-100 transition-opacity" data-toggle="location">
                                <span class="location-name">Основная кухня</span>
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
                                <span class="location-name">Основная кухня</span>
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
                    ${menuConfig.map(({ id }) => `
                        <a href="#" class="nav-link px-5 py-6 text-base font-semibold tracking-wide uppercase ${id === currentPage.menuId ? 'active' : 'opacity-60'}" data-submenu="${id}" data-menu-id="${id}">${t('nav_' + id)}</a>
                    `).join('')}
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
    // Собираем ссылки из текущего раздела меню (второй уровень)
    const currentMenu = menuConfig.find(m => m.id === currentPage.menuId);
    const footerLinks = currentMenu ? currentMenu.items : menuConfig[0].items;

    return `
    <footer class="bg-base-100 border-t border-base-200 mt-auto">
        <div class="container mx-auto px-4 py-6">
            <!-- Первый уровень меню -->
            <nav class="flex flex-wrap justify-center gap-4 sm:gap-6 mb-3" id="footerMainNav">
                ${menuConfig.map(menu => `
                    <a href="${menu.items[0].href}" class="text-sm font-bold uppercase tracking-wide ${menu.id === currentPage.menuId ? 'text-primary' : 'opacity-60 hover:opacity-100'}" data-menu-id="${menu.id}">${t('nav_' + menu.id)}</a>
                `).join('')}
            </nav>

            <!-- Второй уровень меню -->
            <nav class="flex flex-wrap justify-center gap-4 sm:gap-6 mb-4" id="footerNav">
                ${footerLinks.map(item => `
                    <a href="${item.href}" class="text-sm font-medium uppercase tracking-wide ${item.id === currentPage.itemId ? 'text-primary' : 'opacity-60 hover:opacity-100'}">${t('nav_' + item.id)}</a>
                `).join('')}
            </nav>

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
    </footer>`;
}

// ==================== HEADER FUNCTIONS ====================
function buildLocationOptions() {
    const html = locations.map(loc =>
        `<button class="w-full text-left px-4 py-2 hover:bg-base-200 text-base-content ${loc.slug === currentLocation ? 'font-medium' : ''}" data-loc="${loc.slug}">${getName(loc)}</button>`
    ).join('');
    $$('.location-dropdown').forEach(el => el.innerHTML = html);
}

function buildMobileMenu() {
    const nav = $('#mobileNav');
    if (!nav) return;

    nav.innerHTML = menuConfig.map(({ id, items }) => `
        <div class="mobile-nav-item ${id === currentPage.menuId ? 'open' : ''}" data-has-submenu>
            <button class="w-full flex items-center px-4 py-3 text-base font-semibold uppercase tracking-wide hover:bg-base-200 rounded-lg">
                ${t('nav_' + id)}
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 ml-2 transition-transform arrow-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </button>
            <div class="submenu pl-4">
                ${items.map(item => `<a href="${item.href}" class="block px-4 py-3 text-base font-medium rounded-lg hover:bg-base-200 ${item.id === currentPage.itemId ? 'text-primary' : ''}">${t('nav_' + item.id)}</a>`).join('')}
            </div>
        </div>
    `).join('');

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

    bar.innerHTML = menuConfig.map(({ id, items }) => `
        <nav class="container mx-auto px-4 flex items-center submenu-group ${id !== currentPage.menuId ? 'hidden' : ''}" data-group="${id}">
            ${items.map(item => `<a href="${item.href}" class="submenu-link px-5 py-2 text-base font-semibold tracking-wide uppercase ${item.id === currentPage.itemId ? 'active' : 'text-white/70 hover:text-white'}">${t('nav_' + item.id)}</a>`).join('')}
        </nav>
    `).join('');

    initSubmenuMargins();
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

    // Обновляем название локации
    const loc = locations.find(l => l.slug === currentLocation);
    if (loc) {
        $$('.location-name').forEach(el => el.textContent = getName(loc));
    }

    // Обновляем выпадашку локаций
    buildLocationOptions();
}

function updateFooterLanguage() {
    // Обновляем первый уровень меню
    const footerMainNav = $('#footerMainNav');
    if (footerMainNav) {
        footerMainNav.innerHTML = menuConfig.map(menu => `
            <a href="${menu.items[0].href}" class="text-sm font-bold uppercase tracking-wide ${menu.id === currentPage.menuId ? 'text-primary' : 'opacity-60 hover:opacity-100'}" data-menu-id="${menu.id}">${t('nav_' + menu.id)}</a>
        `).join('');
    }

    // Обновляем второй уровень меню
    const footerNav = $('#footerNav');
    if (footerNav) {
        const currentMenu = menuConfig.find(m => m.id === currentPage.menuId);
        const footerLinks = currentMenu ? currentMenu.items : menuConfig[0].items;

        // Используем ключи переводов nav_menu, nav_recipes, etc.
        footerNav.innerHTML = footerLinks.map(item => {
            const key = `nav_${item.id}`;
            return `<a href="${item.href}" class="text-sm font-medium uppercase tracking-wide ${item.id === currentPage.itemId ? 'text-primary' : 'opacity-60 hover:opacity-100'}">${t(key)}</a>`;
        }).join('');
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
    const kitchenLink = $('.nav-link[data-submenu="kitchen"]');
    const submenuBar = $('#submenuBar');
    const group = $(`.submenu-group[data-group="${groupId}"]`);
    if (!kitchenLink || !submenuBar || !group) return 0;

    const firstLink = group.querySelector('.submenu-link');
    if (!firstLink) return 0;

    const wasHidden = group.classList.contains('hidden');
    group.classList.remove('hidden');
    firstLink.style.transition = 'none';
    firstLink.style.marginLeft = '0';
    // Force reflow — нужно чтобы браузер применил стили до измерения позиции
    void firstLink.offsetWidth;

    const navRect = kitchenLink.getBoundingClientRect();
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

    $$('.location-name').forEach(el => el.textContent = getName(loc));
    $$('.location-dropdown').forEach(d => d.classList.add('hidden'));
    $$('.location-arrow').forEach(a => a.classList.remove('rotate-180'));
    buildLocationOptions();
    setColor(loc.color);

    // Вызываем колбэк страницы при смене локации (но не при инициализации)
    if (changed && !isInitial && typeof window.onLocationChange === 'function') {
        window.onLocationChange(slug);
    }
}

async function loadLocations() {
    const { data, error } = await db.from('locations').select('*');
    if (error) { console.error('Error loading locations:', error); return; }
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
        if (e.target.dataset.loc) {
            selectLocation(e.target.dataset.loc);
        } else if (!e.target.closest('.location-selector')) {
            $$('.location-dropdown').forEach(d => d.classList.add('hidden'));
            $$('.location-arrow').forEach(a => a.classList.remove('rotate-180'));
        }
    });

    // Desktop nav
    $$('.nav-link').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            $$('.nav-link').forEach(l => { l.classList.remove('active'); l.classList.add('opacity-60'); });
            link.classList.add('active');
            link.classList.remove('opacity-60');

            const submenuId = link.dataset.submenu;
            $$('.submenu-group').forEach(g => g.classList.add('hidden'));

            if (submenuId && innerWidth >= DESKTOP_BP) {
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

    // Window resize
    addEventListener('resize', () => {
        initSubmenuMargins();
    });
}

// ==================== INIT LAYOUT ====================
async function initLayout(page = { menuId: 'kitchen', itemId: null }) {
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

    // Загружаем локации и инициализируем
    await loadLocations();
    buildMobileMenu();
    buildSubmenuBar();
    initHeaderEvents();

    // Показываем submenu bar
    const submenuBar = $('#submenuBar');
    if (submenuBar) submenuBar.classList.remove('hidden');

    return { db, currentLang, currentLocation, locations };
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
    setColor,
    t,
    pluralize,
    debounce,
    updateAllTranslations,
    get currentLang() { return currentLang; },
    get currentLocation() { return currentLocation; },
    get locations() { return locations; },
    get translations() { return translations; }
};

})();
