/**
 * Retreat Guests Page Logic
 * Extracted from vaishnavas/retreat-guests.html
 *
 * Управление гостями ретрита:
 * - Импорт CSV
 * - Таблица гостей с фильтрами и сортировкой
 * - Размещение в комнатах (список и план этажа)
 */

// ==================== STATE ====================
let retreatId = null;
let retreat = null;
let registrations = [];
let vaishnavas = [];
let currentFilter = 'all';
let searchQuery = '';
let sortField = 'name';
let sortDirection = 'asc';

// Import state
let csvData = [];
let conflicts = [];
let importStats = { created: 0, updated: 0, skipped: 0 };

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
        document.getElementById('retreatDates').textContent = '';
        return;
    }

    retreatId = value;
    selectRetreat(value);
}

async function selectRetreat(id) {
    retreat = allRetreats.find(r => r.id === id);
    if (!retreat) return;

    // Update dates display
    const startDate = DateUtils.parseDate(retreat.start_date);
    const endDate = DateUtils.parseDate(retreat.end_date);
    document.getElementById('retreatDates').textContent = `${DateUtils.formatRangeShort(startDate, endDate)} ${endDate.getFullYear()}`;

    // Set CSS variable for theme color
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
            registration_date,
            companions,
            accommodation_wishes,
            payment_notes,
            org_notes,
            extended_stay,
            guest_questions,
            meal_type,
            vaishnava:vaishnavas (
                id,
                first_name,
                last_name,
                spiritual_name,
                phone,
                email,
                gender,
                country,
                city,
                telegram,
                parent_id,
                birth_date
            ),
            placement:room_residents (
                id,
                check_in,
                check_out,
                room:rooms (
                    id,
                    number,
                    building:buildings (
                        id,
                        name_ru
                    )
                )
            ),
            transfers:guest_transfers (
                direction,
                needs_transfer,
                flight_number,
                flight_datetime,
                notes
            )
        `)
        .eq('retreat_id', retreatId);

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
}

async function loadVaishnavas() {
    const { data, error } = await Utils.fetchAll((from, to) =>
        Layout.db
            .from('vaishnavas')
            .select('id, first_name, last_name, spiritual_name, phone, email, birth_date, gender, telegram')
            .range(from, to)
    );

    if (error) {
        console.error('Error loading vaishnavas:', error);
        return;
    }

    vaishnavas = data || [];
}

// ==================== RENDERING ====================
function renderTable() {
    const tbody = document.getElementById('guestsTable');
    const noGuests = document.getElementById('noGuests');

    const filtered = filterRegistrations();

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        noGuests.classList.remove('hidden');
        return;
    }

    noGuests.classList.add('hidden');

    // Группировка: родители сверху, дети под ними с отступом
    const parents = filtered.filter(r => !r.vaishnava?.parent_id);
    const childRegs = filtered.filter(r => r.vaishnava?.parent_id);
    const childrenByParent = {};
    childRegs.forEach(r => {
        const pid = r.vaishnava.parent_id;
        if (!childrenByParent[pid]) childrenByParent[pid] = [];
        childrenByParent[pid].push(r);
    });
    // Дети без зарегистрированного родителя на этом ретрите
    const parentVaishnavIds = new Set(parents.map(r => r.vaishnava?.id).filter(Boolean));
    const orphanChildren = childRegs.filter(r => !parentVaishnavIds.has(r.vaishnava.parent_id));

    const orderedRegs = [];
    parents.forEach(r => {
        orderedRegs.push(r);
        const kids = childrenByParent[r.vaishnava?.id];
        if (kids) kids.forEach(k => orderedRegs.push(k));
    });
    orphanChildren.forEach(r => {
        if (!orderedRegs.includes(r)) orderedRegs.push(r);
    });

    const formatTransfer = (transfer) => {
        if (!transfer) return '<span class="opacity-30">—</span>';
        const dt = transfer.flight_datetime ? new Date(transfer.flight_datetime) : null;
        const dateStr = dt ? `${dt.getDate()}.${(dt.getMonth()+1).toString().padStart(2,'0')}` : '';
        const timeStr = dt ? `${dt.getHours().toString().padStart(2,'0')}:${dt.getMinutes().toString().padStart(2,'0')}` : '';
        const flight = transfer.flight_number || '';
        const needsIcon = transfer.needs_transfer === 'yes' ? '🚕' : '';
        return `<div class="text-xs">${needsIcon} ${dateStr} ${timeStr}</div><div class="text-xs opacity-60">${flight}</div>`;
    };

    tbody.innerHTML = orderedRegs.map(reg => {
        const v = reg.vaishnava;
        const isChild = !!v.parent_id;
        const name = getVaishnavName(v);

        const statusClass = `status-${reg.status}`;

        // Transfers
        const arrival = reg.transfers?.find(t => t.direction === 'arrival');
        const departure = reg.transfers?.find(t => t.direction === 'departure');

        // Placement badge
        let placementBadge = '';
        if (reg.placement && reg.placement.length > 0) {
            const p = reg.placement[0];
            const roomNum = p.room?.number || '?';
            const buildingName = p.room?.building?.name_ru || '';
            placementBadge = `<span class="badge badge-sm badge-ghost ml-1" title="${buildingName}">${roomNum}</span>`;
        }

        // Child badge
        const childBadge = isChild ? `<span class="badge badge-sm badge-warning ml-1">${t('retreat_guests_child')}</span>` : '';
        const childIndent = isChild ? 'pl-6' : '';

        return `
            <tr class="hover:bg-base-200 cursor-pointer${isChild ? ' opacity-80' : ''}" data-action="open-info-modal" data-id="${reg.id}">
                <td class="${childIndent}">
                    <div class="font-medium">${isChild ? '└ ' : ''}${e(name)}${placementBadge}${childBadge}</div>
                    ${v.spiritual_name ? `<div class="text-xs opacity-60">${e(v.first_name || '')} ${e(v.last_name || '')}</div>` : ''}
                </td>
                <td>
                    <select class="select select-bordered select-xs ${statusClass}"
                            data-action="update-status" data-id="${reg.id}">
                        <option value="guest" ${reg.status === 'guest' ? 'selected' : ''} data-i18n="status_guest">${t('status_guest')}</option>
                        <option value="team" ${reg.status === 'team' ? 'selected' : ''} data-i18n="status_team">${t('status_team')}</option>
                        <option value="cancelled" ${reg.status === 'cancelled' ? 'selected' : ''} data-i18n="status_cancelled">${t('status_cancelled')}</option>
                    </select>
                </td>
                <td class="text-center">${formatTransfer(arrival)}</td>
                <td class="text-center">${formatTransfer(departure)}</td>
                <td class="max-w-xs truncate text-sm opacity-70" title="${e(reg.accommodation_wishes || '')}">${e(reg.accommodation_wishes || '—')}</td>
                <td>
                    <div class="flex gap-1">
                        <button class="btn btn-ghost btn-xs" data-action="open-placement-modal" data-id="${reg.id}" title="${t('retreat_guests_placement')}">
                            🏠
                        </button>
                        <a href="person.html?id=${v.id}" class="btn btn-ghost btn-xs" data-action="navigate-person" title="${t('retreat_guests_profile')}">
                            👤
                        </a>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    // Делегирование кликов в таблице гостей
    if (!tbody._delegated) {
        tbody._delegated = true;
        tbody.addEventListener('click', ev => {
            // Остановка для select и ссылок (чтобы не открывалась модалка)
            if (ev.target.closest('select, a')) { ev.stopPropagation(); return; }
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            switch (btn.dataset.action) {
                case 'open-info-modal': openInfoModal(id); break;
                case 'open-placement-modal': ev.stopPropagation(); openPlacementModal(id); break;
            }
        });
        tbody.addEventListener('change', ev => {
            const target = ev.target.closest('[data-action="update-status"]');
            if (target) updateStatus(target.dataset.id, target.value);
        });
    }
}

function filterRegistrations() {
    let result = [...registrations];

    // Filter by status
    if (currentFilter !== 'all') {
        result = result.filter(r => r.status === currentFilter);
    }

    // Filter by search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        result = result.filter(r => {
            const v = r.vaishnava;
            const searchStr = [
                v.first_name,
                v.last_name,
                v.spiritual_name,
                v.phone,
                v.email,
                v.telegram
            ].filter(Boolean).join(' ').toLowerCase();
            return searchStr.includes(q);
        });
    }

    // Sort
    result.sort((a, b) => {
        let aVal, bVal;

        if (sortField === 'name') {
            aVal = getVaishnavName(a.vaishnava, '');
            bVal = getVaishnavName(b.vaishnava, '');
        } else if (sortField === 'status') {
            const order = { guest: 1, team: 2, cancelled: 3 };
            aVal = order[a.status] || 0;
            bVal = order[b.status] || 0;
        }

        if (sortDirection === 'asc') {
            return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        } else {
            return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
        }
    });

    return result;
}

// ==================== FILTERS & SORTING ====================
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

function toggleSort(field) {
    if (sortField === field) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortField = field;
        sortDirection = 'asc';
    }
    updateSortIcons();
    renderTable();
}

function updateSortIcons() {
    document.querySelectorAll('.sort-icon').forEach(icon => {
        icon.classList.remove('active');
        if (icon.dataset.sort === sortField) {
            icon.classList.add('active');
            icon.textContent = sortDirection === 'asc' ? '↑' : '↓';
        } else {
            icon.textContent = '↕';
        }
    });
}

// ==================== STATUS UPDATE ====================
async function updateStatus(registrationId, newStatus) {
    const { error } = await Layout.db
        .from('retreat_registrations')
        .update({ status: newStatus })
        .eq('id', registrationId);

    if (error) {
        console.error('Error updating status:', error);
        Layout.showNotification(t('error'), 'error');
        return;
    }

    // Update local state
    const reg = registrations.find(r => r.id === registrationId);
    if (reg) {
        reg.status = newStatus;
        renderTable();
    }
}

// ==================== GUEST MODAL ====================
function openGuestModal(registrationId = null) {
    const modal = document.getElementById('guestModal');
    const form = document.getElementById('guestForm');
    const title = document.getElementById('guestModalTitle');
    const searchInput = document.getElementById('vaishnavSearch');
    const selectedDisplay = document.getElementById('selectedVaishnav');

    form.reset();
    searchInput.value = '';
    selectedDisplay.classList.add('hidden');
    document.getElementById('vaishnavSuggestions').classList.add('hidden');

    if (registrationId) {
        title.textContent = t('edit_guest');
        const reg = registrations.find(r => r.id === registrationId);
        if (reg) {
            form.elements.registration_id.value = reg.id;
            form.elements.vaishnava_id.value = reg.vaishnava.id;
            form.elements.status.value = reg.status;
            form.elements.org_notes.value = reg.org_notes || '';
            form.elements.arrival_datetime.value = reg.arrival_datetime ? reg.arrival_datetime.slice(0, 16) : '';
            form.elements.departure_datetime.value = reg.departure_datetime ? reg.departure_datetime.slice(0, 16) : '';

            const v = reg.vaishnava;
            selectedDisplay.textContent = `✓ ${getVaishnavName(v)}`;
            selectedDisplay.classList.remove('hidden');
            searchInput.disabled = true;
        }
    } else {
        title.textContent = t('add_guest');
        searchInput.disabled = false;
    }

    modal.showModal();
}

function searchVaishnavas(query) {
    const suggestions = document.getElementById('vaishnavSuggestions');

    if (query.length < 2) {
        suggestions.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const matches = vaishnavas.filter(v => {
        const searchStr = [v.first_name, v.last_name, v.spiritual_name, v.phone, v.email]
            .filter(Boolean).join(' ').toLowerCase();
        return searchStr.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        suggestions.classList.add('hidden');
        return;
    }

    suggestions.innerHTML = matches.map(v => {
        const name = getVaishnavFullName(v);
        return `
            <div class="p-2 hover:bg-base-200 cursor-pointer" data-action="select-vaishnav" data-id="${v.id}">
                <div class="font-medium">${e(name)}</div>
                <div class="text-xs opacity-60">${e(v.email || '')} ${e(v.phone || '')}</div>
            </div>
        `;
    }).join('');

    // Делегирование кликов в подсказках вайшнавов
    if (!suggestions._delegated) {
        suggestions._delegated = true;
        suggestions.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="select-vaishnav"]');
            if (el) selectVaishnav(el.dataset.id);
        });
    }

    suggestions.classList.remove('hidden');
}

function selectVaishnav(id) {
    const v = vaishnavas.find(v => v.id === id);
    if (!v) return;

    document.getElementById('guestForm').elements.vaishnava_id.value = id;
    document.getElementById('vaishnavSearch').value = '';
    document.getElementById('vaishnavSuggestions').classList.add('hidden');

    const selectedDisplay = document.getElementById('selectedVaishnav');
    selectedDisplay.textContent = `✓ ${getVaishnavFullName(v)}`;
    selectedDisplay.classList.remove('hidden');
}

document.getElementById('guestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    const registrationId = form.elements.registration_id.value;
    const vaishnavId = form.elements.vaishnava_id.value;
    const status = form.elements.status.value;
    const orgNotes = form.elements.org_notes.value;
    const arrivalDatetime = form.elements.arrival_datetime.value || null;
    const departureDatetime = form.elements.departure_datetime.value || null;

    if (!vaishnavId) {
        Layout.showNotification(t('select_vaishnava'), 'warning');
        return;
    }

    // Автоперенос дат в другой ретрит или предупреждение
    let actualArrival = arrivalDatetime;
    let actualDeparture = departureDatetime;
    if (retreat) {
        const moveResult = await Utils.checkAndMoveDatesAcrossRetreats({
            db: Layout.db, registrationId: registrationId || '_new_', vaishnavId: vaishnavId,
            retreat, arrivalDatetime, departureDatetime
        });
        if (moveResult.warnings.length && !confirm(moveResult.warnings.join('\n') + '\n\n' + t('retreat_guests_save_anyway'))) return;
        if (moveResult.clearedDeparture) actualDeparture = null;
        if (moveResult.clearedArrival) actualArrival = null;
        moveResult.notifications.forEach(n => Layout.showNotification(n, 'info'));
    }

    if (registrationId) {
        // Update existing
        const { error } = await Layout.db
            .from('retreat_registrations')
            .update({
                status,
                org_notes: orgNotes || null,
                arrival_datetime: actualArrival,
                departure_datetime: actualDeparture
            })
            .eq('id', registrationId);

        if (error) {
            console.error('Error updating registration:', error);
            Layout.showNotification(t('error'), 'error');
            return;
        }

        // Синхронизируем residents.check_in/check_out (по оригинальным датам)
        const reg = registrations.find(r => r.id === registrationId);
        const residentId = reg?.placement?.[0]?.id;
        if (residentId) {
            const resUpdate = {};
            if (arrivalDatetime) resUpdate.check_in = arrivalDatetime.slice(0, 10);
            if (departureDatetime) resUpdate.check_out = departureDatetime.slice(0, 10);
            if (Object.keys(resUpdate).length > 0) {
                await Layout.db.from('residents').update(resUpdate).eq('id', residentId);
            }
        }
    } else {
        // Create new
        const { error } = await Layout.db
            .from('retreat_registrations')
            .insert({
                retreat_id: retreatId,
                vaishnava_id: vaishnavId,
                status,
                org_notes: orgNotes || null,
                arrival_datetime: actualArrival,
                departure_datetime: actualDeparture
            });

        if (error) {
            console.error('Error creating registration:', error);
            Layout.showNotification(t('error'), 'error');
            return;
        }
    }

    document.getElementById('guestModal').close();
    await loadRegistrations();
});

// ==================== INFO MODAL ====================
function openInfoModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    const v = reg.vaishnava;
    const modal = document.getElementById('infoModal');
    const title = document.getElementById('infoModalTitle');
    const content = document.getElementById('infoModalContent');

    title.textContent = getVaishnavFullName(v);

    // Format transfers
    const arrival = reg.transfers?.find(t => t.direction === 'arrival');
    const departure = reg.transfers?.find(t => t.direction === 'departure');

    const formatTransferDetails = (transfer, label) => {
        if (!transfer) return '';
        const dt = transfer.flight_datetime ? new Date(transfer.flight_datetime) : null;
        const dateStr = dt ? dt.toLocaleDateString('ru-RU') : '—';
        const timeStr = dt ? dt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
        const needsTransfer = transfer.needs_transfer === 'yes' ? `🚕 ${t('retreat_guests_needs_transfer')}` : '';

        return `
            <div class="bg-base-200 rounded-lg p-3">
                <div class="font-medium mb-1">${label}</div>
                <div class="text-sm">${dateStr} ${timeStr}</div>
                ${transfer.flight_number ? `<div class="text-sm opacity-70">${t('retreat_guests_flight')}: ${e(transfer.flight_number)}</div>` : ''}
                ${needsTransfer ? `<div class="text-sm text-primary">${needsTransfer}</div>` : ''}
                ${transfer.notes ? `<div class="text-sm opacity-60">${e(transfer.notes)}</div>` : ''}
            </div>
        `;
    };

    content.innerHTML = `
        <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
                <span class="opacity-60">${t('retreat_guests_phone')}:</span>
                <div>${v.phone ? `<a href="tel:${v.phone}" class="link">${e(v.phone)}</a>` : '—'}</div>
            </div>
            <div>
                <span class="opacity-60">${t('retreat_guests_email')}:</span>
                <div>${v.email ? `<a href="mailto:${v.email}" class="link">${e(v.email)}</a>` : '—'}</div>
            </div>
            <div>
                <span class="opacity-60">${t('retreat_guests_telegram')}:</span>
                <div>${v.telegram ? `<a href="https://t.me/${v.telegram}" target="_blank" class="link">@${e(v.telegram)}</a>` : '—'}</div>
            </div>
            <div>
                <span class="opacity-60">${t('retreat_guests_city')}:</span>
                <div>${e([v.city, v.country].filter(Boolean).join(', ') || '—')}</div>
            </div>
        </div>

        <div class="grid grid-cols-2 gap-4 mt-4">
            ${formatTransferDetails(arrival, t('retreat_guests_checkin'))}
            ${formatTransferDetails(departure, t('retreat_guests_checkout'))}
        </div>

        ${reg.companions ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_companions')}:</span>
                <div class="text-sm">${e(reg.companions)}</div>
            </div>
        ` : ''}

        ${reg.accommodation_wishes ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_accommodation_wishes')}:</span>
                <div class="text-sm">${e(reg.accommodation_wishes)}</div>
            </div>
        ` : ''}

        ${reg.extended_stay ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_extended_stay')}:</span>
                <div class="text-sm">${e(reg.extended_stay)}</div>
            </div>
        ` : ''}

        ${reg.org_notes ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_org_notes')}:</span>
                <div class="text-sm bg-warning/10 rounded p-2">${e(reg.org_notes)}</div>
            </div>
        ` : ''}

        ${reg.guest_questions ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_guest_questions')}:</span>
                <div class="text-sm">${e(reg.guest_questions)}</div>
            </div>
        ` : ''}

        ${reg.placement && reg.placement.length > 0 ? `
            <div class="mt-4">
                <span class="opacity-60 text-sm">${t('retreat_guests_placement')}:</span>
                ${reg.placement.map(p => `
                    <div class="text-sm bg-success/10 rounded p-2 mt-1">
                        🏠 ${t('retreat_guests_room')} ${e(p.room?.number || '?')} (${e(p.room?.building?.name_ru || '')})
                        <br>
                        <span class="opacity-60">${DateUtils.formatRangeShort(p.check_in, p.check_out)}</span>
                    </div>
                `).join('')}
            </div>
        ` : ''}
    `;

    modal.showModal();
}

// ==================== PLACEMENT MODAL ====================
let buildings = [];
let rooms = [];
let currentPlacementRegistration = null;
let placementMode = 'list';
let currentPlanBuilding = null;
let currentPlanFloor = null;

async function loadBuildingsAndRooms() {
    const [buildingsRes, roomsRes] = await Promise.all([
        Layout.db.from('buildings').select('id, name_ru, name_en, name_hi, floors, floor_plan_urls').order('name_ru'),
        Layout.db.from('rooms').select('id, number, floor, building_id, capacity, status, plan_x, plan_y, plan_width, plan_height').order('number')
    ]);

    if (buildingsRes.error) console.error('Error loading buildings:', buildingsRes.error);
    if (roomsRes.error) console.error('Error loading rooms:', roomsRes.error);

    buildings = buildingsRes.data || [];
    rooms = roomsRes.data || [];
}

function openPlacementModal(registrationId) {
    currentPlacementRegistration = registrations.find(r => r.id === registrationId);
    if (!currentPlacementRegistration) return;

    const modal = document.getElementById('placementModal');
    const v = currentPlacementRegistration.vaishnava;
    // Show guest info
    document.getElementById('placementGuestInfo').innerHTML = `
        <div class="font-medium">${e(getVaishnavFullName(v))}</div>
        <div class="text-sm opacity-60">${v.gender === 'male' ? `👨 ${t('retreat_guests_male')}` : v.gender === 'female' ? `👩 ${t('retreat_guests_female')}` : ''}</div>
        ${currentPlacementRegistration.accommodation_wishes ? `<div class="text-sm opacity-70 mt-1">${t('retreat_guests_wish')}: ${e(currentPlacementRegistration.accommodation_wishes)}</div>` : ''}
    `;

    // Set default dates from retreat
    const checkInInput = document.getElementById('placementCheckIn');
    const checkOutInput = document.getElementById('placementCheckOut');

    // Приоритет: размещение → arrival/departure → рейс → ретрит
    const reg = currentPlacementRegistration;
    const arrivalFlight = (reg.guest_transfers || []).find(t => t.direction === 'arrival');
    const departureFlight = (reg.guest_transfers || []).find(t => t.direction === 'departure');

    checkInInput.value = retreat?.start_date || '';
    if (arrivalFlight?.flight_datetime) checkInInput.value = arrivalFlight.flight_datetime.slice(0, 10);
    if (reg.arrival_datetime) checkInInput.value = reg.arrival_datetime.slice(0, 10);

    checkOutInput.value = retreat?.end_date || '';
    if (departureFlight?.flight_datetime) checkOutInput.value = departureFlight.flight_datetime.slice(0, 10);
    if (reg.departure_datetime) checkOutInput.value = reg.departure_datetime.slice(0, 10);

    if (reg.placement && reg.placement.length > 0) {
        const p = reg.placement[0];
        checkInInput.value = p.check_in;
        checkOutInput.value = p.check_out;
    }

    // Trigger date change to load rooms
    onPlacementDatesChange();

    modal.showModal();
}

async function onPlacementDatesChange() {
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    const messageDiv = document.getElementById('placementDateMessage');
    const roomsContainer = document.getElementById('placementRoomsContainer');

    if (!checkIn || !checkOut) {
        messageDiv.classList.remove('hidden');
        roomsContainer.classList.add('hidden');
        return;
    }

    if (checkIn >= checkOut) {
        messageDiv.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            <span>${t('retreat_guests_checkout_after_checkin')}</span>
        `;
        messageDiv.classList.remove('hidden');
        roomsContainer.classList.add('hidden');
        return;
    }

    messageDiv.classList.add('hidden');
    roomsContainer.classList.remove('hidden');

    // Render rooms
    if (placementMode === 'list') {
        await renderPlacementListView();
    } else {
        await renderPlacementPlanView();
    }
}

function switchPlacementMode(mode) {
    placementMode = mode;

    document.querySelectorAll('.placement-tabs .tab').forEach(tab => {
        tab.classList.toggle('tab-active', tab.dataset.mode === mode);
    });

    document.getElementById('placementListView').classList.toggle('hidden', mode !== 'list');
    document.getElementById('placementPlanView').classList.toggle('hidden', mode !== 'plan');

    if (mode === 'list') {
        renderPlacementListView();
    } else {
        renderPlacementPlanView();
    }
}

async function renderPlacementListView() {
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;
    const container = document.getElementById('roomsList');

    if (!checkIn || !checkOut) {
        container.innerHTML = `<div class="text-center py-4 opacity-50">${t('retreat_guests_select_dates')}</div>`;
        return;
    }

    // Get occupancy for the period
    const { data: occupancy } = await Layout.db
        .from('room_residents')
        .select('room_id, check_in, check_out')
        .or(`and(check_in.lt.${checkOut},check_out.gt.${checkIn})`);

    const occupancyMap = {};
    (occupancy || []).forEach(o => {
        if (!occupancyMap[o.room_id]) occupancyMap[o.room_id] = [];
        occupancyMap[o.room_id].push(o);
    });

    let html = '';

    buildings.forEach(building => {
        const buildingRooms = rooms.filter(r => r.building_id === building.id && r.status === 'active');
        if (buildingRooms.length === 0) return;

        const buildingName = building[`name_${Layout.currentLang}`] || building.name_ru;

        html += `<div class="font-medium text-sm opacity-60 mt-4 mb-2">${e(buildingName)}</div>`;

        buildingRooms.forEach(room => {
            const roomOccupancy = occupancyMap[room.id] || [];
            const occupiedBeds = getRoomPeakOccupancy(roomOccupancy);
            const freeBeds = room.capacity - occupiedBeds;
            const isFull = freeBeds <= 0;

            // Check if current guest is already placed here
            const isCurrentPlacement = currentPlacementRegistration.placement?.some(p => p.room?.id === room.id);

            let statusClass = 'bg-success/20 border-success';
            let statusText = `${freeBeds} ${t('retreat_guests_of')} ${room.capacity} ${t('retreat_guests_beds')}`;

            if (isFull) {
                statusClass = 'bg-error/20 border-error opacity-50';
                statusText = t('retreat_guests_occupied');
            } else if (occupiedBeds > 0) {
                statusClass = 'bg-warning/20 border-warning';
            }

            if (isCurrentPlacement) {
                statusClass = 'bg-primary/20 border-primary';
                statusText = t('retreat_guests_placed_here');
            }

            html += `
                <div class="border rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow ${statusClass} ${isFull && !isCurrentPlacement ? 'pointer-events-none' : ''}"
                     data-action="select-room" data-id="${room.id}">
                    <div class="flex justify-between items-center">
                        <div>
                            <span class="font-medium">${t('retreat_guests_room')} ${e(room.number)}</span>
                            <span class="text-sm opacity-60 ml-2">${room.floor} ${t('retreat_guests_floor')}</span>
                        </div>
                        <span class="text-sm">${statusText}</span>
                    </div>
                </div>
            `;
        });
    });

    container.innerHTML = html || `<div class="text-center py-4 opacity-50">${t('retreat_guests_no_rooms')}</div>`;

    // Делегирование кликов в списке комнат
    if (!container._delegated) {
        container._delegated = true;
        container.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="select-room"]');
            if (el) selectRoom(el.dataset.id);
        });
    }
}

async function renderPlacementPlanView() {
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    if (!checkIn || !checkOut) return;

    // Get occupancy
    const { data: occupancy } = await Layout.db
        .from('room_residents')
        .select('room_id, check_in, check_out')
        .or(`and(check_in.lt.${checkOut},check_out.gt.${checkIn})`);

    const occupancyMap = {};
    (occupancy || []).forEach(o => {
        if (!occupancyMap[o.room_id]) occupancyMap[o.room_id] = [];
        occupancyMap[o.room_id].push(o);
    });

    // Filter buildings with floor plans
    const buildingsWithPlans = buildings.filter(b => b.floor_plan_urls && Object.keys(b.floor_plan_urls).length > 0);

    if (buildingsWithPlans.length === 0) {
        document.getElementById('planBuildingTabs').innerHTML = '';
        document.getElementById('planFloorTabs').innerHTML = '';
        document.getElementById('planNoFloorPlan').classList.remove('hidden');
        document.getElementById('planFloorPlanImage').classList.add('hidden');
        document.getElementById('planFloorPlanSvg').classList.add('hidden');
        return;
    }

    // Set default building
    if (!currentPlanBuilding || !buildingsWithPlans.find(b => b.id === currentPlanBuilding)) {
        currentPlanBuilding = buildingsWithPlans[0].id;
    }

    // Render building tabs
    const buildingTabs = document.getElementById('planBuildingTabs');
    buildingTabs.innerHTML = buildingsWithPlans.map(b => {
        const name = b[`name_${Layout.currentLang}`] || b.name_ru;
        const isActive = b.id === currentPlanBuilding;
        return `<button class="tab ${isActive ? 'tab-active' : ''}" data-action="select-plan-building" data-id="${b.id}">${e(name)}</button>`;
    }).join('');
    if (!buildingTabs._delegated) {
        buildingTabs._delegated = true;
        buildingTabs.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="select-plan-building"]');
            if (btn) selectPlanBuilding(btn.dataset.id);
        });
    }

    // Get current building
    const building = buildingsWithPlans.find(b => b.id === currentPlanBuilding);
    const floorPlans = building.floor_plan_urls || {};
    const floors = Object.keys(floorPlans).map(Number).sort((a, b) => a - b);

    if (floors.length === 0) {
        document.getElementById('planFloorTabs').innerHTML = '';
        document.getElementById('planNoFloorPlan').classList.remove('hidden');
        document.getElementById('planFloorPlanImage').classList.add('hidden');
        document.getElementById('planFloorPlanSvg').classList.add('hidden');
        return;
    }

    // Set default floor
    if (!currentPlanFloor || !floors.includes(currentPlanFloor)) {
        currentPlanFloor = floors[0];
    }

    // Render floor tabs
    const floorTabs = document.getElementById('planFloorTabs');
    floorTabs.innerHTML = floors.map(f => {
        const isActive = f === currentPlanFloor;
        return `<button class="btn btn-xs ${isActive ? 'btn-primary' : 'btn-ghost'}" data-action="select-plan-floor" data-floor="${f}">${f} ${t('retreat_guests_floor')}</button>`;
    }).join('');
    if (!floorTabs._delegated) {
        floorTabs._delegated = true;
        floorTabs.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="select-plan-floor"]');
            if (btn) selectPlanFloor(Number(btn.dataset.floor));
        });
    }

    // Show floor plan
    const planUrl = floorPlans[currentPlanFloor];
    const planImage = document.getElementById('planFloorPlanImage');
    const planSvg = document.getElementById('planFloorPlanSvg');
    const noFloorPlan = document.getElementById('planNoFloorPlan');

    if (planUrl) {
        planImage.src = planUrl;
        planImage.classList.remove('hidden');
        planSvg.classList.remove('hidden');
        noFloorPlan.classList.add('hidden');

        // Wait for image to load
        planImage.onload = () => {
            renderPlanRoomMarkers(occupancyMap);
        };

        // If already loaded
        if (planImage.complete) {
            renderPlanRoomMarkers(occupancyMap);
        }
    } else {
        planImage.classList.add('hidden');
        planSvg.classList.add('hidden');
        noFloorPlan.classList.remove('hidden');
    }
}

// Пиковая одновременная занятость комнаты (sweep line)
function getRoomPeakOccupancy(residents) {
    if (!residents || residents.length === 0) return 0;
    const events = [];
    residents.forEach(r => {
        events.push({ d: r.check_in, v: 1 });
        events.push({ d: r.check_out, v: -1 });
    });
    events.sort((a, b) => a.d.localeCompare(b.d) || a.v - b.v);
    let cur = 0, peak = 0;
    events.forEach(e => { cur += e.v; peak = Math.max(peak, cur); });
    return peak;
}

function renderPlanRoomMarkers(occupancyMap) {
    const svg = document.getElementById('planFloorPlanSvg');
    const buildingRooms = rooms.filter(r =>
        r.building_id === currentPlanBuilding &&
        r.floor === currentPlanFloor &&
        r.status === 'active' &&
        r.plan_x !== null && r.plan_y !== null
    );

    let markers = '';

    buildingRooms.forEach(room => {
        const roomOccupancy = occupancyMap[room.id] || [];
        const occupiedBeds = getRoomPeakOccupancy(roomOccupancy);
        const freeBeds = room.capacity - occupiedBeds;
        const isFull = freeBeds <= 0;

        const isCurrentPlacement = currentPlacementRegistration.placement?.some(p => p.room?.id === room.id);

        let color = '#22c55e'; // green - free
        if (isCurrentPlacement) {
            color = '#3b82f6'; // blue - current
        } else if (isFull) {
            color = '#ef4444'; // red - full
        } else if (occupiedBeds > 0) {
            color = '#f59e0b'; // yellow - partial
        }

        const x = room.plan_x;
        const y = room.plan_y;
        const w = room.plan_width || 5;
        const h = room.plan_height || 5;

        markers += `
            <rect class="room-marker ${isFull && !isCurrentPlacement ? 'disabled' : ''}"
                  x="${x}" y="${y}" width="${w}" height="${h}"
                  fill="${color}" fill-opacity="0.7" rx="0.5"
                  ${isFull && !isCurrentPlacement ? '' : `data-action="select-room" data-id="${room.id}"`} />
            <text class="room-label" x="${x + w/2}" y="${y + h/2}">${room.number}</text>
        `;
    });

    svg.innerHTML = markers;

    // Делегирование кликов на SVG-плане (комнаты)
    if (!svg._delegated) {
        svg._delegated = true;
        svg.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="select-room"]');
            if (el) selectRoom(el.dataset.id);
        });
    }
}

function selectPlanBuilding(buildingId) {
    currentPlanBuilding = buildingId;
    currentPlanFloor = null; // Reset floor
    renderPlacementPlanView();
}

function selectPlanFloor(floor) {
    currentPlanFloor = floor;
    renderPlacementPlanView();
}

async function selectRoom(roomId) {
    if (!currentPlacementRegistration) return;

    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    if (!checkIn || !checkOut) {
        Layout.showNotification(t('retreat_guests_select_dates'), 'warning');
        return;
    }

    const room = rooms.find(r => r.id === roomId);
    const building = buildings.find(b => b.id === room?.building_id);

    // Check if already placed here
    const existingPlacement = currentPlacementRegistration.placement?.find(p => p.room?.id === roomId);

    if (existingPlacement) {
        // Remove placement
        const confirmed = await ModalUtils.confirm(
            t('retreat_guests_remove_placement'),
            `${t('retreat_guests_remove_from_room')} ${room.number}?`
        );
        if (!confirmed) return;

        const { error } = await Layout.db
            .from('room_residents')
            .delete()
            .eq('id', existingPlacement.id);

        if (error) {
            console.error('Error removing placement:', error);
            Layout.showNotification(t('retreat_guests_error_removing_placement'), 'error');
            return;
        }

        Layout.showNotification(t('retreat_guests_placement_removed'), 'success');
    } else {
        // Create placement
        const { error } = await Layout.db
            .from('room_residents')
            .insert({
                registration_id: currentPlacementRegistration.id,
                room_id: roomId,
                check_in: checkIn,
                check_out: checkOut
            });

        if (error) {
            console.error('Error creating placement:', error);
            Layout.showNotification(t('retreat_guests_error_placing') + ': ' + error.message, 'error');
            return;
        }

        Layout.showNotification(`${t('retreat_guests_guest_placed_in_room')} ${room.number} (${building[`name_${Layout.currentLang}`] || building.name_ru})`, 'success');
    }

    document.getElementById('placementModal').close();
    await loadRegistrations();
}

// ==================== IMPORT MODAL ====================
function openImportModal() {
    if (!retreatId) {
        Layout.showNotification(t('select_retreat_first'), 'warning');
        return;
    }

    const modal = document.getElementById('importModal');
    resetImportState();
    modal.showModal();
}

function resetImportState() {
    csvData = [];
    conflicts = [];
    importStats = { created: 0, updated: 0, skipped: 0 };

    document.getElementById('importStep1').classList.remove('hidden');
    document.getElementById('importStep2').classList.add('hidden');
    document.getElementById('importStep3').classList.add('hidden');
    document.getElementById('importStep4').classList.add('hidden');
    document.getElementById('csvPreview').classList.add('hidden');
    document.getElementById('importStartBtn').classList.remove('hidden');
    document.getElementById('importResolveBtn').classList.add('hidden');
    document.getElementById('csvFileInput').value = '';
    document.getElementById('importLog').innerHTML = '';
}

function previewCSV(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const text = e.target.result;
        csvData = parseCSV(text);

        if (csvData.length === 0) {
            Layout.showNotification(t('file_empty_or_invalid'), 'warning');
            return;
        }

        document.getElementById('rowCount').textContent = csvData.length;

        // Show preview (first 5 rows)
        const headers = Object.keys(csvData[0]);
        const previewRows = csvData.slice(0, 5);

        let tableHTML = `<thead><tr>${headers.slice(0, 6).map(h => `<th class="whitespace-nowrap">${h}</th>`).join('')}</tr></thead>`;
        tableHTML += '<tbody>';
        previewRows.forEach(row => {
            tableHTML += '<tr>';
            headers.slice(0, 6).forEach(h => {
                const val = (row[h] || '').substring(0, 30);
                tableHTML += `<td class="whitespace-nowrap">${val}</td>`;
            });
            tableHTML += '</tr>';
        });
        tableHTML += '</tbody>';

        document.getElementById('previewTable').innerHTML = tableHTML;
        document.getElementById('csvPreview').classList.remove('hidden');
    };
    reader.readAsText(file);
}

function parseCSV(text) {
    // Полноценный парсер CSV с поддержкой многострочных значений в кавычках
    const rows = [];
    let headers = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;
    let isFirstRow = true;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (inQuotes) {
            if (char === '"' && nextChar === '"') {
                // Escaped quote
                currentField += '"';
                i++;
            } else if (char === '"') {
                // End of quoted field
                inQuotes = false;
            } else {
                currentField += char;
            }
        } else {
            if (char === '"') {
                // Start of quoted field
                inQuotes = true;
            } else if (char === ',') {
                // Field separator
                currentRow.push(currentField.trim());
                currentField = '';
            } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
                // Row separator
                if (char === '\r') i++; // Skip \n after \r

                currentRow.push(currentField.trim());
                currentField = '';

                if (isFirstRow) {
                    headers = currentRow;
                    isFirstRow = false;
                } else if (currentRow.some(v => v)) {
                    // Build row object
                    const rowObj = {};
                    headers.forEach((h, idx) => {
                        rowObj[h.trim()] = currentRow[idx] || '';
                    });

                    // Skip if no name
                    if (rowObj.name || rowObj.name2) {
                        rows.push(rowObj);
                    }
                }
                currentRow = [];
            } else if (char !== '\r') {
                currentField += char;
            }
        }
    }

    // Handle last row if no trailing newline
    if (currentField || currentRow.length > 0) {
        currentRow.push(currentField.trim());
        if (!isFirstRow && currentRow.some(v => v)) {
            const rowObj = {};
            headers.forEach((h, idx) => {
                rowObj[h.trim()] = currentRow[idx] || '';
            });
            if (rowObj.name || rowObj.name2) {
                rows.push(rowObj);
            }
        }
    }

    return rows;
}

// ==================== IMPORT LOGIC ====================
async function startImport() {
    if (!retreatId) {
        Layout.showNotification(t('select_retreat_first'), 'warning');
        return;
    }

    if (csvData.length === 0) {
        Layout.showNotification(t('upload_csv_first'), 'warning');
        return;
    }

    // Switch to step 2
    document.getElementById('importStep1').classList.add('hidden');
    document.getElementById('importStep2').classList.remove('hidden');
    document.getElementById('importStartBtn').classList.add('hidden');

    const log = document.getElementById('importLog');
    const progressBar = document.getElementById('importProgressBar');
    const progressText = document.getElementById('importProgress');

    conflicts = [];
    importStats = { created: 0, updated: 0, skipped: 0 };

    for (let i = 0; i < csvData.length; i++) {
        const row = csvData[i];
        const progress = Math.round((i + 1) / csvData.length * 100);
        progressBar.value = progress;
        progressText.textContent = `${progress}%`;

        try {
            const result = await processRow(row, i + 1);

            if (result.status === 'created') {
                importStats.created++;
                logMessage(log, `✓ ${t('retreat_guests_import_created')}: ${result.name}`, 'success');
            } else if (result.status === 'updated') {
                importStats.updated++;
                logMessage(log, `↻ ${t('retreat_guests_import_updated')}: ${result.name}`, 'info');
            } else if (result.status === 'conflict') {
                conflicts.push(result);
                logMessage(log, `⚠ ${t('retreat_guests_import_conflict')}: ${result.name}`, 'warning');
            } else if (result.status === 'skipped') {
                importStats.skipped++;
                logMessage(log, `— ${t('retreat_guests_import_skipped')}: ${row.name || row.name2}`, 'info');
            }
        } catch (err) {
            logMessage(log, `✗ ${t('retreat_guests_import_error_row')} ${i + 1}: ${err.message}`, 'error');
            importStats.skipped++;
        }
    }

    // Show conflicts or done
    if (conflicts.length > 0) {
        showConflicts();
    } else {
        showImportDone();
    }
}

function logMessage(container, message, type) {
    const div = document.createElement('div');
    div.className = `log-${type}`;
    div.textContent = message;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function processRow(row, rowNum) {
    // Parse CSV fields
    const parsed = parseRowData(row);

    // Find matching vaishnava
    const match = findMatchingVaishnava(parsed);

    if (match.score >= 5) {
        // High confidence match - update
        await updateVaishnava(match.vaishnava.id, parsed);
        await createOrUpdateRegistration(match.vaishnava.id, parsed);
        return { status: 'updated', name: parsed.displayName, vaishnavId: match.vaishnava.id };
    } else if (match.score >= 3) {
        // Medium confidence - conflict
        return {
            status: 'conflict',
            name: parsed.displayName,
            parsed,
            candidates: match.candidates,
            rowNum
        };
    } else {
        // No match - create new
        const vaishnavId = await createVaishnava(parsed);
        await createOrUpdateRegistration(vaishnavId, parsed);
        return { status: 'created', name: parsed.displayName, vaishnavId };
    }
}

// Очистка "пустых" значений духовного имени
function cleanSpiritualName(value) {
    if (!value) return null;
    const cleaned = value.trim();
    const emptyValues = ['нет', 'пока нет', 'еще нет', 'ещё нет', '-', '–', '—', 'no', 'none', 'n/a'];
    if (emptyValues.includes(cleaned.toLowerCase())) return null;
    return cleaned || null;
}

// Разбор страны и города
function parseCountryCity(value) {
    if (!value) return { country: null, city: null };
    let trimmed = value.trim();

    // Нормализация названий стран
    const countryAliases = {
        'рф': 'Россия', 'российская федерация': 'Россия', 'russia': 'Россия',
        'латвии': 'Латвия', 'lithuania': 'Литва', 'usa': 'США',
        'германию': 'Германия', 'беларусь': 'Беларусь', 'белоруссия': 'Беларусь'
    };

    // Известные страны (включая варианты написания)
    const knownCountries = [
        'Россия', 'Russia', 'Украина', 'Беларусь', 'Казахстан', 'Узбекистан', 'Латвия',
        'Литва', 'Lithuania', 'Эстония', 'Молдова', 'Грузия', 'Армения', 'Азербайджан',
        'США', 'USA', 'Германия', 'Germany', 'Франция', 'Италия', 'Испания', 'Швейцария', 'Швеция',
        'Великобритания', 'Польша', 'Чехия', 'Индия', 'India', 'Китай', 'Израиль',
        'Нидерланды', 'Дания', 'РФ'
    ];

    // Известные города (для определения обратного порядка и случая "только город")
    const knownCities = [
        'Москва', 'Санкт-Петербург', 'СПб', 'Екатеринбург', 'Новосибирск',
        'Казань', 'Нижний Новгород', 'Самара', 'Омск', 'Ростов-на-Дону',
        'Уфа', 'Красноярск', 'Воронеж', 'Пермь', 'Волгоград', 'Краснодар',
        'Калининград', 'Владивосток', 'Иркутск', 'Сочи', 'Томск', 'Тюмень',
        'Йошкар-Ола', 'Стерлитамак', 'Киев', 'Минск', 'Рига', 'Вильнюс'
    ];

    // Функция нормализации страны
    function normalizeCountry(c) {
        const lower = c.toLowerCase().trim();
        return countryAliases[lower] || c;
    }

    // Убираем префиксы "г.", "г ", "город "
    function cleanCity(c) {
        return c.replace(/^(г\.|г |город )\s*/i, '').trim();
    }

    // Разделяем по запятой, точке с пробелом (но не "г.") или двойному пробелу
    let parts = trimmed.split(/,|\.\s+(?!г)|\s{2,}/).map(p => p.trim()).filter(Boolean);

    // Если одна часть и нет разделителей — пробуем разобрать по пробелу
    if (parts.length === 1 && !trimmed.includes(',')) {
        // Ищем страну в начале или конце
        for (const country of knownCountries) {
            const lower = trimmed.toLowerCase();
            const countryLower = country.toLowerCase();

            // Страна в начале: "Россия Иркутск"
            if (lower.startsWith(countryLower + ' ')) {
                const city = cleanCity(trimmed.slice(country.length).trim());
                return { country: normalizeCountry(country), city: city || null };
            }
            // Страна в конце: "Новосибирск Россия"
            if (lower.endsWith(' ' + countryLower)) {
                const city = cleanCity(trimmed.slice(0, -country.length).trim());
                return { country: normalizeCountry(country), city: city || null };
            }
        }

        // Проверяем, не является ли это просто городом
        for (const city of knownCities) {
            if (trimmed.toLowerCase() === city.toLowerCase()) {
                return { country: 'Россия', city: city }; // Предполагаем Россию для известных городов
            }
        }

        // Не удалось разобрать — всё в страну
        return { country: normalizeCountry(trimmed), city: null };
    }

    // Несколько частей — определяем где страна, где город
    let country = null;
    let city = null;

    for (const part of parts) {
        const normalized = normalizeCountry(part);
        const isCountry = knownCountries.some(c =>
            c.toLowerCase() === normalized.toLowerCase() ||
            c.toLowerCase() === part.toLowerCase()
        );

        if (isCountry) {
            country = normalized;
        } else if (!city) {
            // Первый не-страна — это город
            city = cleanCity(part);
        }
        // Остальные части (область, край) игнорируем
    }

    // Если страна не найдена, но город известный — предполагаем Россию
    if (!country && city) {
        const isKnownCity = knownCities.some(c => c.toLowerCase() === city.toLowerCase());
        if (isKnownCity) country = 'Россия';
    }

    return { country: country || null, city: city || null };
}

function parseRowData(row) {
    // Split name
    const nameParts = (row.name || '').trim().split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Parse date (DD-MM-YYYY or DD.MM.YYYY)
    let birthDate = null;
    if (row.birth) {
        const match = row.birth.match(/(\d{1,2})[-.](\d{1,2})[-.](\d{4})/);
        if (match) {
            birthDate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
        }
    }

    // Normalize phone
    const phone = normalizePhone(row.phone);

    // Normalize email
    const email = (row.email || '').toLowerCase().trim() || null;

    // Gender
    let gender = null;
    if (row['Ваш_пол']) {
        gender = row['Ваш_пол'].toLowerCase().includes('муж') ? 'male' : 'female';
    }

    // Telegram - проверяем разные варианты названия колонки
    let telegram = row.telegram_id || row.telegram || row['Телеграм'] || row['telegram_id'] || row['Telegram'] || '';
    if (telegram.startsWith('@')) telegram = telegram.substring(1);
    telegram = telegram.trim() || null;

    // Parse registration date
    let registrationDate = null;
    if (row.sent) {
        const match = row.sent.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (match) registrationDate = `${match[1]}-${match[2]}-${match[3]}`;
    }

    // Photo URL
    const photoUrl = row['Прикрепите_к_анкете_ваше_фото_можно_просто_селфи'] || null;

    return {
        firstName,
        lastName,
        spiritualName: cleanSpiritualName(row.name2),
        phone,
        email,
        birthDate,
        gender,
        ...parseCountryCity(row.country),
        indiaExperience: (row.travel_experience || '').trim() || null,
        telegram,
        photoUrl,
        displayName: `${firstName} ${lastName}`.trim() || row.name2 || t('retreat_guests_no_name'),

        // Registration fields
        registrationDate,
        companions: (row.famili || '').trim() || null,
        accommodationWishes: cleanAccommodationWishes(row.hotel),
        paymentNotes: (row.pay_date || '').trim() || null,
        orgNotes: (row['Комментарии ОП'] || '').trim() || null,
        extendedStay: (row['Планируете_ли_вы_заселиться_в_ШРСК_до_или_задержаться_после_ретрита'] || '').trim() || null,
        guestQuestions: (row.Questions || '').trim() || null,

        // Transfers
        arrivalNeeds: row.transfer_up_2 === 'Да' ? 'yes' : 'no',
        arrivalTime: row.arrival_time || null,
        arrivalFlight: row.arrival_number || null,
        departureNeeds: row.transfer_back === 'Да' ? 'yes' : 'no',
        departureTime: row.departure_time || null,
        departureFlight: row.departure_number || null
    };
}

function normalizePhone(phone) {
    if (!phone) return null;
    let clean = phone.replace(/[^\d+]/g, '');
    if (clean.match(/^8\d{10}$/)) {
        clean = '+7' + clean.slice(1);
    }
    if (!clean.startsWith('+') && clean.length >= 10) {
        clean = '+' + clean;
    }
    return clean || null;
}

function cleanAccommodationWishes(value) {
    if (!value) return null;
    let clean = value.trim();

    // Замены длинных строк на короткие
    const replacements = [
        ['Бридж Васундар (стандартное размещение, на небольшом расстоянии от места проведения программ)', 'Бридж Васундар'],
        ['Если будет место, хочу проживать в Шри Рупа Сева Кундж (главная площадка, место проведение программ)', 'ШРСК'],
        ['Рукмини Дхам (недорогой, но вполне комфортный отель, на некотором расстоянии от места проведения программ)', 'Рукмини-дхам'],
        ['Напишите, если у вас свой вариант размещения:', ''],
        ['Пожелание: ', '']
    ];

    for (const [from, to] of replacements) {
        clean = clean.replace(from, to);
    }

    return clean.trim() || null;
}

function combineNotes(...notes) {
    return notes.filter(n => n && n.trim()).join('\n\n').trim() || null;
}

function findMatchingVaishnava(parsed) {
    let bestMatch = { score: 0, vaishnava: null, candidates: [] };

    for (const v of vaishnavas) {
        let score = 0;
        let birthDateConflict = false;

        // Проверяем конфликт дат рождения (разные люди в одной семье с общим email/телефоном)
        if (parsed.birthDate && v.birth_date && parsed.birthDate !== v.birth_date) {
            const d1 = DateUtils.parseDate(parsed.birthDate);
            const d2 = DateUtils.parseDate(v.birth_date);
            const yearsDiff = Math.abs(d1.getFullYear() - d2.getFullYear());
            // Если разница более 3 лет — это разные люди
            if (yearsDiff > 3) {
                birthDateConflict = true;
            }
        }

        // Email match (+5) — но не если конфликт дат рождения
        if (parsed.email && v.email && parsed.email.toLowerCase() === v.email.toLowerCase()) {
            if (!birthDateConflict) {
                score += 5;
            }
        }

        // Phone match (+4) — но не если конфликт дат рождения
        if (parsed.phone && v.phone) {
            const p1 = parsed.phone.replace(/\D/g, '');
            const p2 = v.phone.replace(/\D/g, '');
            if (p1.length >= 10 && p2.length >= 10 && p1.slice(-10) === p2.slice(-10)) {
                if (!birthDateConflict) {
                    score += 4;
                }
            }
        }

        // Spiritual name match (+3)
        if (parsed.spiritualName && v.spiritual_name) {
            const s1 = parsed.spiritualName.toLowerCase().replace(/\s+/g, '');
            const s2 = v.spiritual_name.toLowerCase().replace(/\s+/g, '');
            if (s1 === s2 || s1.includes(s2) || s2.includes(s1)) {
                score += 3;
            }
        }

        // Telegram match (+3)
        if (parsed.telegram && v.telegram) {
            const t1 = parsed.telegram.toLowerCase().replace('@', '');
            const t2 = v.telegram.toLowerCase().replace('@', '');
            if (t1 === t2) {
                score += 3;
            }
        }

        // Name match (+2)
        if (parsed.firstName && v.first_name) {
            const f1 = parsed.firstName.toLowerCase();
            const f2 = v.first_name.toLowerCase();
            const l1 = (parsed.lastName || '').toLowerCase();
            const l2 = (v.last_name || '').toLowerCase();
            if (f1 === f2 && l1 === l2) {
                score += 2;
            }
        }

        // Birth date match (+2)
        if (parsed.birthDate && v.birth_date && parsed.birthDate === v.birth_date) {
            score += 2;
        }

        if (score > 0) {
            bestMatch.candidates.push({ vaishnava: v, score });
        }

        if (score > bestMatch.score) {
            bestMatch.score = score;
            bestMatch.vaishnava = v;
        }
    }

    // Sort candidates by score
    bestMatch.candidates.sort((a, b) => b.score - a.score);

    return bestMatch;
}

async function createVaishnava(parsed) {
    const { data, error } = await Layout.db
        .from('vaishnavas')
        .insert({
            first_name: parsed.firstName || null,
            last_name: parsed.lastName || null,
            spiritual_name: parsed.spiritualName,
            phone: parsed.phone,
            email: parsed.email,
            birth_date: parsed.birthDate,
            gender: parsed.gender,
            country: parsed.country,
            city: parsed.city,
            india_experience: parsed.indiaExperience,
            telegram: parsed.telegram,
            photo_url: parsed.photoUrl,
            is_team_member: false
        })
        .select('id')
        .single();

    if (error) throw error;

    // Add to local cache (snake_case для совместимости с findMatchingVaishnava)
    vaishnavas.push({
        id: data.id,
        first_name: parsed.firstName,
        last_name: parsed.lastName,
        spiritual_name: parsed.spiritualName,
        phone: parsed.phone,
        email: parsed.email,
        birth_date: parsed.birthDate,
        gender: parsed.gender,
        telegram: parsed.telegram
    });

    return data.id;
}

async function updateVaishnava(id, parsed) {
    const updates = {};

    // Only update if value exists in CSV
    if (parsed.phone) updates.phone = parsed.phone;
    if (parsed.email) updates.email = parsed.email;
    if (parsed.birthDate) updates.birth_date = parsed.birthDate;
    if (parsed.gender) updates.gender = parsed.gender;
    if (parsed.country) updates.country = parsed.country;
    if (parsed.city) updates.city = parsed.city;
    if (parsed.indiaExperience) updates.india_experience = parsed.indiaExperience;
    if (parsed.telegram) updates.telegram = parsed.telegram;
    if (parsed.photoUrl) updates.photo_url = parsed.photoUrl;

    if (Object.keys(updates).length > 0) {
        const { error } = await Layout.db
            .from('vaishnavas')
            .update(updates)
            .eq('id', id);

        if (error) throw error;
    }
}

async function createOrUpdateRegistration(vaishnavId, parsed) {
    // Check if registration already exists
    const { data: existing } = await Layout.db
        .from('retreat_registrations')
        .select('id')
        .eq('retreat_id', retreatId)
        .eq('vaishnava_id', vaishnavId)
        .maybeSingle();

    const regData = {
        retreat_id: retreatId,
        vaishnava_id: vaishnavId,
        registration_date: parsed.registrationDate,
        status: 'guest', // VERSION 2.0 - UPDATED STATUS
        companions: parsed.companions,
        accommodation_wishes: parsed.accommodationWishes,
        payment_notes: parsed.paymentNotes,
        org_notes: parsed.orgNotes,
        extended_stay: parsed.extendedStay,
        guest_questions: parsed.guestQuestions
    };

    console.log('💾 Saving registration with status:', regData.status, 'Full data:', regData);

    let registrationId;

    if (existing) {
        // Update
        const { error } = await Layout.db
            .from('retreat_registrations')
            .update(regData)
            .eq('id', existing.id);
        if (error) throw error;
        registrationId = existing.id;
    } else {
        // Insert
        const { data, error } = await Layout.db
            .from('retreat_registrations')
            .insert(regData)
            .select('id')
            .single();
        if (error) throw error;
        registrationId = data.id;
    }

    // Create transfers
    await createTransfers(registrationId, parsed);
}

async function createTransfers(registrationId, parsed) {
    // Delete existing transfers for this registration
    await Layout.db
        .from('guest_transfers')
        .delete()
        .eq('registration_id', registrationId);

    const transfers = [];
    const retreatYear = retreat?.start_date ? DateUtils.parseDate(retreat.start_date).getFullYear() : null;

    // Arrival
    if (parsed.arrivalTime || parsed.arrivalFlight) {
        const flightDatetime = DateUtils.parseDateTimeString(parsed.arrivalTime, retreatYear);
        transfers.push({
            registration_id: registrationId,
            direction: 'arrival',
            needs_transfer: parsed.arrivalNeeds,
            flight_number: parsed.arrivalFlight,
            flight_datetime: flightDatetime,
            notes: flightDatetime ? null : parsed.arrivalTime // Save to notes only if can't parse
        });
    }

    // Departure
    if (parsed.departureTime || parsed.departureFlight) {
        const flightDatetime = DateUtils.parseDateTimeString(parsed.departureTime, retreatYear);
        transfers.push({
            registration_id: registrationId,
            direction: 'departure',
            needs_transfer: parsed.departureNeeds,
            flight_number: parsed.departureFlight,
            flight_datetime: flightDatetime,
            notes: flightDatetime ? null : parsed.departureTime // Save to notes only if can't parse
        });
    }

    if (transfers.length > 0) {
        const { error } = await Layout.db
            .from('guest_transfers')
            .insert(transfers);
        if (error) console.error('Error creating transfers:', error);
    }
}

// ==================== CONFLICTS UI ====================
function showConflicts() {
    document.getElementById('importStep2').classList.add('hidden');
    document.getElementById('importStep3').classList.remove('hidden');
    document.getElementById('importResolveBtn').classList.remove('hidden');

    const container = document.getElementById('conflictsList');
    container.innerHTML = conflicts.map((c, idx) => {
        const parsed = c.parsed;
        const candidate = c.candidates[0]?.vaishnava;

        return `
            <div class="conflict-card bg-base-100 rounded-lg p-4">
                <div class="flex justify-between items-start mb-3">
                    <div>
                        <strong>${t('retreat_guests_row')} ${c.rowNum}:</strong> ${e(c.name)}
                        <span class="badge badge-sm ml-2">${c.candidates[0]?.score || 0} ${t('retreat_guests_points')}</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 text-sm mb-3">
                    <div>
                        <div class="font-medium mb-1">${t('retreat_guests_in_csv')}:</div>
                        <div>${e(parsed.firstName)} ${e(parsed.lastName)}</div>
                        <div>${e(parsed.spiritualName || '—')}</div>
                        <div>${e(parsed.email || '—')}</div>
                        <div>${e(parsed.phone || '—')}</div>
                    </div>
                    <div>
                        <div class="font-medium mb-1">${t('retreat_guests_in_db')}:</div>
                        ${candidate ? `
                            <div class="${parsed.firstName === candidate.first_name ? 'match-same' : 'match-diff'}">${e(candidate.first_name)} ${e(candidate.last_name || '')}</div>
                            <div class="${parsed.spiritualName === candidate.spiritual_name ? 'match-same' : 'match-diff'}">${e(candidate.spiritual_name || '—')}</div>
                            <div class="${parsed.email === candidate.email ? 'match-same' : 'match-diff'}">${e(candidate.email || '—')}</div>
                            <div class="${normalizePhone(parsed.phone) === normalizePhone(candidate.phone) ? 'match-same' : 'match-diff'}">${e(candidate.phone || '—')}</div>
                        ` : `<div class="opacity-50">${t('retreat_guests_no_matches')}</div>`}
                    </div>
                </div>

                <div class="flex gap-4">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="update" class="radio radio-sm" ${candidate ? 'checked' : ''} />
                        <span>${t('retreat_guests_same_person_update')}</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="create" class="radio radio-sm" ${!candidate ? 'checked' : ''} />
                        <span>${t('retreat_guests_create_new')}</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="skip" class="radio radio-sm" />
                        <span>${t('retreat_guests_skip')}</span>
                    </label>
                </div>
            </div>
        `;
    }).join('');
}

async function resolveConflicts() {
    document.getElementById('importResolveBtn').disabled = true;

    for (let i = 0; i < conflicts.length; i++) {
        const c = conflicts[i];
        const decision = document.querySelector(`input[name="conflict_${i}"]:checked`)?.value;

        try {
            if (decision === 'update' && c.candidates[0]) {
                await updateVaishnava(c.candidates[0].vaishnava.id, c.parsed);
                await createOrUpdateRegistration(c.candidates[0].vaishnava.id, c.parsed);
                importStats.updated++;
            } else if (decision === 'create') {
                const vaishnavId = await createVaishnava(c.parsed);
                await createOrUpdateRegistration(vaishnavId, c.parsed);
                importStats.created++;
            } else {
                importStats.skipped++;
            }
        } catch (err) {
            console.error('Error resolving conflict:', err);
            importStats.skipped++;
        }
    }

    showImportDone();
}

function showImportDone() {
    document.getElementById('importStep2').classList.add('hidden');
    document.getElementById('importStep3').classList.add('hidden');
    document.getElementById('importStep4').classList.remove('hidden');
    document.getElementById('importResolveBtn').classList.add('hidden');

    const totalProcessed = importStats.created + importStats.updated + importStats.skipped + conflicts.length;
    const csvCount = csvData.length;

    let summary = `${t('retreat_guests_import_created')}: ${importStats.created}, ${t('retreat_guests_import_updated')}: ${importStats.updated}, ${t('retreat_guests_import_skipped')}: ${importStats.skipped}`;

    // Проверка количества: входные строки должны совпадать с обработанными
    if (totalProcessed !== csvCount) {
        summary += `\n⚠️ ${t('retreat_guests_import_mismatch')}: CSV ${csvCount}, ${t('retreat_guests_import_processed')} ${totalProcessed}!`;
        console.error(`Несовпадение количества! CSV: ${csvCount}, обработано: ${totalProcessed}`);
    }

    document.getElementById('importSummary').innerHTML = summary.replace('\n', '<br>');

    // Reload data
    loadRegistrations();
    loadVaishnavas();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'retreat_guests' });
    Layout.showLoader();

    await Promise.all([loadAllRetreats(), loadVaishnavas(), loadBuildingsAndRooms()]);

    setupFilters();
    updateSortIcons();

    Layout.hideLoader();
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    renderTable();
};

console.log('🚀 retreat-guests.js VERSION 2.0 - Status fixed to GUEST');
init();
