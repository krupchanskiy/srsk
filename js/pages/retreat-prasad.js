/**
 * Retreat Prasad Page Logic
 *
 * Управление питанием гостей ретрита:
 * - Таблица участников с фото, именами, комнатой и типом питания
 * - Фильтрация по типу питания
 * - Inline-изменение meal_type через select
 */

// ==================== STATE ====================
let retreatId = null;
let retreat = null;
let registrations = [];
let currentFilter = 'all'; // 'all' | 'prasad' | 'child' | 'self' | 'none'
let searchQuery = '';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

// ==================== DATA LOADING ====================
let allRetreats = [];

async function loadAllRetreats() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date, color')
        .order('start_date', { ascending: false });

    if (error) {
        console.error('Error loading retreats:', error);
        return;
    }

    allRetreats = data || [];

    const select = document.getElementById('retreatSelect');
    select.innerHTML = `<option value="" data-i18n="select_retreat">${t('select_retreat')}</option>`;

    allRetreats.forEach(r => {
        const name = r[`name_${Layout.currentLang}`] || r.name_ru;
        const option = document.createElement('option');
        option.value = r.id;
        option.textContent = name;
        select.appendChild(option);
    });
}

function onRetreatChange(value) {
    if (!value) {
        retreatId = null;
        retreat = null;
        registrations = [];
        renderTable();
        updateStats();
        document.getElementById('retreatDates').textContent = '';
        return;
    }

    retreatId = value;
    selectRetreat(value);
}

async function selectRetreat(id) {
    retreat = allRetreats.find(r => r.id === id);
    if (!retreat) return;

    const startDate = DateUtils.parseDate(retreat.start_date);
    const endDate = DateUtils.parseDate(retreat.end_date);
    document.getElementById('retreatDates').textContent = `${DateUtils.formatRangeShort(startDate, endDate)} ${endDate.getFullYear()}`;

    if (retreat.color) {
        document.documentElement.style.setProperty('--current-color', retreat.color);
    }

    await loadRegistrations();
}

async function loadRegistrations() {
    if (!retreatId) return;

    Layout.showLoader();

    const { data, error } = await Layout.db
        .from('retreat_registrations')
        .select(`
            id,
            status,
            meal_type,
            vaishnava:vaishnavas (
                id,
                first_name,
                last_name,
                spiritual_name,
                photo_url
            ),
            placement:room_residents (
                room:rooms (
                    number,
                    building:buildings (
                        name_ru,
                        name_en,
                        name_hi
                    )
                )
            )
        `)
        .eq('retreat_id', retreatId)
        .neq('status', 'cancelled');

    Layout.hideLoader();

    if (error) {
        console.error('Error loading registrations:', error);
        return;
    }

    registrations = (data || []).map(r => ({
        ...r,
        placement: r.placement || []
    }));

    renderTable();
    updateStats();
}

// ==================== RENDERING ====================
function renderTable() {
    const tbody = document.getElementById('prasadTable');
    const noGuests = document.getElementById('noGuests');

    const filtered = filterRegistrations();

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        noGuests.classList.remove('hidden');
        return;
    }

    noGuests.classList.add('hidden');

    tbody.innerHTML = filtered.map(reg => {
        const v = reg.vaishnava;
        if (!v) return '';

        const spiritualName = v.spiritual_name || '';
        const civilName = `${v.first_name || ''} ${v.last_name || ''}`.trim();
        const initials = (spiritualName || v.first_name || '?').charAt(0).toUpperCase();

        // Фото
        const photoHtml = v.photo_url
            ? `<img src="${e(v.photo_url)}" class="w-10 h-10 rounded-full object-cover" alt="" data-initials="${e(initials)}" onerror="replacePhotoWithPlaceholder(this)">`
            : `<div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold">${e(initials)}</div>`;

        // Проживание
        let accommodationHtml = `<span class="opacity-40">${t('not_placed')}</span>`;
        if (reg.placement && reg.placement.length > 0) {
            const p = reg.placement[0];
            if (p.room) {
                const roomNum = p.room.number || '?';
                const buildingName = Layout.getName(p.room.building);
                accommodationHtml = `<span>${e(roomNum)}, ${e(buildingName)}</span>`;
            }
        }

        // Meal type select
        const mealType = reg.meal_type || '';
        const mealClass = mealType ? `meal-${mealType}` : 'meal-none';

        return `
            <tr class="hover:bg-base-200 cursor-pointer" data-action="navigate-person" data-vaishnava-id="${v.id}">
                <td>
                    <div class="flex items-center gap-3">
                        ${photoHtml}
                        <div>
                            <div class="font-medium">${e(spiritualName || civilName)}</div>
                            ${spiritualName && civilName ? `<div class="text-xs opacity-50">${e(civilName)}</div>` : ''}
                        </div>
                    </div>
                </td>
                <td class="text-sm">${accommodationHtml}</td>
                <td>
                    <select class="select select-bordered select-xs ${mealClass}"
                            data-action="update-meal" data-id="${reg.id}">
                        <option value="prasad" ${mealType === 'prasad' ? 'selected' : ''} data-i18n="meal_prasad">${t('meal_prasad')}</option>
                        <option value="child" ${mealType === 'child' ? 'selected' : ''} data-i18n="meal_child">${t('meal_child')}</option>
                        <option value="self" ${mealType === 'self' ? 'selected' : ''} data-i18n="meal_self">${t('meal_self')}</option>
                        <option value="" ${!mealType ? 'selected' : ''} data-i18n="meal_none">${t('meal_none')}</option>
                    </select>
                </td>
            </tr>
        `;
    }).join('');

    // Делегирование событий
    if (!tbody._delegated) {
        tbody._delegated = true;
        tbody.addEventListener('click', ev => {
            if (ev.target.closest('select')) return;
            const row = ev.target.closest('[data-action="navigate-person"]');
            if (row) {
                window.location.href = `person.html?id=${row.dataset.vaishnavId}`;
            }
        });
        tbody.addEventListener('change', ev => {
            const select = ev.target.closest('[data-action="update-meal"]');
            if (select) {
                ev.stopPropagation();
                updateMealType(select.dataset.id, select.value);
            }
        });
    }
}

function filterRegistrations() {
    let result = [...registrations];

    // Фильтр по типу питания
    if (currentFilter !== 'all') {
        if (currentFilter === 'none') {
            result = result.filter(r => !r.meal_type);
        } else {
            result = result.filter(r => r.meal_type === currentFilter);
        }
    }

    // Фильтр по поиску
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        result = result.filter(r => {
            const v = r.vaishnava;
            if (!v) return false;
            const searchStr = [
                v.first_name,
                v.last_name,
                v.spiritual_name
            ].filter(Boolean).join(' ').toLowerCase();
            return searchStr.includes(q);
        });
    }

    // Сортировка по имени
    result.sort((a, b) => {
        const aName = getVaishnavName(a.vaishnava, '');
        const bName = getVaishnavName(b.vaishnava, '');
        return aName.localeCompare(bName);
    });

    return result;
}

// ==================== STATS ====================
function updateStats() {
    const stats = document.getElementById('mealStats');
    if (!registrations.length) {
        stats.innerHTML = '';
        return;
    }

    const counts = { prasad: 0, child: 0, self: 0, none: 0 };
    registrations.forEach(r => {
        if (r.meal_type && counts.hasOwnProperty(r.meal_type)) {
            counts[r.meal_type]++;
        } else {
            counts.none++;
        }
    });

    stats.innerHTML = `
        <span class="badge meal-prasad gap-1">${t('meal_prasad')}: ${counts.prasad}</span>
        <span class="badge meal-child gap-1">${t('meal_child')}: ${counts.child}</span>
        <span class="badge meal-self gap-1">${t('meal_self')}: ${counts.self}</span>
        <span class="badge meal-none gap-1">${t('meal_none')}: ${counts.none}</span>
        <span class="badge badge-ghost gap-1">${t('all')}: ${registrations.length}</span>
    `;
}

// ==================== FILTERS ====================
function setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            renderTable();
        });
    });
}

function onSearchInput(value) {
    searchQuery = value;
    document.getElementById('searchClear').classList.toggle('hidden', !value);
    renderTable();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    searchQuery = '';
    document.getElementById('searchClear').classList.add('hidden');
    renderTable();
}

// ==================== MEAL TYPE UPDATE ====================
async function updateMealType(registrationId, newMealType) {
    const { error } = await Layout.db
        .from('retreat_registrations')
        .update({ meal_type: newMealType || null })
        .eq('id', registrationId);

    if (error) {
        console.error('Error updating meal_type:', error);
        Layout.showNotification(t('error'), 'error');
        // Откатить select к предыдущему значению
        const reg = registrations.find(r => r.id === registrationId);
        if (reg) renderTable();
        return;
    }

    // Обновить локальное состояние
    const reg = registrations.find(r => r.id === registrationId);
    if (reg) {
        reg.meal_type = newMealType || null;
    }

    // Обновить класс select
    const select = document.querySelector(`select[data-id="${registrationId}"]`);
    if (select) {
        select.className = `select select-bordered select-xs ${newMealType ? 'meal-' + newMealType : 'meal-none'}`;
    }

    updateStats();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'retreat_prasad' });
    Layout.showLoader();

    await loadAllRetreats();
    setupFilters();

    Layout.hideLoader();
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    renderTable();
    updateStats();
};

init();
