// Планировщик меню — горизонтальная доска (канбан)
// Столбцы = дни, строки = завтрак/обед, блюда — цветные плашки с drag&drop

// ==================== CONFIG ====================
const DAYS_TO_SHOW = 35;
const COL_WIDTH = 190;

const e = str => Layout.escapeHtml(str);
const t = key => Layout.t(key);
const getName = (item, lang) => Layout.getName(item, lang || Layout.currentLang);
const getPersonName = person => Layout.getPersonName(person, Layout.currentLang);
const canEditMenu = () => window.hasPermission?.('edit_menu') ?? false;

// Безопасный парсинг даты YYYY-MM-DD как локальное время
function parseLocalDate(val) {
    if (val instanceof Date) return new Date(val);
    if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
        return new Date(val + 'T00:00:00');
    }
    return new Date(val);
}

// ==================== STATE ====================
let baseDate = new Date();
baseDate.setDate(baseDate.getDate() - 3); // начинаем за 3 дня до сегодня

let recipes = [];
let categories = [];
let units = [];
let menuData = {};       // { 'YYYY-MM-DD': { breakfast: { id, portions, dishes: [...] }, lunch: {...} } }
let retreats = [];
let holidays = [];
let eatingCounts = {};
let cooks = [];
let staffIds = [];

let dragData = null;

// Состояние модалки добавления
let selectedDate = null;
let selectedMealType = null;
let selectedRecipe = null;
let currentCategory = 'all';

// Состояние модалки редактирования
let editingDish = null;
let editingDate = null;
let editingMealType = null;

// Конфигурация типов приёмов пищи по локациям
const mealConfig = {
    main: ['breakfast', 'lunch'],
    cafe: ['menu'],
    guest: ['breakfast', 'lunch']
};

function getMealTypes() {
    return mealConfig[Layout.currentLocation] || ['breakfast', 'lunch'];
}

// ==================== HELPERS ====================
const getCurrentLocation = () => Layout.locations?.find(l => l.slug === Layout.currentLocation);

function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

const getMonthNames = () => [
    t('month_jan'), t('month_feb'), t('month_mar'), t('month_apr'),
    t('month_may'), t('month_jun'), t('month_jul'), t('month_aug'),
    t('month_sep'), t('month_oct'), t('month_nov'), t('month_dec')
];

const getDayNamesShort = () => [
    t('weekday_sun'), t('weekday_mon'), t('weekday_tue'), t('weekday_wed'),
    t('weekday_thu'), t('weekday_fri'), t('weekday_sat')
];

function getUnitShort(unitCode) {
    if (!unitCode) return '';
    const unit = units.find(u => u.code === unitCode || u.short_ru === unitCode || u.short_en === unitCode);
    return unit ? (unit[`short_${Layout.currentLang}`] || unit.short_ru || unitCode) : unitCode;
}

function getRetreat(dateStr) {
    return retreats.find(r => dateStr >= r.start_date && dateStr <= r.end_date);
}

function isEkadashi(dateStr) {
    return holidays.some(h => h.date === dateStr && h.type === 'ekadashi');
}

function getEatingTotal(dateStr, mealType) {
    const counts = eatingCounts[dateStr];
    if (!counts) return 50;
    const key = (mealType === 'breakfast') ? 'breakfast' : 'lunch';
    const mc = counts[key];
    if (!mc) return 50;
    const total = mc.guests + mc.team + (mc.residents || 0);
    return total > 0 ? total : 50;
}

// ==================== DATA LOADING ====================
async function loadData() {
    const locationId = getCurrentLocation()?.id;

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
        staffResult,
        unitsResult
    ] = await Promise.all([
        recipesQuery,
        Cache.getOrLoad('recipe_categories', async () => {
            const { data, error } = await Layout.db
                .from('recipe_categories')
                .select('*')
                .order('sort_order');
            if (error) return null;
            return data;
        }),
        Layout.db.from('retreats').select('*'),
        Layout.db.from('holidays').select('*'),
        Layout.db
            .from('vaishnavas')
            .select('*, department:departments!inner(*)')
            .eq('is_team_member', true)
            .eq('is_deleted', false)
            .eq('departments.name_en', 'Kitchen'),
        Layout.db
            .from('vaishnavas')
            .select('id')
            .eq('user_type', 'staff'),
        Cache.getOrLoad('units', async () => {
            const { data, error } = await Layout.db.from('units').select('*');
            if (error) return null;
            return data;
        })
    ]);

    recipes = recipesResult.data || [];
    categories = categoriesResult || [];
    retreats = retreatsResult.data || [];
    holidays = holidaysResult.data || [];
    cooks = cooksResult.data || [];
    staffIds = (staffResult.data || []).map(s => s.id);
    units = unitsResult || [];

    await loadMenuData();
}

async function loadMenuData() {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) {
        menuData = {};
        renderBoard();
        return;
    }

    const endDate = new Date(baseDate);
    endDate.setDate(endDate.getDate() + DAYS_TO_SHOW - 1);

    const startStr = formatDate(baseDate);
    const endStr = formatDate(endDate);

    const { data: mealsData } = await Layout.db
        .from('menu_meals')
        .select(`
            *,
            cook:vaishnavas(*),
            dishes:menu_dishes(*, recipe:recipes(*, category:recipe_categories(*)))
        `)
        .eq('location_id', locationId)
        .gte('date', startStr)
        .lte('date', endStr);

    menuData = {};
    (mealsData || []).forEach(meal => {
        if (!menuData[meal.date]) menuData[meal.date] = {};
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

    await loadEatingCounts(startStr, endStr);

    renderBoard();
    renderRetreats();
    updateMonthLabel();
}

// Копия логики подсчёта едоков из kitchen-menu.js
async function loadEatingCounts(startDate, endDate) {
    eatingCounts = {};

    const retreatsInPeriod = retreats.filter(r =>
        r.start_date <= endDate && r.end_date >= startDate
    );
    const retreatIds = retreatsInPeriod.map(r => r.id);

    const [guestRegResult, teamStaysResult, residentsResult] = await Promise.all([
        retreatIds.length > 0
            ? Layout.db
                .from('retreat_registrations')
                .select('retreat_id, vaishnava_id, arrival_datetime, departure_datetime')
                .in('retreat_id', retreatIds)
                .eq('is_deleted', false)
                .not('status', 'in', '("cancelled","rejected")')
                .or('meal_type.eq.prasad,meal_type.is.null')
            : Promise.resolve({ data: [] }),
        staffIds.length > 0
            ? Layout.db
                .from('vaishnava_stays')
                .select('vaishnava_id, start_date, end_date, early_checkin, late_checkout')
                .in('vaishnava_id', staffIds)
                .lte('start_date', endDate)
                .gte('end_date', startDate)
            : Promise.resolve({ data: [] }),
        Layout.db
            .from('residents')
            .select('id, vaishnava_id, check_in, check_out, early_checkin, late_checkout')
            .eq('status', 'active')
            .or('meal_type.eq.prasad,meal_type.is.null')
            .lte('check_in', endDate)
            .or(`check_out.gte.${startDate},check_out.is.null`)
    ]);

    const guestRegistrations = guestRegResult.data || [];
    const teamStays = teamStaysResult.data || [];
    const residentsData = residentsResult.data || [];

    const BREAKFAST_CUTOFF = 10;
    const LUNCH_CUTOFF = 13;

    const firstDay = new Date(startDate + 'T00:00:00');
    const lastDay = new Date(endDate + 'T00:00:00');
    for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
        const dateStr = formatDate(d);

        const breakfastGuestIds = new Set();
        const lunchGuestIds = new Set();

        for (const retreat of retreatsInPeriod) {
            if (dateStr >= retreat.start_date && dateStr <= retreat.end_date) {
                const regsForRetreat = guestRegistrations.filter(r => r.retreat_id === retreat.id);
                for (const reg of regsForRetreat) {
                    const isFirstDay = (dateStr === retreat.start_date);
                    const isLastDay = (dateStr === retreat.end_date);

                    let getsBreakfast = true;
                    let getsLunch = true;

                    if (isFirstDay) {
                        if (reg.arrival_datetime) {
                            const hour = new Date(reg.arrival_datetime.slice(0, 16)).getHours();
                            getsBreakfast = hour < BREAKFAST_CUTOFF;
                            getsLunch = hour < LUNCH_CUTOFF;
                        } else {
                            getsBreakfast = false;
                        }
                    }

                    if (isLastDay) {
                        if (reg.departure_datetime) {
                            const hour = new Date(reg.departure_datetime.slice(0, 16)).getHours();
                            getsBreakfast = getsBreakfast && hour >= BREAKFAST_CUTOFF;
                            getsLunch = getsLunch && hour >= LUNCH_CUTOFF;
                        } else {
                            getsLunch = false;
                        }
                    }

                    if (getsBreakfast) breakfastGuestIds.add(reg.vaishnava_id);
                    if (getsLunch) lunchGuestIds.add(reg.vaishnava_id);
                }
            }
        }

        const teamBreakfast = new Set();
        const teamLunch = new Set();
        for (const stay of teamStays) {
            if (stay.start_date <= dateStr && stay.end_date >= dateStr) {
                const isFirstDay = (dateStr === stay.start_date);
                const isLastDay = (dateStr === stay.end_date);
                if (!isFirstDay || stay.early_checkin) teamBreakfast.add(stay.vaishnava_id);
                if (!isLastDay || stay.late_checkout) teamLunch.add(stay.vaishnava_id);
            }
        }

        // Исключаем тех, кто уже посчитан как гость ретрита или команда
        let breakfastResidents = 0, lunchResidents = 0;
        for (const r of residentsData) {
            if (r.check_in <= dateStr && (!r.check_out || r.check_out >= dateStr)) {
                const isFirstDay = (dateStr === r.check_in);
                const isLastDay = (r.check_out && dateStr === r.check_out);
                const alreadyBreakfast = breakfastGuestIds.has(r.vaishnava_id) || teamBreakfast.has(r.vaishnava_id);
                const alreadyLunch = lunchGuestIds.has(r.vaishnava_id) || teamLunch.has(r.vaishnava_id);
                if (!alreadyBreakfast && (!isFirstDay || r.early_checkin)) breakfastResidents++;
                if (!alreadyLunch && (!isLastDay || r.late_checkout)) lunchResidents++;
            }
        }

        eatingCounts[dateStr] = {
            breakfast: { guests: breakfastGuestIds.size, team: teamBreakfast.size, residents: breakfastResidents },
            lunch:     { guests: lunchGuestIds.size,     team: teamLunch.size,     residents: lunchResidents }
        };
    }
}

// ==================== RENDERING ====================
function renderBoard() {
    const table = document.getElementById('boardTable');
    if (!table) return;

    const today = formatDate(new Date());
    const monthNames = getMonthNames();
    const dayNames = getDayNamesShort();
    const types = getMealTypes();
    const canEdit = canEditMenu();

    // Генерируем массив дней
    const days = [];
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        days.push(d);
    }

    // thead: одна строка — число + день недели
    let headHtml = '<thead><tr>';
    for (const d of days) {
        const dateStr = formatDate(d);
        const isToday = dateStr === today;
        const dow = d.getDay();
        const isWeekend = dow === 0 || dow === 6;
        const cls = isToday ? 'day-today-header' : '';
        const color = isWeekend ? 'color: #ef4444;' : '';
        headHtml += `<th class="${cls}" style="min-width: ${COL_WIDTH}px; width: ${COL_WIDTH}px; ${color}">${d.getDate()} ${dayNames[dow]}</th>`;
    }
    headHtml += '</tr></thead>';

    // tbody: строки по типам приёмов пищи
    let bodyHtml = '<tbody>';
    for (const mt of types) {
        bodyHtml += '<tr>';

        for (const d of days) {
            const dateStr = formatDate(d);
            const isToday = dateStr === today;
            const dow = d.getDay();
            const isWeekend = dow === 0 || dow === 6;

            let bgClass = '';
            // без подсветки выходных

            const mealData = menuData[dateStr]?.[mt];
            const dishes = (mealData?.dishes || []).slice().sort((a, b) => {
                const sa = a.recipe?.category?.sort_order ?? 999;
                const sb = b.recipe?.category?.sort_order ?? 999;
                return sa - sb;
            });

            // Бейдж количества едоков
            const counts = eatingCounts[dateStr];
            const key = (mt === 'breakfast') ? 'breakfast' : 'lunch';
            const mc = counts?.[key];
            let eatingHtml = '';
            if (mc) {
                const total = mc.guests + mc.team + (mc.residents || 0);
                if (total > 0) {
                    const mealLabel = t(mt) || mt;
                    eatingHtml = `<div class="eating-badge"><b style="color:#111">${e(mealLabel)}</b> ${mc.guests}+${mc.team}+${mc.residents || 0}=${total}</div>`;
                }
            }

            // Плашки блюд
            let dishesHtml = '';
            for (const dish of dishes) {
                const recipe = dish.recipe;
                if (!recipe) continue;
                const cat = recipe.category;
                const color = cat?.color || '#888';
                const emoji = cat?.emoji || '';
                const recipeName = getName(recipe);
                const draggable = canEdit ? 'draggable="true"' : '';

                dishesHtml += `<div class="dish-chip" style="background-color: ${color}22; border-left-color: ${color};"
                    data-action="edit-dish" data-dish-id="${dish.id}" data-date="${dateStr}" data-meal-type="${mt}"
                    data-recipe-id="${dish.recipe_id}"
                    ${draggable}>${emoji} ${e(recipeName)}</div>`;
            }

            // Кнопка «+»
            let addHtml = '';
            if (canEdit) {
                addHtml = `<div class="add-dish-btn" data-action="open-dish-modal" data-date="${dateStr}" data-meal-type="${mt}">+</div>`;
            }

            bodyHtml += `<td class="meal-cell ${bgClass}" data-date="${dateStr}" data-meal-type="${mt}">
                ${eatingHtml}${dishesHtml}${addHtml}
            </td>`;
        }

        bodyHtml += '</tr>';
    }
    bodyHtml += '</tbody>';

    table.innerHTML = headHtml + bodyHtml;

    // Навесить drag&drop если есть права
    if (canEdit) {
        setupDragDrop();
    }
}

function renderRetreats() {
    const container = document.getElementById('retreatsScroll');
    if (!container) return;

    let html = '';

    // Фоновые слоты по дням
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
        html += `<div class="retreat-slot"></div>`;
    }

    // Плашки ретритов
    for (const r of retreats) {
        // Вычислить пересечение с видимым диапазоном
        const endDate = new Date(baseDate);
        endDate.setDate(endDate.getDate() + DAYS_TO_SHOW - 1);
        const rangeStart = formatDate(baseDate);
        const rangeEnd = formatDate(endDate);

        if (r.end_date < rangeStart || r.start_date > rangeEnd) continue;

        const rStart = parseLocalDate(r.start_date < rangeStart ? rangeStart : r.start_date);
        const rEnd = parseLocalDate(r.end_date > rangeEnd ? rangeEnd : r.end_date);

        const startDay = Math.round((rStart - baseDate) / (1000 * 60 * 60 * 24));
        const endDay = Math.round((rEnd - baseDate) / (1000 * 60 * 60 * 24));

        const left = startDay * COL_WIDTH;
        const width = (endDay - startDay + 1) * COL_WIDTH;
        const color = r.color || '#10b981';

        html += `<div class="retreat-chip" style="left: ${left}px; width: ${width}px; background-color: ${color};">${e(getName(r))}</div>`;
    }

    // Названия месяцев
    const monthNamesUpper = getMonthNames().map(n => n.toUpperCase());
    for (let i = 0; i < DAYS_TO_SHOW; i++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + i);
        if (d.getDate() === 1) {
            const left = i * COL_WIDTH;
            html += `<div class="month-label" style="left: ${left}px;">${monthNamesUpper[d.getMonth()]}</div>`;
        }
    }

    container.innerHTML = html;
}

function syncScroll() {
    const boardContainer = document.getElementById('boardContainer');
    const retreatsScroll = document.getElementById('retreatsScroll');
    if (!boardContainer || !retreatsScroll) return;

    boardContainer.addEventListener('scroll', () => {
        retreatsScroll.style.transform = `translateX(-${boardContainer.scrollLeft}px)`;
    });
}

function renderLegend() {
    const container = document.getElementById('legendContainer');
    if (!container) return;

    let html = '';
    for (const cat of categories) {
        const color = cat.color || '#888';
        html += `<span class="legend-item"><span class="legend-dot" style="background-color: ${color};"></span>${cat.emoji || ''} ${e(getName(cat))}</span>`;
    }
    container.innerHTML = html;
}

function updateMonthLabel() {
    const label = document.getElementById('monthLabel');
    if (!label) return;

    const monthNames = getMonthNames();
    const startMonth = baseDate.getMonth();
    const startYear = baseDate.getFullYear();

    const endDateObj = new Date(baseDate);
    endDateObj.setDate(endDateObj.getDate() + DAYS_TO_SHOW - 1);
    const endMonth = endDateObj.getMonth();
    const endYear = endDateObj.getFullYear();

    if (startMonth === endMonth && startYear === endYear) {
        label.textContent = `${monthNames[startMonth]} ${startYear}`;
    } else if (startYear === endYear) {
        label.textContent = `${monthNames[startMonth]} \u2014 ${monthNames[endMonth]} ${startYear}`;
    } else {
        label.textContent = `${monthNames[startMonth]} ${startYear} \u2014 ${monthNames[endMonth]} ${endYear}`;
    }
}

// ==================== NAVIGATION ====================
function shiftMonth(dir) {
    baseDate.setMonth(baseDate.getMonth() + parseInt(dir));
    reload();
}

function goToToday() {
    baseDate = new Date();
    baseDate.setDate(baseDate.getDate() - 3);
    reload();
}

function reload() {
    loadMenuData();
}

// ==================== DRAG & DROP ====================
function setupDragDrop() {
    const table = document.getElementById('boardTable');
    if (!table) return;

    // dragstart
    table.addEventListener('dragstart', ev => {
        const chip = ev.target.closest('.dish-chip');
        if (!chip) return;
        dragData = {
            dishId: chip.dataset.dishId,
            sourceDate: chip.dataset.date,
            sourceMealType: chip.dataset.mealType,
            recipeId: chip.dataset.recipeId
        };
        chip.classList.add('dragging');
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', chip.dataset.dishId);
    });

    // dragend
    table.addEventListener('dragend', ev => {
        const chip = ev.target.closest('.dish-chip');
        if (chip) chip.classList.remove('dragging');
        // Убрать все drag-over
        table.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        dragData = null;
    });

    // dragover
    table.addEventListener('dragover', ev => {
        const cell = ev.target.closest('.meal-cell');
        if (!cell || !dragData) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        // Подсветка только текущей ячейки
        table.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        cell.classList.add('drag-over');
    });

    // dragleave
    table.addEventListener('dragleave', ev => {
        const cell = ev.target.closest('.meal-cell');
        if (cell) cell.classList.remove('drag-over');
    });

    // drop
    table.addEventListener('drop', ev => {
        ev.preventDefault();
        const cell = ev.target.closest('.meal-cell');
        if (!cell || !dragData) return;
        cell.classList.remove('drag-over');

        const targetDate = cell.dataset.date;
        const targetMealType = cell.dataset.mealType;

        // Если та же ячейка — игнорировать
        if (targetDate === dragData.sourceDate && targetMealType === dragData.sourceMealType) {
            dragData = null;
            return;
        }

        moveDish(dragData.dishId, dragData.sourceDate, dragData.sourceMealType, targetDate, targetMealType, dragData.recipeId);
        dragData = null;
    });
}

async function moveDish(dishId, sourceDate, sourceMealType, targetDate, targetMealType, recipeId) {
    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    // Проверить уникальность рецепта в целевой ячейке
    const targetMeal = menuData[targetDate]?.[targetMealType];
    if (targetMeal?.dishes?.some(d => d.recipe_id === recipeId)) {
        Layout.showNotification(t('already_added') || 'Это блюдо уже добавлено', 'warning');
        return;
    }

    // Upsert meal для target (если нет)
    let targetMealId = targetMeal?.id;
    if (!targetMealId) {
        const defaultPortions = getEatingTotal(targetDate, targetMealType);
        const { data: newMeal } = await Layout.db
            .from('menu_meals')
            .upsert({
                location_id: locationId,
                date: targetDate,
                meal_type: targetMealType,
                portions: defaultPortions
            }, { onConflict: 'location_id,date,meal_type' })
            .select()
            .single();

        if (!newMeal) return;
        targetMealId = newMeal.id;

        if (!menuData[targetDate]) menuData[targetDate] = {};
        if (!menuData[targetDate][targetMealType]) {
            menuData[targetDate][targetMealType] = { id: targetMealId, portions: defaultPortions, dishes: [] };
        }
    }

    // Переместить блюдо
    const { error } = await Layout.db
        .from('menu_dishes')
        .update({ meal_id: targetMealId })
        .eq('id', dishId);

    if (error) {
        Layout.showNotification(t('error') || 'Ошибка', 'error');
        return;
    }

    // Обновить локальные данные: убрать из source, добавить в target
    const sourceMeal = menuData[sourceDate]?.[sourceMealType];
    if (sourceMeal) {
        const idx = sourceMeal.dishes.findIndex(d => d.id === dishId);
        if (idx !== -1) {
            const [movedDish] = sourceMeal.dishes.splice(idx, 1);
            if (!menuData[targetDate]) menuData[targetDate] = {};
            if (!menuData[targetDate][targetMealType]) {
                menuData[targetDate][targetMealType] = { id: targetMealId, portions: getEatingTotal(targetDate, targetMealType), dishes: [] };
            }
            menuData[targetDate][targetMealType].dishes.push(movedDish);
        }
    }

    renderBoard();
}

// ==================== DISH MODAL (ADD) ====================
function openDishModal(dateStr, mealType) {
    selectedDate = dateStr;
    selectedMealType = mealType;
    selectedRecipe = null;

    const date = parseLocalDate(dateStr);
    const monthNames = getMonthNames();
    const dayNames = getDayNamesShort();

    document.getElementById('dishModalTitle').textContent =
        `${t(mealType) || mealType} \u00b7 ${dayNames[date.getDay()]}, ${date.getDate()} ${monthNames[date.getMonth()]}`;

    // Сброс формы
    document.getElementById('recipeSearch').value = '';
    document.getElementById('recipeDropdown').classList.add('hidden');
    document.getElementById('selectedRecipeDisplay').classList.add('hidden');
    document.getElementById('portionSize').value = 200;
    document.getElementById('portionUnit').textContent = '\u0433';
    document.getElementById('saveDishBtn').disabled = true;
    document.getElementById('totalCalculation').textContent = '\u2014';

    document.getElementById('tabSearch').classList.add('tab-active');
    document.getElementById('tabBrowse').classList.remove('tab-active');
    document.getElementById('searchTab').classList.remove('hidden');
    document.getElementById('browseTab').classList.add('hidden');
    currentCategory = 'all';

    buildCategoryButtons();
    dishModal.showModal();
}

function buildCategoryButtons() {
    const container = document.getElementById('categoryButtons');
    container.innerHTML = `
        <button type="button" class="btn btn-sm filter-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all" data-action="filter-category" data-category="all">${t('filter_all') || 'Все'}</button>
        ${categories.map(cat => `
            <button type="button" class="btn btn-sm filter-btn ${currentCategory === cat.slug ? 'active' : ''}" data-cat="${cat.slug}" data-action="filter-category" data-category="${cat.slug}">${getName(cat)}</button>
        `).join('')}
    `;
}

function switchRecipeTab(tab) {
    if (tab === 'search') {
        document.getElementById('searchTab').classList.remove('hidden');
        document.getElementById('browseTab').classList.add('hidden');
        document.getElementById('tabSearch').classList.add('tab-active');
        document.getElementById('tabBrowse').classList.remove('tab-active');
    } else {
        document.getElementById('searchTab').classList.add('hidden');
        document.getElementById('browseTab').classList.remove('hidden');
        document.getElementById('tabSearch').classList.remove('tab-active');
        document.getElementById('tabBrowse').classList.add('tab-active');
        filterByCategory(currentCategory);
    }
}

function filterRecipes(query) {
    const dropdown = document.getElementById('recipeDropdown');
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
                    ${e(getName(r))}
                    ${r.ekadashi ? '<span class="text-xs text-amber-600">\u044D</span>' : ''}
                    ${isEkadashiDay && !r.ekadashi ? '<span class="text-xs text-error">\u26A0</span>' : ''}
                </div>
                <div class="text-xs opacity-50">${e(r.name_en || '')}</div>
            </div>
        `).join('');
    }

    dropdown.classList.remove('hidden');
}

function filterByCategory(category) {
    currentCategory = category;
    const list = document.getElementById('categoryRecipeList');
    const isEkadashiDay = isEkadashi(selectedDate);

    document.querySelectorAll('.filter-btn').forEach(btn => {
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
                    ${e(getName(r))}
                    ${r.ekadashi ? '<span class="text-xs text-amber-600">\u044D</span>' : ''}
                    ${isEkadashiDay && !r.ekadashi ? '<span class="text-xs text-error">\u26A0</span>' : ''}
                </div>
                <div class="text-xs opacity-50">${e(r.name_en || '')} \u00b7 ${r.category ? e(getName(r.category)) : ''}</div>
            </div>
        `).join('');
    }
}

function selectRecipe(recipeId) {
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) return;

    selectedRecipe = recipe;

    document.getElementById('searchTab').classList.add('hidden');
    document.getElementById('browseTab').classList.add('hidden');
    document.getElementById('recipeDropdown').classList.add('hidden');
    document.getElementById('selectedRecipeDisplay').classList.remove('hidden');
    document.getElementById('selectedRecipeName').textContent = getName(recipe);
    document.getElementById('selectedRecipeNameEn').textContent = recipe.name_en || '';

    document.getElementById('portionSize').value = recipe.portion_amount || 200;
    document.getElementById('portionUnit').textContent = getUnitShort(recipe.portion_unit || 'g');

    const saveBtn = document.getElementById('saveDishBtn');
    saveBtn.disabled = false;
    saveBtn.classList.remove('btn-disabled');

    updateTotalCalculation();
}

function clearSelectedRecipe() {
    selectedRecipe = null;

    if (document.getElementById('tabSearch').classList.contains('tab-active')) {
        document.getElementById('searchTab').classList.remove('hidden');
        document.getElementById('recipeSearch').value = '';
    } else {
        document.getElementById('browseTab').classList.remove('hidden');
    }
    document.getElementById('selectedRecipeDisplay').classList.add('hidden');
    document.getElementById('saveDishBtn').disabled = true;
}

function updateTotalCalculation() {
    const size = parseInt(document.getElementById('portionSize').value) || 0;
    const unit = document.getElementById('portionUnit').textContent;
    document.getElementById('totalCalculation').textContent = `${size} ${unit} ${t('per_person') || 'на человека'}`;
}

async function saveDish() {
    if (!selectedRecipe) return;

    const portionSize = parseInt(document.getElementById('portionSize').value) || 200;
    const portionUnit = document.getElementById('portionUnit').textContent;
    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    // Проверка экадаши
    if (isEkadashi(selectedDate) && !selectedRecipe.ekadashi) {
        if (!confirm(`\u26A0\uFE0F ${selectedDate} \u2014 ${t('confirm_ekadashi') || 'это экадаши. Продолжить?'}`)) {
            return;
        }
    }

    // Проверка дубликата
    const mealData = menuData[selectedDate]?.[selectedMealType];
    if (mealData?.dishes?.some(d => d.recipe_id === selectedRecipe.id)) {
        Layout.showNotification(t('already_added') || 'Это блюдо уже добавлено', 'warning');
        return;
    }

    // Upsert meal
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
            Layout.showNotification(t('error') || 'Ошибка', 'error');
            return;
        }
        mealId = newMeal.id;
    }

    // Insert dish
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
        Layout.showNotification(t('error') || 'Ошибка', 'error');
        return;
    }

    // Обновить локальные данные
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
    renderBoard();
}

// ==================== DISH MODAL (EDIT) ====================
function openEditDishModal(dishId, dateStr, mealType) {
    editingDish = null;
    editingDate = dateStr;
    editingMealType = mealType;

    const mealData = menuData[dateStr]?.[mealType];
    const dish = mealData?.dishes?.find(d => d.id === dishId);
    if (!dish) return;

    editingDish = dish;

    const recipe = dish.recipe;
    document.getElementById('editDishTitle').textContent = recipe ? getName(recipe) : '';
    document.getElementById('editPortionSize').value = dish.portion_size || '';
    document.getElementById('editPortionUnit').textContent = getUnitShort(dish.portion_unit || 'g');

    editDishModal.showModal();
}

async function saveEditDish() {
    if (!editingDish) return;

    const newSize = parseFloat(document.getElementById('editPortionSize').value) || 0;

    await Layout.db
        .from('menu_dishes')
        .update({ portion_size: newSize })
        .eq('id', editingDish.id);

    editingDish.portion_size = newSize;
    editDishModal.close();
    renderBoard();
}

async function deleteDish() {
    if (!editingDish) return;

    await Layout.db
        .from('menu_dishes')
        .delete()
        .eq('id', editingDish.id);

    const mealData = menuData[editingDate]?.[editingMealType];
    if (mealData) {
        mealData.dishes = mealData.dishes.filter(d => d.id !== editingDish.id);
    }

    editDishModal.close();
    editingDish = null;
    renderBoard();
}

// ==================== EVENT DELEGATION ====================
function setupDelegation() {
    // Глобальные клики (навигация, модалки)
    document.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        switch (action) {
            case 'shift-month':
                shiftMonth(btn.dataset.dir);
                break;
            case 'go-today':
                goToToday();
                break;
            case 'close-dish-modal':
                dishModal.close();
                break;
            case 'close-edit-modal':
                editDishModal.close();
                break;
            case 'switch-tab':
                switchRecipeTab(btn.dataset.tab);
                break;
            case 'clear-recipe':
                clearSelectedRecipe();
                break;
            case 'save-dish':
                saveDish();
                break;
            case 'save-edit-dish':
                saveEditDish();
                break;
            case 'delete-dish':
                deleteDish();
                break;
            case 'select-recipe':
                selectRecipe(btn.dataset.id);
                break;
            case 'filter-category':
                filterByCategory(btn.dataset.category);
                break;
            case 'open-dish-modal':
                openDishModal(btn.dataset.date, btn.dataset.mealType);
                break;
            case 'toggle-fullscreen':
                toggleFullscreen();
                break;
            case 'open-import-modal':
                openImportModal();
                break;
            case 'close-import-modal':
                importModal.close();
                break;
            case 'do-import':
                doImport();
                break;
            case 'edit-dish':
                // Не открывать модалку если идёт drag
                if (!ev.target.closest('.dragging')) {
                    openEditDishModal(btn.dataset.dishId, btn.dataset.date, btn.dataset.mealType);
                }
                break;
        }
    });

    // Поиск рецептов
    const recipeSearch = document.getElementById('recipeSearch');
    if (recipeSearch) {
        recipeSearch.addEventListener('input', () => filterRecipes(recipeSearch.value));
        recipeSearch.addEventListener('focus', () => {
            if (recipeSearch.value.length >= 1) filterRecipes(recipeSearch.value);
        });
    }

    // Закрытие dropdown при клике вне
    document.addEventListener('click', ev => {
        const dropdown = document.getElementById('recipeDropdown');
        const input = document.getElementById('recipeSearch');
        if (dropdown && input && !dropdown.contains(ev.target) && ev.target !== input) {
            dropdown.classList.add('hidden');
        }
    });

    // Ввод размера порции
    const portionSize = document.getElementById('portionSize');
    if (portionSize) {
        portionSize.addEventListener('input', updateTotalCalculation);
    }

    // Даты в модалке импорта
    const importFrom = document.getElementById('importFromDate');
    const importTo = document.getElementById('importToDate');
    if (importFrom) importFrom.addEventListener('change', updateImportPreview);
    if (importTo) importTo.addEventListener('change', updateImportPreview);
}

// ==================== IMPORT FROM MENU ====================
const DAY_FORMS = { ru: ['день', 'дня', 'дней'], en: ['day', 'days'], hi: 'दिन' };
const DISH_FORMS = { ru: ['блюдо', 'блюда', 'блюд'], en: ['dish', 'dishes'], hi: 'व्यंजन' };
const MEAL_FORMS = { ru: ['приём пищи', 'приёма пищи', 'приёмов пищи'], en: ['meal', 'meals'], hi: 'भोजन' };

function openImportModal() {
    const today = new Date();
    const dow = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    document.getElementById('importFromDate').value = formatDate(monday);
    document.getElementById('importToDate').value = formatDate(sunday);
    document.getElementById('importTemplateName').value = '';
    document.getElementById('importBtn').disabled = true;
    document.getElementById('importPreview').classList.add('hidden');

    updateImportPreview();
    importModal.showModal();
}

async function updateImportPreview() {
    const fromDate = document.getElementById('importFromDate').value;
    const toDate = document.getElementById('importToDate').value;

    if (!fromDate || !toDate) {
        document.getElementById('importPreview').classList.add('hidden');
        document.getElementById('importBtn').disabled = true;
        return;
    }

    const from = parseLocalDate(fromDate);
    const to = parseLocalDate(toDate);
    const dayCount = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    if (dayCount < 1) {
        document.getElementById('importPreview').classList.add('hidden');
        document.getElementById('importBtn').disabled = true;
        return;
    }

    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const { data: mealsData } = await Layout.db
        .from('menu_meals')
        .select('id, date, meal_type, dishes:menu_dishes(id)')
        .eq('location_id', locationId)
        .gte('date', fromDate)
        .lte('date', toDate);

    const mealsCount = mealsData?.length || 0;
    const dishesCount = mealsData?.reduce((sum, m) => sum + (m.dishes?.length || 0), 0) || 0;

    document.getElementById('importDayCountText').textContent = Layout.pluralize(dayCount, DAY_FORMS);
    document.getElementById('importMealsCount').textContent = mealsCount > 0
        ? `${Layout.pluralize(mealsCount, MEAL_FORMS)}, ${Layout.pluralize(dishesCount, DISH_FORMS)}`
        : (t('nothing_found') || 'Нет данных');
    document.getElementById('importPreview').classList.remove('hidden');
    document.getElementById('importBtn').disabled = mealsCount === 0;
}

async function doImport() {
    const name = document.getElementById('importTemplateName').value.trim();
    const fromDate = document.getElementById('importFromDate').value;
    const toDate = document.getElementById('importToDate').value;

    if (!name) {
        Layout.showNotification(t('enter_template_name') || 'Введите название', 'warning');
        return;
    }

    const from = parseLocalDate(fromDate);
    const to = parseLocalDate(toDate);
    const dayCount = Math.ceil((to - from) / (1000 * 60 * 60 * 24)) + 1;

    const locationId = getCurrentLocation()?.id;
    if (!locationId) return;

    const importBtn = document.getElementById('importBtn');
    importBtn.disabled = true;
    importBtn.textContent = '...';

    try {
        // Загрузить меню за диапазон
        const { data: mealsData } = await Layout.db
            .from('menu_meals')
            .select('*, dishes:menu_dishes(*, recipe:recipes(*))')
            .eq('location_id', locationId)
            .gte('date', fromDate)
            .lte('date', toDate);

        // Создать шаблон
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

        // Заполнить шаблон из меню
        for (const meal of (mealsData || [])) {
            const mealDate = parseLocalDate(meal.date);
            const dayNumber = Math.ceil((mealDate - from) / (1000 * 60 * 60 * 24)) + 1;

            const { data: newMeal, error: mealError } = await Layout.db
                .from('menu_template_meals')
                .insert({
                    template_id: template.id,
                    day_number: dayNumber,
                    meal_type: meal.meal_type,
                    portions: meal.portions || 50
                })
                .select()
                .single();

            if (mealError) throw mealError;

            if (meal.dishes?.length > 0) {
                await Layout.db
                    .from('menu_template_dishes')
                    .insert(meal.dishes.map((d, i) => ({
                        template_meal_id: newMeal.id,
                        recipe_id: d.recipe_id,
                        portion_size: d.portion_size,
                        portion_unit: d.portion_unit,
                        sort_order: i
                    })));
            }
        }

        importModal.close();
        Layout.showNotification(t('template_saved') || 'Шаблон сохранён', 'success');
    } catch (error) {
        Layout.showNotification(t('error') || 'Ошибка', 'error');
    } finally {
        importBtn.disabled = false;
        importBtn.textContent = t('import') || 'Импортировать';
    }
}

// ==================== FULLSCREEN ====================
function toggleFullscreen() {
    document.body.classList.toggle('board-fullscreen');
    const isFullscreen = document.body.classList.contains('board-fullscreen');
    // Переключить иконку: expand ↔ collapse
    document.getElementById('fullscreenIcon').innerHTML = isFullscreen
        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9L4 4m0 0v4m0-4h4m7 9l5 5m0 0v-4m0 4h-4M9 15l-5 5m0 0h4m-4 0v-4m11-7l5-5m0 0h-4m4 0v4" />'
        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5v-4m0 4h-4m4 0l-5-5" />';
}

// ==================== REALTIME ====================
let realtimeTimeout = null;

function subscribeToRealtime() {
    const channel = Layout.db.channel('menu-board-realtime');

    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'menu_meals' },
        handleRealtimeChange
    );

    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'menu_dishes' },
        handleRealtimeChange
    );

    channel.subscribe();
}

function handleRealtimeChange() {
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadMenuData();
        Layout.showNotification(t('data_updated') || 'Данные обновлены', 'info');
    }, 500);
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'planner' });
    Layout.showLoader();
    await loadData();
    Layout.hideLoader();

    syncScroll();
    setupDelegation();
    subscribeToRealtime();
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    renderBoard();
    renderRetreats();
    updateMonthLabel();
    renderLegend();
};

window.onLocationChange = () => {
    loadData();
};

init();
