// Модуль меню кухни
// Вынесено из kitchen/menu.html

// ==================== STATE ====================
let currentView = 'day';
let currentDate = new Date();
let currentWeekStart = getWeekStart(new Date());
let currentMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let periodStart = null; // Date — начало произвольного периода
let periodEnd = null;   // Date — конец произвольного периода

let recipes = [];
let categories = [];
let units = [];
let menuData = {}; // { 'YYYY-MM-DD': { breakfast: {...}, lunch: {...}, dinner: {...} } }
let retreats = [];
let holidays = [];
let cooks = [];
let eatingCounts = {}; // { 'YYYY-MM-DD': { breakfast: { team, volunteers, vips, guests, groups }, lunch: {...} } }

let selectedDate = null;
let selectedMealType = null;
let selectedRecipe = null;
let currentCategory = 'all';

// Template state
let templates = [];
let selectedTemplateId = null;

// Ingredients cache for meal details
let ingredientsCache = {};

// Флаг права на редактирование меню
const canEditMenu = () => window.hasPermission?.('edit_menu') ?? false;

// Склонение дней
const DAY_FORMS = { ru: ['день', 'дня', 'дней'], en: ['day', 'days'], hi: 'दिन' };
const pluralizeDays = n => Layout.pluralize(n, DAY_FORMS);

// Success modal
function showSuccess(title, message) {
    Layout.$('#successTitle').textContent = title;
    Layout.$('#successMessage').textContent = message || '';
    successModal.showModal();
}

// Конфигурация типов приёмов пищи по локациям
const mealConfig = {
    main: ['breakfast', 'lunch', 'dinner'],
    cafe: ['menu'],  // Кафе: просто "Меню дня"
    guest: ['breakfast', 'lunch', 'dinner']
};

// Получить типы приёмов пищи для текущей локации
function getMealTypes() {
    return mealConfig[Layout.currentLocation] || ['breakfast', 'lunch', 'dinner'];
}

// ==================== SHORTCUTS ====================
const t = key => Layout.t(key);
const getName = (item, lang) => Layout.getName(item, lang || Layout.currentLang);
const getPersonName = person => Layout.getPersonName(person, Layout.currentLang);

// ==================== CONSTANTS ====================
const LOGO_SVG = `<svg class="print-header-logo" viewBox="0 0 122.03 312.54" xmlns="http://www.w3.org/2000/svg">
    <path fill="currentColor" d="M102,15.99h-15.18v81.89c0,6.21.12,11.58-.88,15.98-1.01,4.45-2.6,7.98-4.77,10.58-2.02,2.81-4.85,4.83-8.51,6.05-2.38,1-5.08,1.62-8.1,1.83-1.01.21-2.02.32-3.02.32h-.64c-3.81-.21-7.23-.83-10.25-1.83-3.81-1.22-7.02-3.13-9.62-5.73-2.65-2.81-4.56-6.44-5.73-10.89-1.22-4.4-1.83-9.83-1.83-16.3V15.99h-15.1v89.12c0,13.68,3.81,23.94,11.45,30.77,3.81,3.44,8.56,5.96,14.23,7.55,1.17.42,2.57.74,4.21.96-13.89,5.03-23.35,11.87-28.38,20.51-7.05,10.65-7.26,24.14-.64,40.46l41.34,100.45,39.91-100.45c6.41-16.32,6.2-29.82-.64-40.46-4.82-8.48-13.97-15.21-27.43-20.2,1.59-.43,3.18-.85,4.77-1.27,5.25-1.59,9.67-4.19,13.27-7.79,3.82-3.66,6.65-8.18,8.51-13.59,2.02-5.62,3.02-12.27,3.02-19.95V15.99M87.45,172.46c4.03,7.26,3.84,16.4-.56,27.43l-26.31,68.13-27.75-68.13c-4.61-11.03-4.8-20.17-.55-27.43,4.61-7.47,13.76-13.01,27.43-16.62,13.67,3.61,22.93,9.15,27.75,16.62"/>
</svg>`;

// ==================== HELPERS ====================
// Названия месяцев
const getMonthNames = () => [
    t('month_jan'), t('month_feb'), t('month_mar'), t('month_apr'),
    t('month_may'), t('month_jun'), t('month_jul'), t('month_aug'),
    t('month_sep'), t('month_oct'), t('month_nov'), t('month_dec')
];

// Названия дней недели (с воскресенья, для getDay())
const getDayNames = () => [
    t('weekday_sun'), t('weekday_mon'), t('weekday_tue'), t('weekday_wed'),
    t('weekday_thu'), t('weekday_fri'), t('weekday_sat')
];

// Названия дней недели (с понедельника, для календаря)
const getDayNamesMon = () => [
    t('weekday_mon'), t('weekday_tue'), t('weekday_wed'), t('weekday_thu'),
    t('weekday_fri'), t('weekday_sat'), t('weekday_sun')
];

// Текущая локация (объект)
const getCurrentLocation = () => Layout.locations?.find(l => l.slug === Layout.currentLocation);

// Перевод единицы измерения
function getUnitShort(unitCode) {
    if (!unitCode) return '';
    const unit = units.find(u => u.code === unitCode || u.short_ru === unitCode || u.short_en === unitCode);
    return unit ? (unit[`short_${Layout.currentLang}`] || unit.short_ru || unitCode) : unitCode;
}

// Стили фона для дня (ретрит/праздник/экадаши)
function getDayStyles(retreat, majorFestival, isEkadashiDay) {
    if (retreat) return { bg: `background-color: ${retreat.color}20;`, header: `background-color: ${retreat.color}30; border-left: 4px solid ${retreat.color};` };
    if (majorFestival) return { bg: 'background-color: #FEF9C3;', header: 'background-color: #FDE047; border-left: 4px solid #EAB308;' };
    if (isEkadashiDay) return { bg: 'background-color: #FFFBEB;', header: 'background-color: #FEF3C7;' };
    return { bg: 'background-color: white;', header: '' };
}

// Форматирование даты для отображения
function formatDateDisplay(date) {
    const m = getMonthNames(), d = getDayNames();
    return `${date.getDate()} ${m[date.getMonth()]} ${date.getFullYear()}, ${d[date.getDay()]}`;
}

// Шапка для печати
function getPrintHeader(dateText, extraInfo = '') {
    const loc = getCurrentLocation();
    return `
        <div class="print-header-left">
            ${LOGO_SVG}
            <div>
                <div class="print-header-title">${t('app_name')}</div>
                <div class="print-header-location">${loc ? getName(loc) : ''}</div>
            </div>
        </div>
        <div class="print-header-right">
            <div class="print-header-menu">${t('menu_title')}</div>
            <div class="print-header-date">${dateText}${extraInfo ? ' · ' + extraInfo : ''}</div>
        </div>
    `;
}

// ==================== HASH STATE ====================
function updateHash() {
    let hash;
    if (currentView === 'day') {
        hash = `#day/${formatDate(currentDate)}`;
    } else if (currentView === 'week') {
        hash = `#week/${formatDate(currentWeekStart)}`;
    } else if (currentView === 'month') {
        const y = currentMonth.getFullYear();
        const m = String(currentMonth.getMonth() + 1).padStart(2, '0');
        hash = `#month/${y}-${m}`;
    } else if (currentView === 'period' && periodStart && periodEnd) {
        hash = `#period/${formatDate(periodStart)}/${formatDate(periodEnd)}`;
    } else {
        return;
    }
    history.replaceState(null, '', hash);
}

function restoreFromHash() {
    const hash = location.hash.slice(1); // убираем #
    if (!hash) return;
    const parts = hash.split('/');
    const view = parts[0];
    if (view === 'day' && parts[1]) {
        currentView = 'day';
        currentDate = parseLocalDate(parts[1]);
    } else if (view === 'week' && parts[1]) {
        currentView = 'week';
        currentWeekStart = parseLocalDate(parts[1]);
    } else if (view === 'month' && parts[1]) {
        currentView = 'month';
        const [y, m] = parts[1].split('-').map(Number);
        currentMonth = new Date(y, m - 1, 1);
    } else if (view === 'period' && parts[1] && parts[2]) {
        currentView = 'period';
        periodStart = parseLocalDate(parts[1]);
        periodEnd = parseLocalDate(parts[2]);
    }
}

// ==================== DATE HELPERS ====================
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    return new Date(d.setDate(diff));
}

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getMealTypeName(type) {
    return t(type) || type;
}

function isEkadashi(dateStr) {
    return holidays.some(h => h.date === dateStr && h.type === 'ekadashi');
}

function getMajorFestival(dateStr) {
    return holidays.find(h => h.date === dateStr && h.type === 'major');
}

function getAcharyaEvents(dateStr) {
    return holidays.filter(h => h.date === dateStr && (h.type === 'appearance' || h.type === 'disappearance'));
}

function getHoliday(dateStr) {
    return holidays.find(h => h.date === dateStr);
}

function getRetreat(dateStr) {
    return retreats.find(r => {
        return dateStr >= r.start_date && dateStr <= r.end_date;
    });
}

function getCook(id) {
    return cooks.find(c => c.id === id);
}

// ==================== DATA LOADING ====================
async function loadData() {
    const locationId = getCurrentLocation()?.id;

    // Запускаем все независимые запросы параллельно
    let recipesQuery = Layout.db
        .from('recipes')
        .select('*, category:recipe_categories(*)');
    if (locationId) {
        recipesQuery = recipesQuery.eq('location_id', locationId);
    }

    const [
        recipesResult,
        categoriesResult,
        retreatsResult,
        holidaysResult,
        cooksResult,
        unitsResult
    ] = await Promise.all([
        recipesQuery,
        Cache.getOrLoad('recipe_categories', async () => {
            const { data, error } = await Layout.db
                .from('recipe_categories')
                .select('*')
                .order('sort_order');
            if (error) { console.error('Error loading recipe_categories:', error); return null; }
            return data;
        }),
        Layout.db.from('retreats').select('*'),
        Layout.db.from('holidays').select('*'),
        // Оптимизация: фильтруем по Kitchen на сервере через связь
        Layout.db
            .from('vaishnavas')
            .select('*, department:departments!inner(*)')
            .eq('is_team_member', true)
            .eq('is_deleted', false)
            .eq('departments.name_en', 'Kitchen'),
        Cache.getOrLoad('units', async () => {
            const { data, error } = await Layout.db.from('units').select('*');
            if (error) { console.error('Error loading units:', error); return null; }
            return data;
        })
    ]);

    recipes = recipesResult.data || [];
    categories = categoriesResult || [];
    retreats = retreatsResult.data || [];
    holidays = holidaysResult.data || [];
    cooks = cooksResult.data || [];
    units = unitsResult || [];

    // Load menu for current period
    await loadMenuData();
}

async function loadMenuData() {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) {
        menuData = {};
        render();
        return;
    }

    // Calculate date range based on view
    let startDate, endDate;
    if (currentView === 'day') {
        startDate = endDate = formatDate(currentDate);
    } else if (currentView === 'week') {
        startDate = formatDate(currentWeekStart);
        const weekEnd = new Date(currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        endDate = formatDate(weekEnd);
    } else if (currentView === 'period') {
        if (!periodStart || !periodEnd) return;
        startDate = formatDate(periodStart);
        endDate = formatDate(periodEnd);
    } else {
        startDate = formatDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1));
        endDate = formatDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0));
    }

    // Load meals with dishes
    const { data: mealsData } = await Layout.db
        .from('menu_meals')
        .select(`
            *,
            cook:vaishnavas(*),
            dishes:menu_dishes(*, recipe:recipes(*, category:recipe_categories(*)))
        `)
        .eq('location_id', locationId)
        .gte('date', startDate)
        .lte('date', endDate);

    // Organize by date and meal_type
    menuData = {};
    (mealsData || []).forEach(meal => {
        if (!menuData[meal.date]) {
            menuData[meal.date] = {};
        }
        menuData[meal.date][meal.meal_type] = {
            id: meal.id,
            portions: meal.portions,
            cook_id: meal.cook_id,
            cook: meal.cook,
            dishes: (meal.dishes || []).map(d => ({
                id: d.id,
                recipe_id: d.recipe_id,
                recipe: d.recipe,
                portion_size: d.portion_size,
                portion_unit: d.portion_unit
            }))
        };
    });

    // Загружаем количество едоков для текущего диапазона
    await loadEatingCounts(startDate, endDate);

    render();
}

// Загрузка количества едоков на период
async function loadEatingCounts(startDate, endDate) {
    eatingCounts = await EatingUtils.loadCounts(startDate, endDate);
}

// Получить количество питающихся на дату и приём пищи (для порций)
function getEatingTotal(dateStr, mealType) {
    return EatingUtils.getTotal(eatingCounts, dateStr, mealType);
}

// Сумма всех полей meal-counts
function mealTotal(mc) {
    return (mc.team || 0) + (mc.volunteers || 0) + (mc.vips || 0) + (mc.guests || 0) + (mc.groups || 0);
}

// Строка с подсчётом питающихся (завтрак / обед)
function formatEatingLine(dateStr, cssClass) {
    const counts = eatingCounts[dateStr];
    if (!counts) return '';

    const bf = counts.breakfast;
    const ln = counts.lunch;
    if (!bf && !ln) return '';

    const bfTotal = bf ? mealTotal(bf) : 0;
    const lnTotal = ln ? mealTotal(ln) : 0;
    if (bfTotal === 0 && lnTotal === 0) return '';

    const titleText = t('eating_tooltip');

    // Формирование строки разбивки: team+vol+vip+guests+groups
    const fmtParts = (mc) => {
        const parts = [mc.team, mc.volunteers, mc.vips, mc.guests];
        if (mc.groups) parts.push(mc.groups);
        return parts.join('+');
    };

    // Авторасчёт
    let autoLine;
    if (bfTotal === lnTotal) {
        autoLine = `${t('breakfast_and_lunch')}: ${fmtParts(bf)}=${bfTotal}`;
    } else {
        autoLine = `${t('breakfast')}: ${bfTotal}, ${t('lunch')}: ${lnTotal}`;
    }

    // Проверяем ручные порции повара
    const dayMenu = menuData[dateStr];
    if (dayMenu) {
        const cookBf = dayMenu.breakfast?.portions;
        const cookLn = dayMenu.lunch?.portions;
        const hasBfOverride = cookBf && cookBf !== bfTotal;
        const hasLnOverride = cookLn && cookLn !== lnTotal;

        if (hasBfOverride || hasLnOverride) {
            const actualBf = cookBf || bfTotal;
            const actualLn = cookLn || lnTotal;
            const cookStr = (actualBf === actualLn)
                ? actualBf
                : `${actualBf}/${actualLn}`;
            autoLine += ` → ${t('cook')}: ${cookStr}`;
        }
    }

    return `<div class="${cssClass}" title="${titleText}">${autoLine}</div>`;
}

// Детальная разбивка едоков для дневного вида
function formatEatingDetailed(dateStr) {
    const counts = eatingCounts[dateStr];
    if (!counts) return '';

    const dayMenu = menuData[dateStr];

    const renderMeal = (mc, mealKey, label) => {
        if (!mc) return '';
        const total = mealTotal(mc);
        if (total === 0) return '';

        const parts = [];
        if (mc.team) parts.push(`${t('status_team')} – ${mc.team}`);
        if (mc.volunteers) parts.push(`${t('category_volunteer')} – ${mc.volunteers}`);
        if (mc.vips) parts.push(`${t('category_vip')} – ${mc.vips}`);
        if (mc.guests) parts.push(`${t('status_guest')} – ${mc.guests}`);
        if (mc.groups) parts.push(`${t('nav_groups')} – ${mc.groups}`);

        const cookPortions = dayMenu?.[mealKey]?.portions;
        const hasCookOverride = cookPortions && cookPortions !== total;

        let line = `<span class="text-sm">${label}: ${parts.join(', ')} = ${total}</span>`;
        if (hasCookOverride) {
            line += ` <span class="text-sm font-bold">→ ${t('cook')}: ${cookPortions}</span>`;
        }

        return `<div class="mb-1">${line}</div>`;
    };

    const bfHtml = renderMeal(counts.breakfast, 'breakfast', t('breakfast'));
    const lnHtml = renderMeal(counts.lunch, 'lunch', t('lunch'));

    if (!bfHtml && !lnHtml) return '';

    return `<div class="mt-2 text-gray-500">${bfHtml}${lnHtml}</div>`;
}

// ==================== EATING COUNT CHANGE ALERT ====================
const EATING_ALERT_THRESHOLD = 5;   // порог: ±5 человек
const EATING_ALERT_COOLDOWN = 3600000; // 1 час в мс

function getEatingTotalForDate(dateStr) {
    const counts = eatingCounts[dateStr];
    if (!counts) return null;
    const bfTotal = counts.breakfast ? mealTotal(counts.breakfast) : 0;
    const lnTotal = counts.lunch ? mealTotal(counts.lunch) : 0;
    if (bfTotal === 0 && lnTotal === 0) return null;
    return { breakfast: bfTotal, lunch: lnTotal };
}

async function checkEatingCountChanges() {
    try {
        // Cooldown: не чаще раза в час
        const lastCheck = localStorage.getItem('menu_eating_alert_time');
        if (lastCheck && Date.now() - parseInt(lastCheck) < EATING_ALERT_COOLDOWN) return;

        const today = formatDate(new Date());
        const tomorrow = formatDate(new Date(Date.now() + 86400000));
        const datesToCheck = [today, tomorrow];

        // Загружаем данные за today/tomorrow если их нет (вид может быть на другом периоде)
        if (!eatingCounts[today] && !eatingCounts[tomorrow]) {
            const saved = { ...eatingCounts };
            await loadEatingCounts(today, tomorrow);
            // Восстанавливаем старые данные, добавляя today/tomorrow
            const todayCounts = eatingCounts[today];
            const tomorrowCounts = eatingCounts[tomorrow];
            eatingCounts = saved;
            if (todayCounts) eatingCounts[today] = todayCounts;
            if (tomorrowCounts) eatingCounts[tomorrow] = tomorrowCounts;
        }

        const savedRaw = localStorage.getItem('menu_eating_counts');
        const saved = savedRaw ? JSON.parse(savedRaw) : {};

        const changes = [];
        const newCounts = {};

        for (const dateStr of datesToCheck) {
            const current = getEatingTotalForDate(dateStr);
            if (!current) continue;
            newCounts[dateStr] = current;

            const prev = saved[dateStr];
            if (!prev) continue; // первый раз — просто сохраняем, без алерта

            const bfDiff = current.breakfast - prev.breakfast;
            const lnDiff = current.lunch - prev.lunch;

            if (Math.abs(bfDiff) >= EATING_ALERT_THRESHOLD || Math.abs(lnDiff) >= EATING_ALERT_THRESHOLD) {
                changes.push({ dateStr, prev, current, bfDiff, lnDiff });
            }
        }

        // Сохраняем текущие значения (для следующей проверки)
        // Но только если нет изменений — иначе сохраним после "Ок"
        if (changes.length === 0) {
            localStorage.setItem('menu_eating_counts', JSON.stringify(newCounts));
            localStorage.setItem('menu_eating_alert_time', String(Date.now()));
            return;
        }

        // Показываем алерт
        const body = Layout.$('#eatingChangeBody');
        const monthNames = getMonthNames();
        const dayNames = getDayNames();

        body.innerHTML = changes.map(ch => {
            const d = parseLocalDate(ch.dateStr);
            const dateLabel = `${d.getDate()} ${monthNames[d.getMonth()]}, ${dayNames[d.getDay()]}`;
            const lines = [];
            if (Math.abs(ch.bfDiff) >= EATING_ALERT_THRESHOLD) {
                const arrow = ch.bfDiff > 0 ? '↑' : '↓';
                const color = ch.bfDiff > 0 ? 'text-error' : 'text-success';
                lines.push(`${t('breakfast')}: ${ch.prev.breakfast} → <span class="font-bold ${color}">${ch.current.breakfast}</span> (${arrow}${Math.abs(ch.bfDiff)})`);
            }
            if (Math.abs(ch.lnDiff) >= EATING_ALERT_THRESHOLD) {
                const arrow = ch.lnDiff > 0 ? '↑' : '↓';
                const color = ch.lnDiff > 0 ? 'text-error' : 'text-success';
                lines.push(`${t('lunch')}: ${ch.prev.lunch} → <span class="font-bold ${color}">${ch.current.lunch}</span> (${arrow}${Math.abs(ch.lnDiff)})`);
            }
            return `<div class="p-3 bg-base-200 rounded-lg">
                <div class="font-medium mb-1">${dateLabel}</div>
                ${lines.map(l => `<div>${l}</div>`).join('')}
            </div>`;
        }).join('');

        // Сохраняем новые значения во временное хранилище — применим после "Ок"
        window._pendingEatingCounts = newCounts;
        Layout.$('#eatingChangeModal').showModal();
    } catch { /* localStorage недоступен — игнорируем */ }
}

function dismissEatingChangeAlert() {
    Layout.$('#eatingChangeModal').close();
    try {
        if (window._pendingEatingCounts) {
            localStorage.setItem('menu_eating_counts', JSON.stringify(window._pendingEatingCounts));
            delete window._pendingEatingCounts;
        }
        localStorage.setItem('menu_eating_alert_time', String(Date.now()));
    } catch { /* игнорируем */ }
}

// ==================== RENDERING ====================
function render() {
    if (currentView === 'day') {
        renderDay();
    } else if (currentView === 'week') {
        renderWeek();
    } else if (currentView === 'period') {
        renderPeriod();
    } else {
        renderMonth();
    }
    updatePeriodRange();
}

function updatePeriodRange() {
    const m = getMonthNames();
    let text = '';

    if (currentView === 'day') {
        text = `${currentDate.getDate()} ${m[currentDate.getMonth()]} ${currentDate.getFullYear()}`;
    } else if (currentView === 'week') {
        const end = new Date(currentWeekStart);
        end.setDate(end.getDate() + 6);
        text = `${currentWeekStart.getDate()} – ${end.getDate()} ${m[end.getMonth()]} ${end.getFullYear()}`;
    } else if (currentView === 'period') {
        if (periodStart && periodEnd) {
            text = `${periodStart.getDate()} ${m[periodStart.getMonth()]} – ${periodEnd.getDate()} ${m[periodEnd.getMonth()]} ${periodEnd.getFullYear()}`;
        }
    } else {
        text = `${m[currentMonth.getMonth()]} ${currentMonth.getFullYear()}`;
    }

    Layout.$('#periodRange').textContent = text;
}

function renderDay() {
    const container = Layout.$('#dayContent');
    const dateStr = formatDate(currentDate);
    const dayMenu = menuData[dateStr] || {};
    const retreat = getRetreat(dateStr);
    const majorFestival = getMajorFestival(dateStr);
    const acharyaEvents = getAcharyaEvents(dateStr);
    const isEkadashiDay = isEkadashi(dateStr);
    const isToday = dateStr === formatDate(new Date());
    const styles = getDayStyles(retreat, majorFestival, isEkadashiDay);
    const m = getMonthNames();
    const d = getDayNames();

    const dateText = formatDateDisplay(currentDate);
    const extraInfo = [retreat ? getName(retreat) : '', majorFestival ? getName(majorFestival) : '', isEkadashiDay ? t('ekadashi') : ''].filter(Boolean).join(' · ');

    // Build holiday banner
    let holidayBanner = '';
    if (majorFestival) {
        holidayBanner = `<div class="bg-yellow-200 text-yellow-800 text-center py-2 font-medium no-print">${getName(majorFestival)}</div>`;
    } else if (isEkadashiDay) {
        holidayBanner = `<div class="bg-amber-100 text-amber-700 text-center py-2 font-medium no-print">${t('ekadashi')}</div>`;
    }

    // Acharya events (appearance/disappearance) - show names without highlight
    let acharyaBanner = '';
    if (acharyaEvents.length > 0) {
        const acharyaNames = acharyaEvents.map(e => getName(e)).join(' · ');
        acharyaBanner = `<div class="text-center py-1.5 text-sm opacity-70 border-b border-base-200/50 no-print">${acharyaNames}</div>`;
    }

    // Количество питающихся — детальная разбивка для дневного вида
    const eatingDetailed = formatEatingDetailed(dateStr);

    container.innerHTML = `
        <div class="print-only print-header">${getPrintHeader(dateText, extraInfo)}</div>
        <div class="rounded-xl shadow-sm overflow-hidden ${isToday ? 'ring-2 ring-offset-2' : ''}" style="${styles.bg}">
            ${holidayBanner}
            ${acharyaBanner}

            <div class="p-4 border-b border-base-200/50 no-print" style="${retreat ? `border-left: 4px solid ${retreat.color};` : (majorFestival ? 'border-left: 4px solid #EAB308;' : '')}">
                <div class="flex justify-between items-start">
                    <div>
                        <div class="text-lg font-semibold">${currentDate.getDate()} ${m[currentDate.getMonth()]} ${currentDate.getFullYear()}</div>
                        <div class="text-sm opacity-60">${d[currentDate.getDay()]}</div>
                    </div>
                    <div class="text-right">
                        ${retreat ? `<div class="text-sm font-bold uppercase tracking-wide" style="color: ${retreat.color};">${getName(retreat)}</div>` : `<div class="text-sm opacity-40">${t('no_retreat')}</div>`}
                        ${eatingDetailed}
                    </div>
                </div>
            </div>

            <div class="p-4 space-y-4">
                ${getMealTypes().map((mt, i) => renderMealSection(dateStr, mt, i, dayMenu[mt], isEkadashiDay)).join('')}
            </div>
        </div>
    `;
}

function renderMealSection(dateStr, mealType, index, mealData, isEkadashiDay) {
    const dishes = (mealData?.dishes || []).slice().sort((a, b) => {
        const sa = a.recipe?.category?.sort_order ?? 999;
        const sb = b.recipe?.category?.sort_order ?? 999;
        return sa - sb;
    });
    // Если порции = 50 (дефолт), используем рассчитанное значение
    const portions = (mealData?.portions && mealData.portions !== 50) ? mealData.portions : getEatingTotal(dateStr, mealType);
    const cook = mealData?.cook;
    const isCafe = Layout.currentLocation === 'cafe';

    // Calculate totals (для основной кухни - суммируем порции на человека)
    let totalG = 0, totalMl = 0, totalPcs = 0;
    dishes.forEach(d => {
        const u = d.portion_unit?.toLowerCase();
        if (u === 'г' || u === 'g') totalG += parseFloat(d.portion_size) || 0;
        else if (u === 'мл' || u === 'ml') totalMl += parseFloat(d.portion_size) || 0;
        else if (u === 'шт' || u === 'pcs') totalPcs += parseFloat(d.portion_size) || 0;
    });
    const totals = !isCafe ? [
        totalG > 0 ? `${totalG} ${getUnitShort('g')}` : '',
        totalMl > 0 ? `${totalMl} ${getUnitShort('ml')}` : '',
        totalPcs > 0 ? `${totalPcs} ${getUnitShort('pcs')}` : ''
    ].filter(Boolean).join(' · ') : '';

    // Для кафе показываем просто "Меню дня" без номера
    const mealTitle = isCafe ? getMealTypeName(mealType) : `${index + 1}. ${getMealTypeName(mealType)}`;

    if (dishes.length === 0) {
        const canEdit = canEditMenu();
        return `
            <div class="p-4 rounded-lg bg-white/40 meal-empty no-print" ${canEdit ? `data-action="open-dish-modal" data-date="${dateStr}" data-meal-type="${mealType}"` : ''} style="${canEdit ? 'cursor: pointer;' : ''}">
                <div class="flex items-center justify-center py-8">
                    <div class="flex items-center gap-3 opacity-40">
                        ${canEdit ? `<svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                        </svg>` : ''}
                        <span class="text-xl font-medium">${mealTitle}</span>
                    </div>
                </div>
            </div>
        `;
    }

    // Блок повара и порций (для кафе - ничего не показываем, без права edit_menu - только чтение)
    const canEdit = canEditMenu();
    const controlsHtml = isCafe ? `` : (canEdit ? `
            <div class="flex items-center gap-4 mb-3 p-2 bg-base-100 rounded-lg no-print">
                <div class="flex items-center gap-2 flex-1">
                    <span class="text-sm opacity-60">${t('cook')}:</span>
                    <select class="select select-sm select-bordered flex-1" data-action="update-meal-cook" data-date="${dateStr}" data-meal-type="${mealType}">
                        <option value="">— ${t('select_cook')} —</option>
                        ${cooks.map(c => `<option value="${c.id}" ${mealData?.cook_id === c.id ? 'selected' : ''}>${getPersonName(c)}</option>`).join('')}
                    </select>
                </div>
                <div class="flex items-center gap-1">
                    <input type="number"
                           class="input input-sm input-bordered w-20 text-center"
                           value="${portions}"
                           min="1"
                           data-action="update-meal-portions" data-date="${dateStr}" data-meal-type="${mealType}"
                    />
                    <span class="text-sm opacity-60">${t('persons')}</span>
                </div>
                ${totalG > 0 ? `<span class="text-sm opacity-60">х${totalG} ${getUnitShort('g')}</span>` : ''}
            </div>
            <div class="print-only print-meal-info">
                ${t('cook')}:&nbsp;<strong>${getPersonName(cook) || '—'}</strong> · ${t('portions')}:&nbsp;<strong>${portions}</strong>${totalG > 0 ? ` · х${totalG} ${getUnitShort('g')}` : ''}
            </div>
    ` : `
            <div class="flex items-center gap-4 mb-3 p-2 bg-base-100 rounded-lg text-sm opacity-70">
                <span>${t('cook')}: <strong>${getPersonName(cook) || '—'}</strong></span>
                <span>${t('portions')}: <strong>${portions}</strong></span>
                ${totalG > 0 ? `<span>х${totalG} ${getUnitShort('g')}</span>` : ''}
            </div>
    `);

    return `
        <div class="p-4 rounded-lg bg-white/70">
            <div class="flex justify-between items-center mb-3 pb-2 border-b border-base-300/50">
                <div class="flex items-center gap-3">
                    <span class="font-bold text-xl">${mealTitle}</span>
                    ${totals ? `<span class="text-base opacity-60">${totals}</span>` : ''}
                </div>
                <div class="flex items-center gap-1">
                    ${dishes.length > 0 ? `
                    <button class="btn btn-ghost btn-md btn-square opacity-50 hover:opacity-100 no-print"
                            data-action="open-meal-details-modal" data-date="${dateStr}" data-meal-type="${mealType}"
                            title="${t('view_details')}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
                        </svg>
                    </button>
                    ` : ''}
                    ${canEdit ? `
                    <button class="btn btn-ghost btn-md btn-square opacity-50 hover:opacity-100 no-print" data-action="open-dish-modal" data-date="${dateStr}" data-meal-type="${mealType}">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
                        </svg>
                    </button>
                    ` : ''}
                </div>
            </div>

            ${controlsHtml}

            <div class="space-y-2">
                ${dishes.map(dish => {
                    const recipe = dish.recipe;
                    if (!recipe) return '';
                    const notEkadashiWarning = isEkadashiDay && !recipe.ekadashi;
                    const categoryName = recipe.category ? getName(recipe.category) : '';

                    // Итого на все порции
                    const dpu = dish.portion_unit?.toLowerCase();
                    const dishTotal = (dish.portion_size || 0) * portions;
                    const dishTotalStr = dish.portion_size ? (
                        (dpu === 'г' || dpu === 'g') ? `${parseFloat((dishTotal / 1000).toFixed(1))} ${getUnitShort('kg')}` :
                        (dpu === 'мл' || dpu === 'ml') ? `${parseFloat((dishTotal / 1000).toFixed(1))} ${getUnitShort('l')}` :
                        `${dishTotal} ${getUnitShort(dish.portion_unit)}`
                    ) : '';

                    // Редактируемое количество (если есть права), иначе — бейдж
                    const quantityHtml = canEdit ? `
                        <div class="join no-print">
                            <input type="number"
                                   class="input input-sm input-bordered join-item w-16 text-center"
                                   value="${dish.portion_size || ''}"
                                   min="0"
                                   step="0.5"
                                   data-action="update-dish-quantity" data-dish-id="${dish.id}"
                            />
                            <span class="btn btn-sm join-item no-animation pointer-events-none bg-base-200">${getUnitShort(dish.portion_unit)}</span>
                        </div>
                        ${dishTotalStr ? `<span class="text-sm opacity-50 no-print whitespace-nowrap">= ${dishTotalStr}</span>` : ''}
                        <span class="hidden print:inline badge badge-lg">${dish.portion_size || ''} ${getUnitShort(dish.portion_unit)}${dishTotalStr ? ` = ${dishTotalStr}` : ''}</span>
                    ` : `<span class="badge badge-lg">${dish.portion_size ? `${dish.portion_size} ${getUnitShort(dish.portion_unit)} = ${dishTotalStr}` : ''}</span>`;

                    return `
                        <div class="flex justify-between items-center py-2 border-b border-base-300 last:border-0 ${notEkadashiWarning ? 'bg-error/10 -mx-2 px-2 rounded' : ''}">
                            <div>
                                <a href="recipe.html?id=${recipe.id}" class="hover:text-primary font-medium text-base">${getName(recipe)}</a>
                                <span class="text-xs opacity-40 ml-2">${categoryName}</span>
                                ${notEkadashiWarning ? `<span class="text-xs text-error ml-2">⚠ ${t('ekadashi_warning')}</span>` : ''}
                            </div>
                            <div class="flex items-center gap-2">
                                ${quantityHtml}
                                ${canEdit ? `
                                <button class="btn btn-ghost btn-sm btn-square text-error/60 hover:text-error hover:bg-error/10 no-print" data-action="remove-dish" data-date="${dateStr}" data-meal-type="${mealType}" data-dish-id="${dish.id}">
                                    <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderWeek() {
    const grid = Layout.$('#weekGrid');
    const today = formatDate(new Date());
    const m = getMonthNames();
    const d = getDayNames();
    const canEdit = canEditMenu();

    // Генерируем массив дней недели
    const days = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(currentWeekStart);
        date.setDate(date.getDate() + i);
        return date;
    });

    // Print header
    const weekEnd = days[6];
    const printHeader = Layout.$('#weekPrintHeader');
    if (printHeader) {
        printHeader.innerHTML = getPrintHeader(`${currentWeekStart.getDate()} – ${weekEnd.getDate()} ${m[weekEnd.getMonth()]} ${weekEnd.getFullYear()}`);
    }

    grid.innerHTML = days.map(date => {
        const dateStr = formatDate(date);
        const dayMenu = menuData[dateStr] || {};
        const isEkadashiDay = isEkadashi(dateStr);
        const majorFestival = getMajorFestival(dateStr);
        const acharyaEvents = getAcharyaEvents(dateStr);
        const retreat = getRetreat(dateStr);
        const isToday = dateStr === today;
        const styles = getDayStyles(retreat, majorFestival, isEkadashiDay);

        // Holiday label for header
        let holidayLine = '';
        if (majorFestival) {
            holidayLine = `<div class="text-xs text-yellow-700 font-medium mt-1">${getName(majorFestival)}</div>`;
        } else if (isEkadashiDay) {
            holidayLine = `<div class="text-xs text-amber-600 mt-1">${t('ekadashi')}</div>`;
        }

        // Acharya events
        let acharyaLine = '';
        if (acharyaEvents.length > 0) {
            acharyaLine = `<div class="mt-1 text-xs opacity-60 truncate">${acharyaEvents.map(e => getName(e)).join(' · ')}</div>`;
        }

        return `
            <div class="rounded-xl shadow-sm overflow-hidden flex flex-col ${isToday ? 'ring-2 ring-offset-2' : ''}" style="${styles.bg}">
                <div class="p-3 border-b border-base-200" style="${styles.header}">
                    <div class="flex justify-between items-start">
                        <div>
                            <div class="font-semibold">${date.getDate()} ${m[date.getMonth()]}, <span class="font-normal opacity-60">${d[date.getDay()]}</span></div>
                            ${holidayLine}
                        </div>
                        ${canEdit ? `
                        <button class="btn btn-ghost btn-sm btn-square opacity-50 hover:opacity-100 no-print" data-action="open-day-detail" data-date="${dateStr}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                        </button>
                        ` : ''}
                    </div>
                    ${retreat ? `<div class="mt-1 text-xs font-bold uppercase tracking-wide" style="color: ${retreat.color};">${getName(retreat)}</div>` : ''}
                    ${formatEatingLine(dateStr, 'text-xs text-gray-500 font-medium mt-1')}
                    ${acharyaLine}
                </div>

                <div class="p-3 space-y-2">
                    ${getMealTypes().map((mt, i) => {
                        const meal = dayMenu[mt];
                        if (!meal?.dishes?.length) {
                            return '';
                        }
                        const isCafe = Layout.currentLocation === 'cafe';
                        const dishesText = meal.dishes.map(d => {
                            const name = getName(d.recipe);
                            const portion = d.portion_size ? `${d.portion_size}${getUnitShort(d.portion_unit)}` : '';
                            const link = d.recipe?.id ? `<a href="recipe.html?id=${d.recipe.id}" class="hover:text-primary hover:underline">${name}</a>` : name;
                            return portion ? `${link} (${portion})` : link;
                        }).join(', ');
                        // Для кафе: без номера, повара и порций
                        if (isCafe) {
                            return `
                                <div class="text-sm py-1">
                                    <div class="text-xs leading-tight">${dishesText}</div>
                                </div>
                            `;
                        }
                        return `
                            <div class="text-sm py-1">
                                <div class="flex items-center">
                                    <span class="w-4 text-center font-medium">${i + 1}.</span>
                                    <span class="ml-1 flex-1 truncate font-medium">${getPersonName(meal.cook) || '—'}</span>
                                    <span class="font-medium ml-2">${meal.portions}</span>
                                </div>
                                <div class="text-xs opacity-60 ml-5 leading-tight">${dishesText}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderPeriod() {
    const grid = Layout.$('#periodGrid');
    if (!periodStart || !periodEnd) {
        grid.innerHTML = '';
        return;
    }

    const today = formatDate(new Date());
    const m = getMonthNames();
    const d = getDayNames();
    const canEdit = canEditMenu();

    // Генерируем массив дней периода
    const dayCount = Math.ceil((periodEnd - periodStart) / (1000 * 60 * 60 * 24)) + 1;
    const days = Array.from({ length: dayCount }, (_, i) => {
        const date = new Date(periodStart);
        date.setDate(date.getDate() + i);
        return date;
    });

    // Print header
    const printHeader = Layout.$('#periodPrintHeader');
    if (printHeader) {
        const first = days[0];
        const last = days[days.length - 1];
        printHeader.innerHTML = getPrintHeader(`${first.getDate()} ${m[first.getMonth()]} – ${last.getDate()} ${m[last.getMonth()]} ${last.getFullYear()}`);
    }

    // Рендерим карточки в том же формате, что и renderWeek
    grid.innerHTML = days.map(date => {
        const dateStr = formatDate(date);
        const dayMenu = menuData[dateStr] || {};
        const isEkadashiDay = isEkadashi(dateStr);
        const majorFestival = getMajorFestival(dateStr);
        const acharyaEvents = getAcharyaEvents(dateStr);
        const retreat = getRetreat(dateStr);
        const isToday = dateStr === today;
        const styles = getDayStyles(retreat, majorFestival, isEkadashiDay);

        let holidayLine = '';
        if (majorFestival) {
            holidayLine = `<div class="text-xs text-yellow-700 font-medium mt-1">${getName(majorFestival)}</div>`;
        } else if (isEkadashiDay) {
            holidayLine = `<div class="text-xs text-amber-600 mt-1">${t('ekadashi')}</div>`;
        }

        let acharyaLine = '';
        if (acharyaEvents.length > 0) {
            acharyaLine = `<div class="mt-1 text-xs opacity-60 truncate">${acharyaEvents.map(e => getName(e)).join(' · ')}</div>`;
        }

        return `
            <div class="rounded-xl shadow-sm overflow-hidden flex flex-col ${isToday ? 'ring-2 ring-offset-2' : ''}" style="${styles.bg}">
                <div class="p-3 border-b border-base-200" style="${styles.header}">
                    <div class="flex justify-between items-start">
                        <div>
                            <div class="font-semibold">${date.getDate()} ${m[date.getMonth()]}, <span class="font-normal opacity-60">${d[date.getDay()]}</span></div>
                            ${holidayLine}
                        </div>
                        ${canEdit ? `
                        <button class="btn btn-ghost btn-sm btn-square opacity-50 hover:opacity-100 no-print" data-action="open-day-detail" data-date="${dateStr}">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                        </button>
                        ` : ''}
                    </div>
                    ${retreat ? `<div class="mt-1 text-xs font-bold uppercase tracking-wide" style="color: ${retreat.color};">${getName(retreat)}</div>` : ''}
                    ${formatEatingLine(dateStr, 'text-xs text-gray-500 font-medium mt-1')}
                    ${acharyaLine}
                </div>

                <div class="p-3 space-y-2">
                    ${getMealTypes().map((mt, i) => {
                        const meal = dayMenu[mt];
                        if (!meal?.dishes?.length) {
                            return '';
                        }
                        const isCafe = Layout.currentLocation === 'cafe';
                        const dishesText = meal.dishes.map(d => {
                            const name = getName(d.recipe);
                            const portion = d.portion_size ? `${d.portion_size}${getUnitShort(d.portion_unit)}` : '';
                            const link = d.recipe?.id ? `<a href="recipe.html?id=${d.recipe.id}" class="hover:text-primary hover:underline">${name}</a>` : name;
                            return portion ? `${link} (${portion})` : link;
                        }).join(', ');
                        if (isCafe) {
                            return `
                                <div class="text-sm py-1">
                                    <div class="text-xs leading-tight">${dishesText}</div>
                                </div>
                            `;
                        }
                        return `
                            <div class="text-sm py-1">
                                <div class="flex items-center">
                                    <span class="w-4 text-center font-medium">${i + 1}.</span>
                                    <span class="ml-1 flex-1 truncate font-medium">${getPersonName(meal.cook) || '—'}</span>
                                    <span class="font-medium ml-2">${meal.portions}</span>
                                </div>
                                <div class="text-xs opacity-60 ml-5 leading-tight">${dishesText}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }).join('');
}

function renderMonth() {
    const grid = Layout.$('#monthGrid');
    const dayNamesContainer = Layout.$('#monthDayNames');
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const m = getMonthNames();
    const d = getDayNamesMon();
    const today = formatDate(new Date());

    // Print header
    const printHeader = Layout.$('#monthPrintHeader');
    if (printHeader) {
        printHeader.innerHTML = getPrintHeader(`${m[month]} ${year}`);
    }

    // Названия дней недели
    dayNamesContainer.innerHTML = d.map(name => `<div class="text-center text-sm font-medium opacity-60 py-2">${name}</div>`).join('');

    // Рассчитываем дни месяца
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    let startDayOfWeek = firstDay.getDay();
    startDayOfWeek = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;

    // Пустые ячейки + дни месяца
    const days = [
        ...Array(startDayOfWeek).fill(null),
        ...Array.from({ length: lastDay.getDate() }, (_, i) => new Date(year, month, i + 1))
    ];

    grid.innerHTML = days.map(date => {
        if (!date) return '<div class="min-h-20 bg-base-200/20 rounded"></div>';

        const dateStr = formatDate(date);
        const isEkadashiDay = isEkadashi(dateStr);
        const majorFestival = getMajorFestival(dateStr);
        const acharyaEvents = getAcharyaEvents(dateStr);
        const retreat = getRetreat(dateStr);
        const isToday = dateStr === today;
        const dayMenu = menuData[dateStr] || {};

        // Background styles: retreat > major festival > ekadashi > default
        let bgStyle = 'background-color: white;';
        let borderStyle = '';
        if (retreat) {
            bgStyle = `background-color: ${retreat.color}20;`;
            borderStyle = `border-left: 3px solid ${retreat.color};`;
        } else if (majorFestival) {
            bgStyle = 'background-color: #FEF9C3;';
            borderStyle = 'border-left: 3px solid #EAB308;';
        } else if (isEkadashiDay) {
            bgStyle = 'background-color: #FFFBEB;';
        }

        // Holiday indicator
        let holidayIndicator = '';
        if (majorFestival) {
            holidayIndicator = '<span class="text-xs font-medium text-yellow-700">★</span>';
        } else if (isEkadashiDay) {
            holidayIndicator = '<span class="text-xs font-medium text-amber-600">э</span>';
        }

        const isCafe = Layout.currentLocation === 'cafe';
        const mealLines = isCafe ? '' : getMealTypes().map((mt, i) => {
            const meal = dayMenu[mt];
            if (!meal?.dishes?.length) return null;
            const cookName = getPersonName(meal.cook).split(' ')[0];
            return `<div class="text-xs truncate"><span class="opacity-50">${i + 1}.</span> <span class="no-print">${cookName} – </span>${meal.portions}</div>`;
        }).filter(Boolean).join('');

        // Holiday/acharya names
        let holidayName = '';
        if (majorFestival) {
            holidayName = `<div class="text-xs font-bold truncate leading-tight mb-0.5 text-yellow-700">${getName(majorFestival)}</div>`;
        }
        let acharyaName = '';
        if (acharyaEvents.length > 0) {
            acharyaName = `<div class="text-xs truncate leading-tight mb-0.5 opacity-60">${acharyaEvents.map(e => getName(e)).join(', ')}</div>`;
        }

        // Количество едоков
        const eatingLine = formatEatingLine(dateStr, 'text-xs text-gray-500 font-medium');

        return `
            <div class="min-h-20 rounded shadow-sm p-1.5 ${isToday ? 'ring-2' : ''} cursor-pointer hover:opacity-80 flex flex-col" style="${bgStyle} ${borderStyle}" data-action="open-day-detail" data-date="${dateStr}">
                <div class="flex justify-between items-start mb-1">
                    <span class="font-bold text-sm ${isToday ? 'text-primary' : ''}">${date.getDate()}</span>
                    ${holidayIndicator}
                </div>
                ${eatingLine}
                ${retreat ? `<div class="text-xs font-bold truncate leading-tight mb-1" style="color: ${retreat.color};">${getName(retreat)}</div>` : ''}
                ${holidayName}
                ${acharyaName}
                <div class="flex-1 space-y-0.5">${mealLines}</div>
            </div>
        `;
    }).join('');
}

// ==================== VIEW NAVIGATION ====================
// Переключение UI вида без загрузки данных
function switchViewUI(view) {
    // Show/hide nav groups and buttons
    Layout.$('#dayNav').classList.toggle('hidden', view !== 'day');
    Layout.$('#dayBtn').classList.toggle('hidden', view === 'day');
    Layout.$('#weekNav').classList.toggle('hidden', view !== 'week');
    Layout.$('#weekBtn').classList.toggle('hidden', view === 'week');
    Layout.$('#monthNav').classList.toggle('hidden', view !== 'month');
    Layout.$('#monthBtn').classList.toggle('hidden', view === 'month');
    Layout.$('#periodNav').classList.toggle('hidden', view !== 'period');
    Layout.$('#periodBtn').classList.toggle('hidden', view === 'period');

    // Show/hide views
    Layout.$('#dayView').classList.toggle('hidden', view !== 'day');
    Layout.$('#weekView').classList.toggle('hidden', view !== 'week');
    Layout.$('#monthView').classList.toggle('hidden', view !== 'month');
    Layout.$('#periodView').classList.toggle('hidden', view !== 'period');

    // Show/hide template button (only in week/month/period view)
    const showTemplateButtons = view === 'week' || view === 'month' || view === 'period';
    Layout.$('#applyTemplateBtn')?.classList.toggle('hidden', !showTemplateButtons);
}

function setView(view) {
    currentView = view;
    switchViewUI(view);

    // Для периода: при первом открытии — ставим даты текущей недели
    if (view === 'period') {
        if (!periodStart || !periodEnd) {
            periodStart = new Date(currentWeekStart);
            periodEnd = new Date(currentWeekStart);
            periodEnd.setDate(periodEnd.getDate() + 6);
            Layout.$('#periodStartDate').value = formatDate(periodStart);
            Layout.$('#periodEndDate').value = formatDate(periodEnd);
        }
    }

    loadMenuData();
    updateHash();
}

function prevPeriod() {
    if (currentView === 'day') {
        currentDate.setDate(currentDate.getDate() - 1);
    } else if (currentView === 'week') {
        currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    } else {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
    }
    loadMenuData();
    updateHash();
}

function nextPeriod() {
    if (currentView === 'day') {
        currentDate.setDate(currentDate.getDate() + 1);
    } else if (currentView === 'week') {
        currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    } else {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
    }
    loadMenuData();
    updateHash();
}

function goToToday() {
    currentDate = new Date();
    loadMenuData();
    updateHash();
}

function onPeriodDatesChange() {
    const startVal = Layout.$('#periodStartDate').value;
    const endVal = Layout.$('#periodEndDate').value;
    if (!startVal || !endVal) return;

    periodStart = parseLocalDate(startVal);
    periodEnd = parseLocalDate(endVal);

    if (periodEnd < periodStart) {
        periodEnd = new Date(periodStart);
        Layout.$('#periodEndDate').value = formatDate(periodEnd);
    }

    loadMenuData();
    updateHash();
}

function openDayDetail(dateStr) {
    currentDate = DateUtils.parseDate(dateStr);
    setView('day');
}

// ==================== MEAL EDITING ====================
async function updateMealPortions(dateStr, mealType, value) {
    const portions = parseInt(value);
    if (portions < 1) return;

    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const mealData = menuData[dateStr]?.[mealType];

    if (mealData?.id) {
        await Layout.db
            .from('menu_meals')
            .update({ portions })
            .eq('id', mealData.id);
        mealData.portions = portions;
    } else {
        const { data } = await Layout.db
            .from('menu_meals')
            .upsert({
                location_id: locationId,
                date: dateStr,
                meal_type: mealType,
                portions
            }, { onConflict: 'location_id,date,meal_type' })
            .select()
            .single();

        if (data) {
            if (!menuData[dateStr]) menuData[dateStr] = {};
            if (!menuData[dateStr][mealType]) menuData[dateStr][mealType] = { dishes: [] };
            menuData[dateStr][mealType].id = data.id;
            menuData[dateStr][mealType].portions = portions;
        }
    }
}

async function updateMealCook(dateStr, mealType, cookId) {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const mealData = menuData[dateStr]?.[mealType];

    if (mealData?.id) {
        await Layout.db
            .from('menu_meals')
            .update({ cook_id: cookId || null })
            .eq('id', mealData.id);

        mealData.cook_id = cookId || null;
        mealData.cook = getCook(cookId);
    }

    render();
}

async function removeDish(dateStr, mealType, dishId) {
    await Layout.db
        .from('menu_dishes')
        .delete()
        .eq('id', dishId);

    const mealData = menuData[dateStr]?.[mealType];
    if (mealData) {
        mealData.dishes = mealData.dishes.filter(d => d.id !== dishId);
    }

    render();
}

async function updateDishQuantity(dishId, value) {
    const quantity = parseFloat(value) || 0;

    await Layout.db
        .from('menu_dishes')
        .update({ portion_size: quantity })
        .eq('id', dishId);

    // Обновляем локальные данные
    for (const dateStr in menuData) {
        for (const mealType in menuData[dateStr]) {
            const dish = menuData[dateStr][mealType].dishes?.find(d => d.id === dishId);
            if (dish) {
                dish.portion_size = quantity;
                return;
            }
        }
    }
}

// ==================== DISH MODAL ====================
function openDishModal(dateStr, mealType) {
    selectedDate = dateStr;
    selectedMealType = mealType;
    selectedRecipe = null;

    const date = DateUtils.parseDate(dateStr);
    const m = getMonthNames();
    const d = getDayNames();

    Layout.$('#dishModalTitle').textContent = `${getMealTypeName(mealType)} · ${d[date.getDay()]}, ${date.getDate()} ${m[date.getMonth()]}`;

    // Reset form
    Layout.$('#recipeSearch').value = '';
    Layout.$('#recipeDropdown').classList.add('hidden');
    Layout.$('#selectedRecipeDisplay').classList.add('hidden');
    Layout.$('#portionSize').value = 200;
    Layout.$('#portionUnit').textContent = t('unit_g');
    Layout.$('#saveDishBtn').disabled = true;
    Layout.$('#totalCalculation').textContent = '—';

    // Reset tabs
    Layout.$('#tabSearch').classList.add('tab-active');
    Layout.$('#tabBrowse').classList.remove('tab-active');
    Layout.$('#searchTab').classList.remove('hidden');
    Layout.$('#browseTab').classList.add('hidden');
    currentCategory = 'all';

    // Build category buttons
    buildCategoryButtons();

    dishModal.showModal();
}

function buildCategoryButtons() {
    const container = Layout.$('#categoryButtons');
    container.innerHTML = `
        <button type="button" class="btn btn-sm filter-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all" data-action="filter-by-category" data-category="all">${t('filter_all')}</button>
        ${categories.map(cat => `
            <button type="button" class="btn btn-sm filter-btn ${currentCategory === cat.slug ? 'active' : ''}" data-cat="${cat.slug}" style="--cat-color: ${cat.color};" data-action="filter-by-category" data-category="${cat.slug}">${getName(cat)}</button>
        `).join('')}
    `;
}

function switchRecipeTab(tab) {
    if (tab === 'search') {
        Layout.$('#searchTab').classList.remove('hidden');
        Layout.$('#browseTab').classList.add('hidden');
        Layout.$('#tabSearch').classList.add('tab-active');
        Layout.$('#tabBrowse').classList.remove('tab-active');
    } else {
        Layout.$('#searchTab').classList.add('hidden');
        Layout.$('#browseTab').classList.remove('hidden');
        Layout.$('#tabSearch').classList.remove('tab-active');
        Layout.$('#tabBrowse').classList.add('tab-active');
        filterByCategory(currentCategory);
    }
}

function filterRecipes(query) {
    const dropdown = Layout.$('#recipeDropdown');

    if (query.length < 1) {
        dropdown.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const isEkadashiDay = isEkadashi(selectedDate);

    const filtered = recipes.filter(r =>
        r.name_ru?.toLowerCase().includes(q) ||
        r.name_en?.toLowerCase().includes(q) ||
        r.name_hi?.includes(query) ||
        r.translit?.toLowerCase().includes(q)
    ).slice(0, 8);

    if (filtered.length === 0) {
        dropdown.innerHTML = `<div class="p-3 text-sm opacity-50">${t('nothing_found')}</div>`;
    } else {
        dropdown.innerHTML = filtered.map(r => `
            <div class="p-3 hover:bg-base-200 cursor-pointer border-b border-base-200 last:border-0 ${isEkadashiDay && !r.ekadashi ? 'opacity-50' : ''}" data-action="select-recipe" data-id="${r.id}">
                <div class="font-medium flex items-center gap-2">
                    ${getName(r)}
                    ${r.ekadashi ? '<span class="text-xs text-amber-600">э</span>' : ''}
                    ${isEkadashiDay && !r.ekadashi ? '<span class="text-xs text-error">⚠</span>' : ''}
                </div>
                <div class="text-xs opacity-50">${r.name_en || ''}</div>
            </div>
        `).join('');
    }

    dropdown.classList.remove('hidden');
}

function showRecipeDropdown() {
    const input = Layout.$('#recipeSearch');
    if (input.value.length >= 1) {
        filterRecipes(input.value);
    }
}

function filterByCategory(category) {
    currentCategory = category;
    const list = Layout.$('#categoryRecipeList');
    const isEkadashiDay = isEkadashi(selectedDate);

    // Update buttons
    Layout.$$('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.cat === category);
    });

    let filtered = recipes;
    if (category !== 'all') {
        filtered = recipes.filter(r => r.category?.slug === category);
    }

    if (isEkadashiDay) {
        filtered = [...filtered].sort((a, b) => (b.ekadashi ? 1 : 0) - (a.ekadashi ? 1 : 0));
    }

    if (filtered.length === 0) {
        list.innerHTML = `<div class="p-3 text-sm opacity-50 text-center">${t('nothing_found')}</div>`;
    } else {
        list.innerHTML = filtered.map(r => `
            <div class="p-3 hover:bg-base-200 cursor-pointer border-b border-base-200 last:border-0 ${isEkadashiDay && !r.ekadashi ? 'opacity-50' : ''}" data-action="select-recipe" data-id="${r.id}">
                <div class="font-medium flex items-center gap-2">
                    ${getName(r)}
                    ${r.ekadashi ? '<span class="text-xs text-amber-600">э</span>' : ''}
                    ${isEkadashiDay && !r.ekadashi ? '<span class="text-xs text-error">⚠</span>' : ''}
                </div>
                <div class="text-xs opacity-50">${r.name_en || ''} · ${r.category ? getName(r.category) : ''}</div>
            </div>
        `).join('');
    }
}

function selectRecipe(recipeId) {
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) {
        console.error('Recipe not found:', recipeId);
        return;
    }

    selectedRecipe = recipe;

    Layout.$('#searchTab').classList.add('hidden');
    Layout.$('#browseTab').classList.add('hidden');
    Layout.$('#recipeDropdown').classList.add('hidden');
    Layout.$('#selectedRecipeDisplay').classList.remove('hidden');
    Layout.$('#selectedRecipeName').textContent = getName(recipe);
    Layout.$('#selectedRecipeNameEn').textContent = recipe.name_en || '';

    // Set portion size from recipe
    Layout.$('#portionSize').value = recipe.portion_amount || 200;
    Layout.$('#portionUnit').textContent = getUnitShort(recipe.portion_unit || 'g');

    const saveBtn = document.getElementById('saveDishBtn');
    if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.removeAttribute('disabled');
        saveBtn.classList.remove('btn-disabled');
        saveBtn.style.pointerEvents = 'auto';
        saveBtn.style.opacity = '1';
    }
    updateTotalCalculation();
}

function clearSelectedRecipe() {
    selectedRecipe = null;

    if (Layout.$('#tabSearch').classList.contains('tab-active')) {
        Layout.$('#searchTab').classList.remove('hidden');
        Layout.$('#recipeSearch').value = '';
    } else {
        Layout.$('#browseTab').classList.remove('hidden');
    }
    Layout.$('#selectedRecipeDisplay').classList.add('hidden');
    Layout.$('#saveDishBtn').disabled = true;
}

function updateTotalCalculation() {
    const size = parseInt(Layout.$('#portionSize').value) || 0;
    const unit = Layout.$('#portionUnit').textContent;
    Layout.$('#totalCalculation').textContent = `${size} ${unit} ${t('per_person')}`;
}

Layout.$('#portionSize')?.addEventListener('input', updateTotalCalculation);

async function saveDish() {
    if (!selectedRecipe) return;

    const portionSize = parseInt(Layout.$('#portionSize').value) || 200;
    const portionUnit = Layout.$('#portionUnit').textContent;
    const locationId = getCurrentLocation()?.id;

    if (!locationId) return;

    // Check ekadashi warning
    if (isEkadashi(selectedDate) && !selectedRecipe.ekadashi) {
        if (!confirm(`⚠️ ${selectedDate} — ${t('confirm_ekadashi')}`)) {
            return;
        }
    }

    // Check if already added
    const mealData = menuData[selectedDate]?.[selectedMealType];
    if (mealData?.dishes?.some(d => d.recipe_id === selectedRecipe.id)) {
        alert(t('already_added'));
        return;
    }

    // Ensure meal exists
    let mealId = mealData?.id;
    const defaultPortions = getEatingTotal(selectedDate, selectedMealType);
    if (!mealId) {
        const { data: newMeal } = await Layout.db
            .from('menu_meals')
            .upsert({
                location_id: locationId,
                date: selectedDate,
                meal_type: selectedMealType,
                portions: defaultPortions
            }, { onConflict: 'location_id,date,meal_type' })
            .select()
            .single();

        if (!newMeal) {
            alert(t('error'));
            return;
        }
        mealId = newMeal.id;
    }

    // Add dish
    const { data: newDish, error } = await Layout.db
        .from('menu_dishes')
        .insert({
            meal_id: mealId,
            recipe_id: selectedRecipe.id,
            portion_size: portionSize,
            portion_unit: portionUnit
        })
        .select('*, recipe:recipes(*, category:recipe_categories(*))')
        .single();

    if (error) {
        console.error('Error adding dish:', error);
        alert(t('error'));
        return;
    }

    // Update local data
    if (!menuData[selectedDate]) menuData[selectedDate] = {};
    if (!menuData[selectedDate][selectedMealType]) {
        menuData[selectedDate][selectedMealType] = { id: mealId, portions: defaultPortions, dishes: [] };
    }
    menuData[selectedDate][selectedMealType].dishes.push({
        id: newDish.id,
        recipe_id: newDish.recipe_id,
        recipe: newDish.recipe,
        portion_size: newDish.portion_size,
        portion_unit: newDish.portion_unit
    });

    dishModal.close();
    render();
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
    const dropdown = Layout.$('#recipeDropdown');
    const input = Layout.$('#recipeSearch');
    if (dropdown && input && !dropdown.contains(e.target) && e.target !== input) {
        dropdown.classList.add('hidden');
    }
});

// ==================== TEMPLATES ====================
async function loadTemplates() {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const { data } = await Layout.db
        .from('menu_templates')
        .select(`
            *,
            meals:menu_template_meals(
                *,
                dishes:menu_template_dishes(*, recipe:recipes(*))
            )
        `)
        .eq('location_id', locationId)
        .order('created_at', { ascending: false });

    templates = data || [];
}

function openSaveTemplateModal() {
    // Set default dates based on current view
    let fromDate, toDate;
    if (currentView === 'week') {
        fromDate = formatDate(currentWeekStart);
        const weekEnd = new Date(currentWeekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        toDate = formatDate(weekEnd);
    } else {
        fromDate = formatDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1));
        toDate = formatDate(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0));
    }

    Layout.$('#templateFromDate').value = fromDate;
    Layout.$('#templateToDate').value = toDate;
    Layout.$('#newTemplateName').value = '';
    updateTemplateDatePreview();
    saveTemplateModal.showModal();
}

function updateTemplateDatePreview() {
    const fromDate = Layout.$('#templateFromDate').value;
    const toDate = Layout.$('#templateToDate').value;

    if (!fromDate || !toDate) {
        Layout.$('#templateDatePreview').classList.add('hidden');
        return;
    }

    const from = parseLocalDate(fromDate);
    const to = parseLocalDate(toDate);
    const dayCount = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    if (dayCount < 1) {
        Layout.$('#templateDatePreview').classList.add('hidden');
        return;
    }

    Layout.$('#templateDayCountText').textContent = pluralizeDays(dayCount);
    Layout.$('#templateDatePreview').classList.remove('hidden');
}

async function saveAsTemplate() {
    const saveBtn = document.querySelector('#saveTemplateModal .btn-primary');
    if (saveBtn.disabled) return;

    const name = Layout.$('#newTemplateName').value.trim();
    const fromDate = Layout.$('#templateFromDate').value;
    const toDate = Layout.$('#templateToDate').value;

    if (!name) {
        alert(t('enter_template_name'));
        return;
    }

    if (!fromDate || !toDate) {
        alert(t('select_dates'));
        return;
    }

    const from = parseLocalDate(fromDate);
    const to = parseLocalDate(toDate);
    const dayCount = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    if (dayCount < 1) {
        alert(t('invalid_date_range'));
        return;
    }

    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    saveBtn.disabled = true;
    saveBtn.textContent = '...';

    try {
        // Create template
        const { data: template, error: templateError } = await Layout.db
            .from('menu_templates')
            .insert({
                location_id: locationId,
                name_ru: name,
                day_count: dayCount
            })
            .select()
            .single();

        if (templateError) throw templateError;

        // Copy meals from the date range
        for (let dayOffset = 0; dayOffset < dayCount; dayOffset++) {
            const currentDate = new Date(from);
            currentDate.setDate(currentDate.getDate() + dayOffset);
            const dateStr = formatDate(currentDate);
            const dayNumber = dayOffset + 1;

            const dayMenu = menuData[dateStr];
            if (!dayMenu) continue;

            for (const mealType in dayMenu) {
                const mealData = dayMenu[mealType];
                if (!mealData?.dishes?.length) continue;

                // Create template meal (without cook_id)
                const { data: templateMeal, error: mealError } = await Layout.db
                    .from('menu_template_meals')
                    .insert({
                        template_id: template.id,
                        day_number: dayNumber,
                        meal_type: mealType,
                        portions: mealData.portions || 50
                    })
                    .select()
                    .single();

                if (mealError) throw mealError;

                // Copy dishes
                if (mealData.dishes?.length > 0) {
                    const dishesInsert = mealData.dishes.map((dish, index) => ({
                        template_meal_id: templateMeal.id,
                        recipe_id: dish.recipe_id,
                        portion_size: dish.portion_size,
                        portion_unit: dish.portion_unit,
                        sort_order: index
                    }));

                    await Layout.db
                        .from('menu_template_dishes')
                        .insert(dishesInsert);
                }
            }
        }

        saveTemplateModal.close();
        showSuccess(t('template_saved'), name);
        await loadTemplates();
    } catch (error) {
        console.error('Error saving template:', error);
        alert(t('template_save_error'));
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = t('save');
    }
}

async function openApplyTemplateModal() {
    await loadTemplates();

    // Populate template select
    const select = Layout.$('#templateSelect');
    select.innerHTML = '<option value="">—</option>' +
        templates.map(tmpl => `<option value="${tmpl.id}">${getName(tmpl)} (${pluralizeDays(tmpl.day_count)})</option>`).join('');

    // Set default start date
    const today = new Date();
    Layout.$('#applyStartDate').value = formatDate(today);

    selectedTemplateId = null;
    Layout.$('#applyPreview').classList.add('hidden');
    Layout.$('#overwriteWarning').classList.add('hidden');
    Layout.$('#applyTemplateBtn2').disabled = true;

    applyTemplateModal.showModal();
}

function onTemplateSelected() {
    selectedTemplateId = Layout.$('#templateSelect').value;
    Layout.$('#applyTemplateBtn2').disabled = !selectedTemplateId;
    updateApplyPreview();
}

async function updateApplyPreview() {
    const startDateStr = Layout.$('#applyStartDate').value;
    if (!startDateStr || !selectedTemplateId) {
        Layout.$('#applyPreview').classList.add('hidden');
        return;
    }

    const template = templates.find(t => t.id === selectedTemplateId);
    if (!template) return;

    const startDate = parseLocalDate(startDateStr);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + template.day_count - 1);

    const formatDisplayDate = d => d.toLocaleDateString(Layout.currentLang === 'ru' ? 'ru-RU' : 'en-US', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    });

    Layout.$('#applyDateRange').textContent = `${formatDisplayDate(startDate)} — ${formatDisplayDate(endDate)}`;
    Layout.$('#applyPreview').classList.remove('hidden');

    // Check for existing menu
    await checkExistingMenuForApply(startDateStr, template.day_count);
}

async function checkExistingMenuForApply(startDateStr, dayCount) {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const startDate = DateUtils.parseDate(startDateStr);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + dayCount - 1);

    const { data: existingMeals } = await Layout.db
        .from('menu_meals')
        .select('id')
        .eq('location_id', locationId)
        .gte('date', startDateStr)
        .lte('date', formatDate(endDate))
        .limit(1);

    Layout.$('#overwriteWarning').classList.toggle('hidden', !existingMeals?.length);
}

// Parse date string as local date (not UTC)
function parseLocalDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

async function applySelectedTemplate() {
    const applyBtn = Layout.$('#applyTemplateBtn2');
    if (applyBtn.disabled) return;

    if (!selectedTemplateId) return;

    const startDateStr = Layout.$('#applyStartDate').value;
    if (!startDateStr) return;

    const template = templates.find(t => t.id === selectedTemplateId);
    if (!template) return;

    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const isCafe = Layout.currentLocation === 'cafe';

    applyBtn.disabled = true;
    applyBtn.textContent = '...';

    try {
        const startDate = parseLocalDate(startDateStr);

        for (let dayOffset = 0; dayOffset < template.day_count; dayOffset++) {
            const targetDate = new Date(startDate);
            targetDate.setDate(targetDate.getDate() + dayOffset);
            const targetDateStr = formatDate(targetDate);
            const dayNumber = dayOffset + 1;

            // Get meals for this day from template
            const dayMeals = (template.meals || []).filter(m => m.day_number === dayNumber);

            for (const templateMeal of dayMeals) {
                // Get portions from eating counts (guests + team)
                let portions = templateMeal.portions || 50;
                if (!isCafe) {
                    portions = getEatingTotal(targetDateStr, templateMeal.meal_type);
                }

                // Delete existing meal for this date/type
                await Layout.db
                    .from('menu_meals')
                    .delete()
                    .eq('location_id', locationId)
                    .eq('date', targetDateStr)
                    .eq('meal_type', templateMeal.meal_type);

                // Create new meal (cook_id is null)
                const { data: newMeal, error: mealError } = await Layout.db
                    .from('menu_meals')
                    .insert({
                        location_id: locationId,
                        date: targetDateStr,
                        meal_type: templateMeal.meal_type,
                        portions: portions,
                        cook_id: null
                    })
                    .select()
                    .single();

                if (mealError) throw mealError;

                // Add dishes
                if (templateMeal.dishes?.length > 0) {
                    const dishesInsert = templateMeal.dishes.map((dish, index) => ({
                        meal_id: newMeal.id,
                        recipe_id: dish.recipe_id,
                        portion_size: dish.portion_size,
                        portion_unit: dish.portion_unit,
                        sort_order: index
                    }));

                    await Layout.db
                        .from('menu_dishes')
                        .insert(dishesInsert);
                }
            }
        }

        applyTemplateModal.close();

        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + template.day_count - 1);
        const formatDisplayDate = d => d.toLocaleDateString(Layout.currentLang === 'ru' ? 'ru-RU' : 'en-US', {
            day: 'numeric', month: 'long', year: 'numeric'
        });
        showSuccess(t('template_applied'), `${formatDisplayDate(startDate)} — ${formatDisplayDate(endDate)}`);

        await loadMenuData();
    } catch (error) {
        console.error('Error applying template:', error);
        alert(t('template_apply_error'));
    } finally {
        applyBtn.disabled = false;
        applyBtn.textContent = t('apply_template');
    }
}

// ==================== MEAL DETAILS ====================
async function loadIngredientsForRecipes(recipeIds) {
    const uncachedIds = recipeIds.filter(id => !ingredientsCache[id]);
    if (uncachedIds.length === 0) return;

    const { data } = await Layout.db
        .from('recipe_ingredients')
        .select('*, products(id, name_ru, name_en, name_hi, unit)')
        .in('recipe_id', uncachedIds)
        .order('sort_order');

    (data || []).forEach(ing => {
        if (!ingredientsCache[ing.recipe_id]) ingredientsCache[ing.recipe_id] = [];
        ingredientsCache[ing.recipe_id].push(ing);
    });
}

async function openMealDetailsModal(dateStr, mealType) {
    selectedMealType = mealType;
    const mealData = menuData[dateStr]?.[mealType];
    if (!mealData?.dishes?.length) return;

    const date = DateUtils.parseDate(dateStr);
    const m = getMonthNames();
    const d = getDayNames();
    const portions = (mealData.portions && mealData.portions !== 50) ? mealData.portions : getEatingTotal(dateStr, mealType);
    const cook = mealData.cook;

    // Заголовки
    Layout.$('#mealDetailsTitle').textContent =
        `${getMealTypeName(mealType)} — ${date.getDate()} ${m[date.getMonth()]} ${date.getFullYear()}`;
    Layout.$('#mealDetailsSubtitle').textContent =
        `${d[date.getDay()]} · ${portions} ${t('persons')}${cook ? ` · ${getPersonName(cook)}` : ''}`;

    // Print header (увеличенный для деталей)
    const loc = getCurrentLocation();
    Layout.$('#mealDetailsPrintHeader').innerHTML = `
        <div class="print-header-left">
            ${LOGO_SVG}
            <div>
                <div class="print-header-title">${t('app_name')}</div>
                <div class="print-header-location">${loc ? getName(loc) : ''}</div>
            </div>
        </div>
        <div class="print-header-right" style="text-align: right;">
            <div style="font-size: 28pt; font-weight: bold; line-height: 1.1;">${getMealTypeName(mealType)}</div>
            <div style="font-size: 18pt; margin-top: 4pt;">${date.getDate()} ${m[date.getMonth()]} ${date.getFullYear()}</div>
            <div style="font-size: 16pt; font-weight: bold; margin-top: 2pt;">${portions} ${t('persons')}</div>
        </div>
    `;

    // Показываем загрузку
    Layout.$('#mealDetailsContent').innerHTML =
        '<div class="flex justify-center py-8"><span class="loading loading-spinner loading-lg"></span></div>';
    mealDetailsModal.showModal();

    // Загружаем ингредиенты и рендерим
    await loadIngredientsForRecipes(mealData.dishes.map(d => d.recipe_id).filter(Boolean));
    renderMealDetailsContent(mealData.dishes, portions);
}

function renderMealDetailsContent(dishes, portions) {
    const container = Layout.$('#mealDetailsContent');

    container.innerHTML = dishes.map(dish => {
        const recipe = dish.recipe;
        if (!recipe) return '';

        const portionSize = dish.portion_size || recipe.portion_amount || 100;
        const portionUnit = dish.portion_unit || 'g';
        const ingredients = ingredientsCache[dish.recipe_id] || [];

        // Пересчёт: базовый выход рецепта -> нужное количество
        const recipeOutput = (recipe.output_amount || 1) * (recipe.output_unit === 'kg' ? 1000 : 1);
        const targetAmount = portions * portionSize;
        const multiplier = recipeOutput > 0 ? targetAmount / recipeOutput : 1;

        // Итого в крупных единицах
        const totalAmount = portionSize * portions;
        const pu = portionUnit?.toLowerCase();
        const totalStr = (pu === 'г' || pu === 'g')
            ? `${parseFloat((totalAmount / 1000).toFixed(1))} ${getUnitShort('kg')}`
            : (pu === 'мл' || pu === 'ml')
                ? `${parseFloat((totalAmount / 1000).toFixed(1))} ${getUnitShort('l')}`
                : `${totalAmount} ${getUnitShort(portionUnit)}`;

        return `
            <div class="border border-base-300 rounded-lg overflow-hidden ingredient-card">
                <div class="bg-base-200 px-4 py-3 flex justify-between items-center">
                    <span class="font-bold text-lg">${getName(recipe)}</span>
                    <span class="badge badge-lg">${portionSize} ${getUnitShort(portionUnit)} × ${portions} = ${totalStr}</span>
                </div>
                <div class="p-4">
                    ${ingredients.length > 0 ? `
                    <table class="table table-sm w-full">
                        <thead>
                            <tr class="border-b border-base-200">
                                <th class="text-left">${t('ingredient')}</th>
                                <th class="text-right w-28">${t('quantity')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${ingredients.map((ing, idx) => {
                                const product = ing.products;
                                const calcAmount = (ing.amount || 0) * multiplier;
                                const formatted = formatIngredientAmount(calcAmount, ing.unit);
                                return `
                                    <tr class="${idx % 2 ? 'bg-base-200/30' : ''}">
                                        <td>
                                            <span class="font-medium">${getName(product)}</span>
                                            ${ing.notes ? `<span class="opacity-50"> (${ing.notes})</span>` : ''}
                                        </td>
                                        <td class="text-right whitespace-nowrap">
                                            <span class="font-bold">${formatted.value}</span>
                                            <span class="text-sm opacity-60 ml-1">${getUnitShort(formatted.unit)}</span>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                    ` : `<p class="text-center opacity-50 py-4">${t('no_ingredients')}</p>`}
                </div>
            </div>
        `;
    }).join('');
}

function formatIngredientAmount(amount, unit) {
    // Используем общую функцию из Layout
    return { value: Layout.formatQuantity(amount, unit), unit: unit };
}

function getPrintTitle(mealType) {
    const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const pad = n => String(n).padStart(2, '0');

    // Модалка деталей: menu-lunch-2026-02-07
    if (mealType) {
        return `menu-${mealType}-${formatDate(currentDate)}`;
    }

    switch (currentView) {
        case 'day':
            return `menu-day-${formatDate(currentDate)}`;
        case 'week': {
            const weekEnd = new Date(currentWeekStart);
            weekEnd.setDate(weekEnd.getDate() + 6);
            return `menu-week-${formatDate(currentWeekStart)}-${pad(weekEnd.getDate())}`;
        }
        case 'month':
            return `menu-month-${MONTHS[currentMonth.getMonth()]}${currentMonth.getFullYear()}`;
        case 'period':
            if (periodStart && periodEnd) {
                return `menu-period-${formatDate(periodStart)}-${pad(periodEnd.getDate())}`;
            }
            return `menu-period-${formatDate(currentDate)}`;
        default:
            return `menu-${formatDate(currentDate)}`;
    }
}

function printMenu() {
    const origTitle = document.title;
    document.title = getPrintTitle();
    window.print();
    setTimeout(() => { document.title = origTitle; }, 200);
}

function printMealDetails() {
    const origTitle = document.title;
    document.title = getPrintTitle(selectedMealType);
    document.body.classList.add('printing-modal');
    mealDetailsModal.classList.add('print-modal-active');
    window.print();
    setTimeout(() => {
        document.body.classList.remove('printing-modal');
        mealDetailsModal.classList.remove('print-modal-active');
        document.title = origTitle;
    }, 200);
}

// ==================== INIT ====================
// ==================== ДЕЛЕГИРОВАНИЕ КЛИКОВ ====================
// Общий обработчик для всех view-контейнеров (day/week/period/month)
function setupViewDelegation(el) {
    if (!el || el._delegated) return;
    el._delegated = true;
    el.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const { action, date, mealType, dishId, id } = btn.dataset;
        switch (action) {
            case 'open-dish-modal': openDishModal(date, mealType); break;
            case 'open-meal-details-modal': openMealDetailsModal(date, mealType); break;
            case 'remove-dish': removeDish(date, mealType, dishId); break;
            case 'open-day-detail': openDayDetail(date); break;
        }
    });
    // Делегирование change-событий (повар, порции, количество блюда)
    el.addEventListener('change', ev => {
        const target = ev.target.closest('[data-action]');
        if (!target) return;
        const { action, date, mealType, dishId } = target.dataset;
        switch (action) {
            case 'update-meal-cook': updateMealCook(date, mealType, target.value); break;
            case 'update-meal-portions': updateMealPortions(date, mealType, target.value); break;
            case 'update-dish-quantity': updateDishQuantity(dishId, target.value); break;
        }
    });
}

function setupRecipeDelegation() {
    // Делегирование для поиска рецептов (dropdown)
    const dropdown = Layout.$('#recipeDropdown');
    if (dropdown && !dropdown._delegated) {
        dropdown._delegated = true;
        dropdown.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="select-recipe"]');
            if (el) selectRecipe(el.dataset.id);
        });
    }

    // Делегирование для списка рецептов по категориям
    const catList = Layout.$('#categoryRecipeList');
    if (catList && !catList._delegated) {
        catList._delegated = true;
        catList.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="select-recipe"]');
            if (el) selectRecipe(el.dataset.id);
        });
    }

    // Делегирование для кнопок категорий
    const catBtns = Layout.$('#categoryButtons');
    if (catBtns && !catBtns._delegated) {
        catBtns._delegated = true;
        catBtns.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="filter-by-category"]');
            if (el) filterByCategory(el.dataset.category);
        });
    }
}

async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'menu' });

    // Восстановить вид и дату из hash до загрузки данных
    restoreFromHash();

    // Заполнить поля дат для period-вида
    if (currentView === 'period' && periodStart && periodEnd) {
        Layout.$('#periodStartDate').value = formatDate(periodStart);
        Layout.$('#periodEndDate').value = formatDate(periodEnd);
    }

    // UI-переключение без повторной загрузки (loadData вызовет loadMenuData)
    if (currentView !== 'day') {
        switchViewUI(currentView);
    }

    Layout.showLoader();
    await loadData();
    Layout.hideLoader();

    // Проверка изменения количества едоков (async, не блокируем UI)
    checkEatingCountChanges();

    // Делегирование для view-контейнеров
    setupViewDelegation(Layout.$('#dayContent'));
    setupViewDelegation(Layout.$('#weekGrid'));
    setupViewDelegation(Layout.$('#periodGrid'));
    setupViewDelegation(Layout.$('#monthGrid'));

    // Делегирование для модалки рецептов
    setupRecipeDelegation();
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    render();
};
window.onLocationChange = () => loadMenuData();

init();
