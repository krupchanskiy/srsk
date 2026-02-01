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
    const data = await Cache.getOrLoad('all_retreats', async () => {
        const { data, error } = await Layout.db
            .from('retreats')
            .select('id, name_ru, name_en, name_hi, start_date, end_date, color')
            .order('start_date', { ascending: false });
        if (error) { console.error('Error loading retreats:', error); return []; }
        return data || [];
    }, 5 * 60 * 1000); // 5 минут TTL

    allRetreats = data;

    // Populate select
    const select = document.getElementById('retreatSelect');
    select.innerHTML = '<option value="">Выберите ретрит...</option>' +
        allRetreats.map(r => `<option value="${r.id}">${Layout.getName(r)}</option>`).join('');

    // Check URL for retreat id
    const params = new URLSearchParams(window.location.search);
    const urlId = params.get('id');

    if (urlId && allRetreats.find(r => r.id === urlId)) {
        select.value = urlId;
        await selectRetreat(urlId);
    } else if (allRetreats.length > 0) {
        // Auto-select nearest retreat
        const today = new Date().toISOString().split('T')[0];

        // Find future or current retreats (end_date >= today)
        const futureRetreats = allRetreats
            .filter(r => r.end_date >= today)
            .sort((a, b) => a.start_date.localeCompare(b.start_date));

        // Select nearest future, or most recent past
        const nearest = futureRetreats[0] || allRetreats[0];
        select.value = nearest.id;
        await selectRetreat(nearest.id);
    }
}

async function selectRetreat(id) {
    retreatId = id;
    retreat = allRetreats.find(r => r.id === id);

    if (!retreat) return;

    document.getElementById('retreatDates').textContent = formatDateRange(retreat.start_date, retreat.end_date);
    document.title = `${Layout.getName(retreat)} — ШРСК`;

    // Update URL
    const url = new URL(window.location);
    url.searchParams.set('id', id);
    history.replaceState(null, '', url);

    // Load data (здания перезагружаем для фильтрации временных по датам ретрита)
    await Promise.all([loadRegistrations(), loadBuildingsAndRooms()]);
}

function onRetreatChange(id) {
    if (!id) {
        retreatId = null;
        retreat = null;
        registrations = [];
        document.getElementById('retreatDates').textContent = '';
        renderTable();
        return;
    }
    selectRetreat(id);
}


async function loadRegistrations() {
    if (!retreatId) {
        registrations = [];
        renderTable();
        return;
    }

    const { data, error } = await Layout.db
        .from('retreat_registrations')
        .select(`
            *,
            vaishnavas (id, first_name, last_name, spiritual_name, phone, email, telegram, has_whatsapp, photo_url, gender, birth_date, india_experience),
            guest_transfers (*)
        `)
        .eq('retreat_id', retreatId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false });

    if (error) {
        console.error('Error loading registrations:', error);
        return;
    }

    registrations = data || [];

    // Загружаем размещения из residents (единая таблица для шахматки)
    // Исключаем выселенных (checked_out)
    const vaishnavIds = registrations.map(r => r.vaishnava_id).filter(Boolean);
    if (vaishnavIds.length > 0) {
        const { data: residentsData } = await Layout.db
            .from('residents')
            .select('*, rooms(id, number, building_id, buildings(id, name_ru, name_en, name_hi))')
            .eq('retreat_id', retreatId)
            .in('vaishnava_id', vaishnavIds)
            .in('status', ['active', 'confirmed']);

        // Привязываем residents к регистрациям
        const residentsByVaishnava = (residentsData || []).reduce((acc, res) => {
            acc[res.vaishnava_id] = res;
            return acc;
        }, {});

        registrations.forEach(reg => {
            reg.resident = residentsByVaishnava[reg.vaishnava_id] || null;
        });
    }

    // Загрузить занятость комнат для корректного отображения
    await loadRoomOccupancy();

    renderTable();
}

async function loadRoomOccupancy() {
    if (!retreat?.start_date || !retreat?.end_date) {
        placementState.occupancy = {};
        return;
    }

    const { data: residentsData, error } = await Layout.db
        .from('residents')
        .select('id, room_id')
        .not('room_id', 'is', null)
        .in('status', ['active', 'confirmed'])
        .lte('check_in', retreat.end_date)
        .gte('check_out', retreat.start_date);

    if (error) {
        console.error('Error loading room occupancy:', error);
        placementState.occupancy = {};
        return;
    }

    // Подсчёт занятости по комнатам
    placementState.occupancy = {};
    (residentsData || []).forEach(r => {
        if (r.room_id) {
            placementState.occupancy[r.room_id] = (placementState.occupancy[r.room_id] || 0) + 1;
        }
    });
}

async function loadVaishnavas() {
    const { data, error } = await Layout.db
        .from('vaishnavas')
        .select('id, first_name, last_name, spiritual_name, phone, email, telegram, birth_date, is_team_member, photo_url')
        .eq('is_deleted', false)
        .order('first_name');

    if (error) {
        console.error('Error loading vaishnavas:', error);
        return;
    }

    vaishnavas = data || [];
}

// ==================== RENDERING ====================
function formatDateRange(start, end) {
    const lang = Layout.currentLang;
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    const locale = lang === 'hi' ? 'hi-IN' : lang === 'en' ? 'en-US' : 'ru-RU';
    const s = new Date(start).toLocaleDateString(locale, opts);
    const e = new Date(end).toLocaleDateString(locale, opts);
    return `${s} — ${e}`;
}

function calculateAge(birthDate) {
    if (!birthDate) return '';
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    return age;
}

function formatFlightDateTime(datetime, fallbackNotes) {
    if (!datetime) return fallbackNotes ? fallbackNotes.substring(0, 20) : '';
    const date = new Date(datetime);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day}.${month} ${hours}:${minutes}`;
}

function onSearchInput(query) {
    searchQuery = query.toLowerCase().trim();
    document.getElementById('searchClear').classList.toggle('hidden', !query);
    renderTable();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchClear').classList.add('hidden');
    searchQuery = '';
    renderTable();
}

function filterRegistrations() {
    let filtered;

    if (currentFilter === 'all') {
        filtered = [...registrations];
    } else if (currentFilter === 'accommodated') {
        // Показать только заселённых (есть размещение с гостиницей и комнатой)
        filtered = registrations.filter(r => r.resident && r.resident.room_id);
    } else if (currentFilter === 'not_accommodated') {
        // Показать только не заселённых (нет размещения или нет комнаты)
        filtered = registrations.filter(r => !r.resident || !r.resident.room_id);
    } else {
        // Фильтр по статусу (guest, team, cancelled)
        filtered = registrations.filter(r => r.status === currentFilter);
    }

    // Apply search filter
    if (searchQuery) {
        filtered = filtered.filter(r => {
            const v = r.vaishnavas;
            if (!v) return false;
            const fullName = `${v.first_name || ''} ${v.last_name || ''}`.toLowerCase();
            const spiritualName = (v.spiritual_name || '').toLowerCase();
            return fullName.includes(searchQuery) || spiritualName.includes(searchQuery);
        });
    }

    // Sort
    filtered.sort((a, b) => {
        let aVal, bVal;

        if (sortField === 'name') {
            aVal = (a.vaishnavas?.spiritual_name || `${a.vaishnavas?.first_name || ''} ${a.vaishnavas?.last_name || ''}`.trim()).toLowerCase();
            bVal = (b.vaishnavas?.spiritual_name || `${b.vaishnavas?.first_name || ''} ${b.vaishnavas?.last_name || ''}`.trim()).toLowerCase();
        } else if (sortField === 'gender_age') {
            // Сортировка по полу, потом по возрасту
            const genderOrder = { male: 1, female: 2 };
            const aGender = genderOrder[a.vaishnavas?.gender] || 3;
            const bGender = genderOrder[b.vaishnavas?.gender] || 3;
            if (aGender !== bGender) {
                aVal = aGender;
                bVal = bGender;
            } else {
                aVal = a.vaishnavas?.birth_date || '9999';
                bVal = b.vaishnavas?.birth_date || '9999';
            }
        } else if (sortField === 'india_experience') {
            aVal = (a.vaishnavas?.india_experience || '').toLowerCase();
            bVal = (b.vaishnavas?.india_experience || '').toLowerCase();
        } else if (sortField === 'arrival') {
            const aTransfer = (a.guest_transfers || []).find(t => t.direction === 'arrival');
            const bTransfer = (b.guest_transfers || []).find(t => t.direction === 'arrival');
            aVal = aTransfer?.flight_datetime || '9999';
            bVal = bTransfer?.flight_datetime || '9999';
        } else if (sortField === 'departure') {
            const aTransfer = (a.guest_transfers || []).find(t => t.direction === 'departure');
            const bTransfer = (b.guest_transfers || []).find(t => t.direction === 'departure');
            aVal = aTransfer?.flight_datetime || '9999';
            bVal = bTransfer?.flight_datetime || '9999';
        } else if (sortField === 'notes') {
            // Сортировка по локальным заметкам - пустые заметки всегда внизу
            const aNotes = getLocalNotes(a.id);
            const bNotes = getLocalNotes(b.id);

            // Если оба пустые - не меняем порядок
            if (!aNotes && !bNotes) return 0;
            // Если только a пустое - оно всегда в конец (независимо от направления)
            if (!aNotes) return 1;
            // Если только b пустое - оно всегда в конец
            if (!bNotes) return -1;

            // Оба не пустые - сортируем нормально
            aVal = aNotes.toLowerCase();
            bVal = bNotes.toLowerCase();
        } else if (sortField === 'building') {
            // Сортировка по названию здания
            const aBuilding = buildings.find(bldg => bldg.id === a.resident?.rooms?.building_id);
            const bBuilding = buildings.find(bldg => bldg.id === b.resident?.rooms?.building_id);
            aVal = aBuilding ? Layout.getName(aBuilding).toLowerCase() : 'zzz';
            bVal = bBuilding ? Layout.getName(bBuilding).toLowerCase() : 'zzz';
        } else if (sortField === 'room') {
            // Сортировка по номеру комнаты
            aVal = (a.resident?.rooms?.number || 'zzz').toLowerCase();
            bVal = (b.resident?.rooms?.number || 'zzz').toLowerCase();
        } else if (sortField === 'meal_type') {
            // Сортировка по типу питания
            const mealOrder = { prasad: 1, self: 2, child: 3 };
            aVal = a.meal_type ? mealOrder[a.meal_type] || 99 : 99;
            bVal = b.meal_type ? mealOrder[b.meal_type] || 99 : 99;
        } else {
            // companions, accommodation_wishes, extended_stay, guest_questions, org_notes
            aVal = (a[sortField] || '').toLowerCase();
            bVal = (b[sortField] || '').toLowerCase();
        }

        if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
        return 0;
    });

    return filtered;
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

function replaceWithPlaceholder(img) {
    const initials = img.dataset.initials || '?';
    const placeholder = document.createElement('div');
    placeholder.className = 'guest-photo-placeholder';
    placeholder.textContent = initials;
    img.replaceWith(placeholder);
}

// Глобальный обработчик клика по аватарам (event delegation для XSS-безопасности)
document.addEventListener('click', function(event) {
    const avatarPhoto = event.target.closest('.avatar-photo');
    if (avatarPhoto && avatarPhoto.dataset.photoUrl) {
        event.stopPropagation();
        Layout.openPhotoModal(avatarPhoto.dataset.photoUrl);
    }
});

function updateSortIcons() {
    document.querySelectorAll('.sort-icon').forEach(icon => {
        const field = icon.dataset.sort;
        if (field === sortField) {
            icon.classList.add('active');
            icon.textContent = sortDirection === 'asc' ? '↑' : '↓';
        } else {
            icon.classList.remove('active');
            icon.textContent = '↕';
        }
    });
}

function renderTable() {
    const filtered = filterRegistrations();
    const tbody = document.getElementById('guestsTable');
    const noGuests = document.getElementById('noGuests');

    if (filtered.length === 0) {
        tbody.innerHTML = '';
        noGuests.classList.remove('hidden');
        return;
    }

    noGuests.classList.add('hidden');

    // Переводы для типов питания
    const mealTypeNotSpecified = t('not_specified');
    const mealTypePrasad = t('meal_type_prasad');
    const mealTypeSelf = t('meal_type_self');
    const mealTypeChild = t('meal_type_child');

    tbody.innerHTML = filtered.map(reg => {
        const v = reg.vaishnavas;
        const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
        const spiritualName = v?.spiritual_name || '';
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');

        // Пол и возраст
        const genderLabel = v?.gender === 'male' ? 'М' : v?.gender === 'female' ? 'Ж' : '';
        const age = v?.birth_date ? calculateAge(v.birth_date) : '';
        const genderAge = [genderLabel, age].filter(Boolean).join(', ') || '—';

        // Format arrival/departure info
        const arrivalDate = formatFlightDateTime(arrival?.flight_datetime, arrival?.notes);
        const arrivalTransfer = arrival?.needs_transfer === 'yes' ? ' 🚐' : '';
        const departureDate = formatFlightDateTime(departure?.flight_datetime, departure?.notes);
        const departureTransfer = departure?.needs_transfer === 'yes' ? ' 🚐' : '';

        // Проверка на проблемы: нет данных вообще, или есть notes но нет datetime
        const arrivalProblem = !arrival || (arrival?.notes && !arrival?.flight_datetime);
        const departureProblem = !departure || (departure?.notes && !departure?.flight_datetime);

        // Получить локальные заметки
        const localNotes = getLocalNotes(reg.id);

        // Получить размещение
        const resident = reg.resident;
        // If resident exists but room_id is NULL, it's self-accommodation
        const buildingId = resident && !resident.room_id ? 'self' : (resident?.rooms?.building_id || null);
        const roomId = resident?.room_id || null;

        // Фото и инициалы
        const photoUrl = v?.photo_url;
        const initials = spiritualName
            ? spiritualName.split(' ').map(w => w[0]).join('').substring(0, 2)
            : name.split(' ').map(w => w[0]).join('').substring(0, 2);
        const initialsUpper = e(initials.toUpperCase());

        return `
            <tr class="hover align-top">
                <td class="cursor-pointer ${buildingId === 'self' ? 'bg-error/20' : (buildingId && roomId) ? 'bg-success/20' : ''}" onclick="window.location.href='person.html?id=${v?.id}'">
                    <div class="flex gap-3 items-center">
                        ${photoUrl
                            ? `<img src="${e(photoUrl)}" class="guest-photo avatar-photo" alt="" data-initials="${initialsUpper}" data-photo-url="${e(photoUrl)}" onerror="replaceWithPlaceholder(this)">`
                            : `<div class="guest-photo-placeholder">${initialsUpper}</div>`
                        }
                        <div>
                            ${spiritualName ? `<div class="font-medium">${e(spiritualName)}</div>` : ''}
                            <div class="${spiritualName ? 'text-xs opacity-60' : 'font-medium'}">${e(name)}</div>
                        </div>
                    </div>
                </td>
                <td class="text-sm whitespace-nowrap ${v?.gender === 'male' ? 'bg-blue-500/10' : v?.gender === 'female' ? 'bg-pink-500/10' : ''}">${genderAge}</td>
                <td class="text-sm">${e(v?.india_experience || '—')}</td>
                <td class="text-sm">${e(reg.companions || '—')}</td>
                <td class="text-sm">${e(reg.accommodation_wishes || '—')}</td>
                <td class="text-center text-sm whitespace-nowrap ${arrivalProblem ? 'bg-warning/30' : ''}">
                    ${arrivalDate ? `${arrivalDate}${arrivalTransfer}` : '<span class="opacity-30">—</span>'}
                </td>
                <td class="text-center text-sm whitespace-nowrap ${departureProblem ? 'bg-warning/30' : ''}">
                    ${departureDate ? `${departureDate}${departureTransfer}` : '<span class="opacity-30">—</span>'}
                </td>
                <td class="text-sm">${e(reg.extended_stay || '—')}</td>
                <td class="text-sm">${e(reg.guest_questions || '—')}</td>
                <td class="text-sm">${e(reg.org_notes || '—')}</td>
                <td class="text-sm">
                    <select class="select select-xs select-bordered w-full ${reg.meal_type === 'prasad' ? 'meal-prasad' : reg.meal_type === 'self' ? 'meal-self' : reg.meal_type === 'child' ? 'meal-child' : ''}"
                        onchange="onMealTypeChange('${reg.id}', this.value, this)"
                        onclick="event.stopPropagation()">
                        <option value="" ${!reg.meal_type ? 'selected' : ''}>${mealTypeNotSpecified}</option>
                        <option value="prasad" ${reg.meal_type === 'prasad' ? 'selected' : ''}>${mealTypePrasad}</option>
                        <option value="self" ${reg.meal_type === 'self' ? 'selected' : ''}>${mealTypeSelf}</option>
                        <option value="child" ${reg.meal_type === 'child' ? 'selected' : ''}>${mealTypeChild}</option>
                    </select>
                </td>
                <td class="text-sm">
                    <textarea
                        class="textarea textarea-xs textarea-bordered w-full auto-resize-textarea"
                        rows="1"
                        placeholder="${t('preliminary_notes_placeholder')}"
                        oninput="autoResizeTextarea(this)"
                        onchange="saveLocalNotes('${reg.id}', this.value)"
                        onclick="event.stopPropagation()">${e(localNotes || '')}</textarea>
                </td>
                <td class="text-sm ${buildingId === 'self' ? 'bg-error/20' : buildingId ? 'bg-success/20' : ''}">
                    <select class="select select-xs select-bordered w-full"
                        onchange="onBuildingChange('${reg.id}', this.value)"
                        onclick="event.stopPropagation()">
                        <option value="">—</option>
                        ${buildings.map(b => `<option value="${b.id}" ${buildingId === b.id ? 'selected' : ''}>${Layout.getName(b)}</option>`).join('')}
                        <option value="self" ${buildingId === 'self' ? 'selected' : ''}>${t('self_accommodation')}</option>
                    </select>
                </td>
                <td class="text-sm ${buildingId === 'self' ? 'bg-error/20' : roomId ? 'bg-success/20' : ''}">
                    <select class="select select-xs select-bordered w-full ${buildingId === 'self' ? 'hidden' : ''}"
                        id="room_select_${reg.id}"
                        onchange="onRoomChange('${reg.id}', this.value)"
                        onclick="event.stopPropagation()">
                        ${buildingId && buildingId !== 'self' ? renderRoomOptions(buildingId, roomId, reg.id) : '<option value="">—</option>'}
                    </select>
                    ${buildingId === 'self' ? `<span class="text-sm opacity-50">${t('self_accommodation')}</span>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    // Автоматическая подстройка высоты для всех textarea с заметками
    setTimeout(() => {
        document.querySelectorAll('.auto-resize-textarea').forEach(textarea => {
            autoResizeTextarea(textarea);
        });
    }, 0);
}

// ==================== NOTES (LOCAL STORAGE) ====================
function getLocalNotes(registrationId) {
    const key = `preliminary_notes_${registrationId}`;
    return localStorage.getItem(key);
}

function saveLocalNotes(registrationId, value) {
    const key = `preliminary_notes_${registrationId}`;
    if (value && value.trim()) {
        localStorage.setItem(key, value.trim());
    } else {
        localStorage.removeItem(key);
    }
}

// Автоматическая подстройка высоты textarea
function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

// ==================== BUILDING & ROOM SELECTION ====================
function renderRoomOptions(buildingId, selectedRoomId, registrationId) {
    const building = buildings.find(b => b.id === buildingId);
    if (!building || !building.rooms) return '<option value="">—</option>';

    const reg = registrations.find(r => r.id === registrationId);
    const existingResidentId = reg?.resident?.id || null;
    const currentRoomId = reg?.resident?.room_id || null;

    // Фильтруем и сортируем комнаты
    const rooms = building.rooms
        .filter(r => r.is_active)
        .sort((a, b) => {
            if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
            return a.number.localeCompare(b.number, undefined, { numeric: true });
        });

    let html = '<option value="">—</option>';
    rooms.forEach(room => {
        // Проверяем занятость (исключая текущую комнату при переселении)
        let occupied = placementState.occupancy[room.id] || 0;

        // Если это текущая комната резидента, уменьшаем занятость на 1
        if (currentRoomId === room.id && existingResidentId) {
            occupied = Math.max(0, occupied - 1);
        }

        const capacity = room.capacity || 1;
        const isFull = occupied >= capacity;

        const label = isFull ? `${room.number} (занято)` : room.number;
        const disabled = isFull ? 'disabled' : '';
        const selected = selectedRoomId === room.id ? 'selected' : '';

        html += `<option value="${room.id}" ${disabled} ${selected}>${label}</option>`;
    });

    return html;
}

async function onMealTypeChange(registrationId, mealType, selectElement) {
    try {
        const { error } = await Layout.db
            .from('retreat_registrations')
            .update({ meal_type: mealType || null })
            .eq('id', registrationId);

        if (error) throw error;

        // Обновить локальные данные
        const reg = registrations.find(r => r.id === registrationId);
        if (reg) reg.meal_type = mealType || null;

        // Обновить классы select элемента для цветовой индикации
        if (selectElement) {
            selectElement.classList.remove('meal-prasad', 'meal-self', 'meal-child');
            if (mealType === 'prasad') selectElement.classList.add('meal-prasad');
            else if (mealType === 'self') selectElement.classList.add('meal-self');
            else if (mealType === 'child') selectElement.classList.add('meal-child');
        }
    } catch (err) {
        Layout.handleError(err, 'Сохранение типа питания');
    }
}

async function onBuildingChange(registrationId, buildingId) {
    const roomSelect = document.getElementById(`room_select_${registrationId}`);
    if (!roomSelect) return;

    const reg = registrations.find(r => r.id === registrationId);
    const roomCell = roomSelect.closest('td');
    const buildingCell = roomCell?.previousElementSibling;

    if (!buildingId) {
        roomSelect.innerHTML = '<option value="">—</option>';
        roomSelect.classList.remove('hidden');
        // Удалить span "Самостоятельное" если есть
        const selfSpan = roomCell?.querySelector('span');
        if (selfSpan) selfSpan.remove();
        // Сбросить CSS классы ячеек
        roomCell?.classList.remove('bg-error/20', 'bg-success/20');
        buildingCell?.classList.remove('bg-error/20', 'bg-success/20');
        // Удалить размещение, если было
        if (reg?.resident?.id) {
            await deleteResident(reg.resident.id);
        }
        return;
    }

    // Если выбрано "Самостоятельно"
    if (buildingId === 'self') {
        await saveSelfAccommodation(registrationId);
        return;
    }

    // Показать select комнат и удалить span "Самостоятельное"
    roomSelect.classList.remove('hidden');
    const selfSpan = roomCell?.querySelector('span');
    if (selfSpan) selfSpan.remove();

    // Обновить CSS классы ячеек (здание выбрано, но комната ещё нет)
    buildingCell?.classList.remove('bg-error/20');
    buildingCell?.classList.add('bg-success/20');
    roomCell?.classList.remove('bg-error/20', 'bg-success/20');

    // Обновить список комнат
    roomSelect.innerHTML = renderRoomOptions(buildingId, null, registrationId);
}

async function onRoomChange(registrationId, roomId) {
    if (!roomId) return;

    const reg = registrations.find(r => r.id === registrationId);
    if (!reg || !reg.vaishnava_id) {
        Layout.showNotification(t('registration_or_vaishnava_not_found'), 'error');
        return;
    }

    const data = {
        room_id: roomId,
        vaishnava_id: reg.vaishnava_id,
        retreat_id: retreatId,
        check_in: retreat?.start_date || null,
        check_out: retreat?.end_date || null,
        status: 'confirmed'
    };

    try {
        if (reg.resident?.id) {
            // Обновить существующее размещение
            const { error } = await Layout.db
                .from('residents')
                .update(data)
                .eq('id', reg.resident.id);
            if (error) throw error;
        } else {
            // Создать новое размещение
            const { error } = await Layout.db
                .from('residents')
                .insert(data);
            if (error) throw error;
        }

        // Перезагрузить данные для синхронизации
        await loadRegistrations();
    } catch (err) {
        console.error('Error saving room placement:', err);
        Layout.showNotification(t('placement_error') + ': ' + err.message, 'error');
        // Перезагрузить данные для отката изменений в UI
        await loadRegistrations();
    }
}

async function deleteResident(residentId) {
    try {
        const { error } = await Layout.db
            .from('residents')
            .delete()
            .eq('id', residentId);
        if (error) throw error;

        await loadRegistrations();
    } catch (err) {
        console.error('Error deleting resident:', err);
        Layout.showNotification(t('delete_placement_error') + ': ' + err.message, 'error');
    }
}

async function saveSelfAccommodation(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg || !reg.vaishnava_id) {
        Layout.showNotification('Ошибка: не найдена регистрация или вайшнав', 'error');
        return;
    }

    const data = {
        room_id: null, // NULL indicates self-accommodation
        vaishnava_id: reg.vaishnava_id,
        retreat_id: retreatId,
        check_in: retreat?.start_date || null,
        check_out: retreat?.end_date || null,
        status: 'confirmed'
    };

    try {
        if (reg.resident?.id) {
            // Обновить существующее размещение
            const { error } = await Layout.db
                .from('residents')
                .update(data)
                .eq('id', reg.resident.id);
            if (error) throw error;
        } else {
            // Создать новое размещение
            const { error } = await Layout.db
                .from('residents')
                .insert(data);
            if (error) throw error;
        }

        // Перезагрузить данные для синхронизации
        await loadRegistrations();
        Layout.showNotification(t('self_accommodation') + ' ' + t('saved'), 'success');
    } catch (err) {
        Layout.handleError(err, 'Сохранение размещения');
        // Перезагрузить данные для отката изменений в UI
        await loadRegistrations();
    }
}

// ==================== FILTERS ====================
function setupFilters() {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => {
                b.classList.remove('active');
                b.classList.add('btn-ghost');
            });
            btn.classList.add('active');
            btn.classList.remove('btn-ghost');
            currentFilter = btn.dataset.filter;
            renderTable();
        });
    });
}

// ==================== GUEST MODAL ====================
let selectedVaishnavId = null;

function openGuestModal(registrationId = null) {
    if (!retreatId) {
        Layout.showNotification(t('select_retreat_first'), 'warning');
        return;
    }

    const modal = document.getElementById('guestModal');
    const form = document.getElementById('guestForm');
    const title = document.getElementById('guestModalTitle');

    form.reset();
    selectedVaishnavId = null;
    document.getElementById('selectedVaishnav').classList.add('hidden');
    document.getElementById('vaishnavSearch').value = '';

    if (registrationId) {
        const reg = registrations.find(r => r.id === registrationId);
        if (reg) {
            title.textContent = t('edit_guest');
            form.registration_id.value = reg.id;
            form.status.value = reg.status;
            form.org_notes.value = reg.org_notes || '';

            if (reg.vaishnavas) {
                selectedVaishnavId = reg.vaishnavas.id;
                const name = `${reg.vaishnavas.first_name || ''} ${reg.vaishnavas.last_name || ''}`.trim();
                const spiritual = reg.vaishnavas.spiritual_name ? ` (${reg.vaishnavas.spiritual_name})` : '';
                document.getElementById('selectedVaishnav').textContent = name + spiritual;
                document.getElementById('selectedVaishnav').classList.remove('hidden');
                document.getElementById('vaishnavSearch').value = name;
            }
        }
    } else {
        title.textContent = t('add_guest');
    }

    modal.showModal();
}

function searchVaishnavas(query) {
    const container = document.getElementById('vaishnavSuggestions');
    if (!query || query.length < 2) {
        container.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const matches = vaishnavas.filter(v => {
        const fullName = `${v.first_name || ''} ${v.last_name || ''}`.toLowerCase();
        const spiritual = (v.spiritual_name || '').toLowerCase();
        return fullName.includes(q) || spiritual.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        container.classList.add('hidden');
        return;
    }

    container.innerHTML = matches.map(v => {
        const name = `${v.first_name || ''} ${v.last_name || ''}`.trim();
        const spiritual = v.spiritual_name ? ` (${v.spiritual_name})` : '';
        const badge = v.is_team_member ? '<span class="badge badge-xs badge-primary ml-2">Команда</span>' : '';
        return `
            <div class="px-3 py-2 hover:bg-base-200 cursor-pointer flex items-center" data-id="${v.id}" data-name="${e(name)}" data-spiritual="${e(v.spiritual_name || '')}" onclick="selectVaishnav(this.dataset.id, this.dataset.name, this.dataset.spiritual)">
                <span>${e(name)}${e(spiritual)}</span>${badge}
            </div>
        `;
    }).join('');

    container.classList.remove('hidden');
}

function selectVaishnav(id, name, spiritual) {
    selectedVaishnavId = id;
    document.getElementById('vaishnavSearch').value = name;
    document.getElementById('vaishnavSuggestions').classList.add('hidden');
    const label = spiritual ? `${name} (${spiritual})` : name;
    document.getElementById('selectedVaishnav').textContent = label;
    document.getElementById('selectedVaishnav').classList.remove('hidden');
}

document.getElementById('guestForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;

    if (!selectedVaishnavId) {
        Layout.showNotification(t('select_vaishnava'), 'warning');
        return;
    }

    const data = {
        retreat_id: retreatId,
        vaishnava_id: selectedVaishnavId,
        status: form.status.value,
        org_notes: form.org_notes.value.trim() || null
    };

    try {
        if (form.registration_id.value) {
            // Update
            const { error } = await Layout.db
                .from('retreat_registrations')
                .update(data)
                .eq('id', form.registration_id.value);
            if (error) throw error;
        } else {
            // Insert
            const { error } = await Layout.db
                .from('retreat_registrations')
                .insert(data);
            if (error) throw error;
        }

        guestModal.close();
        await loadRegistrations();
    } catch (err) {
        console.error('Error saving registration:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
});

// Hide suggestions when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('#vaishnavSearch') && !e.target.closest('#vaishnavSuggestions')) {
        document.getElementById('vaishnavSuggestions').classList.add('hidden');
    }
});

// ==================== STATUS UPDATE ====================
async function updateStatus(registrationId, newStatus, selectElement) {
    const oldStatus = registrations.find(r => r.id === registrationId)?.status;

    try {
        const { error } = await Layout.db
            .from('retreat_registrations')
            .update({ status: newStatus })
            .eq('id', registrationId);

        if (error) throw error;

        // Update local data
        const reg = registrations.find(r => r.id === registrationId);
        if (reg) reg.status = newStatus;

        // Update select element class
        if (selectElement) {
            selectElement.className = selectElement.className.replace(/status-\w+/, `status-${newStatus}`);
        }

        // Re-render if filter is active (row might need to hide)
        if (currentFilter !== 'all') {
            renderTable();
        }
    } catch (err) {
        console.error('Error updating status:', err);
        Layout.showNotification(t('update_status_error') + ': ' + err.message, 'error');
        // Revert select value
        if (selectElement && oldStatus) {
            selectElement.value = oldStatus;
        }
    }
}

// ==================== PLACEMENT MODAL ====================
let buildings = [];
let floorPlans = [];

// Состояние модалки размещения
let placementState = {
    registrationId: null,
    vaishnavId: null,
    retreatId: null,
    checkIn: null,
    checkOut: null,
    mode: 'list',  // 'list' | 'plan'
    occupancy: {},  // roomId => count занятости
    currentBuildingId: null,
    currentFloor: 1,
    existingResidentId: null  // для переселения
};

async function loadBuildingsAndRooms() {
    const [buildingsRes, floorPlansRes] = await Promise.all([
        Layout.db.from('buildings')
            .select('*, rooms(*)')
            .eq('is_active', true)
            .order('sort_order'),
        Layout.db.from('floor_plans')
            .select('*')
    ]);

    if (buildingsRes.error) console.error('Error loading buildings:', buildingsRes.error);
    if (floorPlansRes.error) console.error('Error loading floor plans:', floorPlansRes.error);

    let allBuildings = buildingsRes.data || [];

    // Фильтруем временные здания по датам ретрита
    if (retreat?.start_date && retreat?.end_date) {
        allBuildings = allBuildings.filter(b => {
            // Постоянные здания показываем всегда
            if (!b.is_temporary) return true;
            // Временные — только если период аренды пересекается с ретритом
            return b.available_from <= retreat.end_date && b.available_until >= retreat.start_date;
        });
    } else {
        // Без ретрита показываем только постоянные здания
        allBuildings = allBuildings.filter(b => !b.is_temporary);
    }

    buildings = allBuildings;
    floorPlans = floorPlansRes.data || [];
}

function openPlacementModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    // Сброс состояния
    placementState = {
        registrationId: registrationId,
        vaishnavId: reg.vaishnava_id,
        retreatId: retreat?.id || null,
        checkIn: reg.resident?.check_in || retreat?.start_date || null,
        checkOut: reg.resident?.check_out || retreat?.end_date || null,
        mode: 'list',
        occupancy: {},
        currentBuildingId: buildings[0]?.id || null,
        currentFloor: 1,
        existingResidentId: reg.resident?.id || null
    };

    const modal = document.getElementById('placementModal');
    const guestInfo = document.getElementById('placementGuestInfo');

    // Показать инфо о госте
    const v = reg.vaishnavas;
    const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
    const spiritualName = v?.spiritual_name ? ` (${v.spiritual_name})` : '';

    guestInfo.innerHTML = `
        <div class="font-medium">${e(name)}${e(spiritualName)}</div>
        ${reg.accommodation_wishes ? `<div class="text-sm opacity-60 mt-1">Пожелания: ${e(reg.accommodation_wishes)}</div>` : ''}
    `;

    // Установить даты из ретрита
    document.getElementById('placementCheckIn').value = placementState.checkIn || '';
    document.getElementById('placementCheckOut').value = placementState.checkOut || '';

    // Сброс табов
    document.querySelectorAll('.placement-tabs .tab').forEach(tab => {
        tab.classList.toggle('tab-active', tab.dataset.mode === 'list');
    });

    modal.showModal();
    onPlacementDatesChange();
}

async function onPlacementDatesChange() {
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    placementState.checkIn = checkIn;
    placementState.checkOut = checkOut;

    const dateMessage = document.getElementById('placementDateMessage');
    const roomsContainer = document.getElementById('placementRoomsContainer');

    if (!checkIn || !checkOut) {
        dateMessage.classList.remove('hidden');
        roomsContainer.classList.add('hidden');
        return;
    }

    dateMessage.classList.add('hidden');
    roomsContainer.classList.remove('hidden');

    // Загрузить занятость
    await loadPlacementOccupancy(checkIn, checkOut);

    // Отрисовать текущий режим
    if (placementState.mode === 'list') {
        renderPlacementListView();
    } else {
        renderPlacementPlanView();
    }
}

async function loadPlacementOccupancy(checkIn, checkOut) {
    // Загружаем все размещения из единой таблицы residents
    // Исключаем выселенных (checked_out)
    const { data: residentsData, error } = await Layout.db
        .from('residents')
        .select('id, room_id')
        .not('room_id', 'is', null)
        .in('status', ['active', 'confirmed'])
        .lte('check_in', checkOut)
        .gte('check_out', checkIn);

    if (error) console.error('Error loading residents:', error);

    // Подсчёт занятости по комнатам (исключаем текущего при переселении)
    placementState.occupancy = {};
    (residentsData || []).forEach(r => {
        if (r.room_id && r.id !== placementState.existingResidentId) {
            placementState.occupancy[r.room_id] = (placementState.occupancy[r.room_id] || 0) + 1;
        }
    });
}

function switchPlacementMode(mode) {
    placementState.mode = mode;

    // Обновить табы
    document.querySelectorAll('.placement-tabs .tab').forEach(tab => {
        tab.classList.toggle('tab-active', tab.dataset.mode === mode);
    });

    // Показать/скрыть вьюхи
    document.getElementById('placementListView').classList.toggle('hidden', mode !== 'list');
    document.getElementById('placementPlanView').classList.toggle('hidden', mode !== 'plan');

    // Отрисовать
    if (mode === 'list') {
        renderPlacementListView();
    } else {
        renderPlacementPlanView();
    }
}

function renderPlacementListView() {
    const roomsList = document.getElementById('roomsList');

    if (buildings.length === 0) {
        roomsList.innerHTML = '<div class="text-center py-4 opacity-50">Нет доступных зданий</div>';
        return;
    }

    let html = '';
    buildings.forEach(building => {
        const rooms = (building.rooms?.filter(r => r.is_active) || [])
            .sort((a, b) => {
                if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
                return a.number.localeCompare(b.number, undefined, { numeric: true });
            });

        if (rooms.length === 0) return;

        html += `<div class="collapse collapse-arrow bg-base-200 rounded-lg">
            <input type="checkbox" checked />
            <div class="collapse-title font-medium py-2">${Layout.getName(building)}</div>
            <div class="collapse-content p-0">
                <div class="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-1 p-2">`;

        rooms.forEach(room => {
            const occupied = placementState.occupancy[room.id] || 0;
            const capacity = room.capacity || 1;
            const isFull = occupied >= capacity;

            let btnClass, label, disabled;

            if (isFull) {
                btnClass = 'btn-disabled bg-red-100 text-red-400';
                label = `${room.number} <span class="text-xs">${occupied}/${capacity}</span>`;
                disabled = true;
            } else if (occupied > 0) {
                btnClass = 'btn-outline btn-warning';
                label = `${room.number} <span class="text-xs">${occupied}/${capacity}</span>`;
                disabled = false;
            } else {
                btnClass = 'btn-outline btn-success';
                label = room.number;
                disabled = false;
            }

            html += `<button type="button" class="btn btn-sm ${btnClass}"
                ${disabled ? 'disabled' : `onclick="selectPlacementRoom('${room.id}', '${building.id}')"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html || '<div class="text-center py-4 opacity-50">Нет комнат</div>';
}

function renderPlacementPlanView() {
    // Табы зданий
    const buildingTabsHtml = buildings.map(b => {
        const hasPlans = floorPlans.some(fp => fp.building_id === b.id);
        const isActive = b.id === placementState.currentBuildingId;
        return `<button type="button" class="tab ${isActive ? 'tab-active' : ''} ${!hasPlans ? 'opacity-50' : ''}"
            onclick="selectPlanBuilding('${b.id}')" ${!hasPlans ? 'title="Нет плана"' : ''}>
            ${Layout.getName(b)}
        </button>`;
    }).join('');
    document.getElementById('planBuildingTabs').innerHTML = buildingTabsHtml;

    // Получить этажи для текущего здания
    const building = buildings.find(b => b.id === placementState.currentBuildingId);
    const buildingFloorPlans = floorPlans.filter(fp => fp.building_id === placementState.currentBuildingId);
    const floors = [...new Set(buildingFloorPlans.map(fp => fp.floor))].sort((a, b) => a - b);

    // Если нет этажей с планами
    if (floors.length === 0) {
        document.getElementById('planFloorTabs').innerHTML = '';
        document.getElementById('planFloorPlanImage').classList.add('hidden');
        document.getElementById('planFloorPlanSvg').classList.add('hidden');
        document.getElementById('planNoFloorPlan').classList.remove('hidden');
        document.getElementById('planNoFloorPlan').textContent = 'Нет планов для этого здания';
        return;
    }

    // Проверить что текущий этаж существует
    if (!floors.includes(placementState.currentFloor)) {
        placementState.currentFloor = floors[0];
    }

    // Табы этажей
    const floorTabsHtml = floors.map(floor => {
        const isActive = floor === placementState.currentFloor;
        return `<button type="button" class="btn btn-sm ${isActive ? 'btn-primary' : 'btn-ghost'}"
            onclick="selectPlanFloor(${floor})">
            ${floor} этаж
        </button>`;
    }).join('');
    document.getElementById('planFloorTabs').innerHTML = floorTabsHtml;

    // Получить план этажа
    const floorPlan = buildingFloorPlans.find(fp => fp.floor === placementState.currentFloor);

    if (!floorPlan) {
        document.getElementById('planFloorPlanImage').classList.add('hidden');
        document.getElementById('planFloorPlanSvg').classList.add('hidden');
        document.getElementById('planNoFloorPlan').classList.remove('hidden');
        return;
    }

    // Показать изображение плана
    const img = document.getElementById('planFloorPlanImage');
    img.src = floorPlan.image_url;
    img.classList.remove('hidden');
    document.getElementById('planNoFloorPlan').classList.add('hidden');

    // Отрисовать комнаты на SVG
    const svg = document.getElementById('planFloorPlanSvg');
    svg.classList.remove('hidden');

    // Установить viewBox по размеру изображения
    svg.setAttribute('viewBox', `0 0 100 100`);

    // Получить комнаты этого этажа с координатами
    const rooms = (building?.rooms || []).filter(r =>
        r.is_active &&
        r.floor === placementState.currentFloor &&
        r.plan_x !== null && r.plan_y !== null
    );

    let svgContent = '';
    rooms.forEach(room => {
        const occupied = placementState.occupancy[room.id] || 0;
        const capacity = room.capacity || 1;
        const isFull = occupied >= capacity;

        let fillColor;
        if (isFull) {
            fillColor = '#ef4444'; // red
        } else if (occupied > 0) {
            fillColor = '#eab308'; // yellow
        } else {
            fillColor = '#10b981'; // green
        }

        const x = parseFloat(room.plan_x);
        const y = parseFloat(room.plan_y);
        const w = parseFloat(room.plan_width || 8);
        const h = parseFloat(room.plan_height || 8);

        const clickHandler = isFull ? '' : `onclick="selectPlacementRoom('${room.id}', '${building.id}')"`;
        const disabledClass = isFull ? 'disabled' : '';

        svgContent += `
            <g class="room-marker ${disabledClass}" ${clickHandler}>
                <rect x="${x}" y="${y}" width="${w}" height="${h}"
                    fill="${fillColor}" rx="0.5" opacity="0.85" />
                <text x="${x + w/2}" y="${y + h/2}" class="room-label">
                    ${room.number}${occupied > 0 ? ` (${occupied}/${capacity})` : ''}
                </text>
            </g>`;
    });

    svg.innerHTML = svgContent;
}

function selectPlanBuilding(buildingId) {
    placementState.currentBuildingId = buildingId;
    placementState.currentFloor = 1;
    renderPlacementPlanView();
}

function selectPlanFloor(floor) {
    placementState.currentFloor = floor;
    renderPlacementPlanView();
}

async function selectPlacementRoom(roomId, buildingId) {
    const building = buildings.find(b => b.id === buildingId);
    const room = building?.rooms?.find(r => r.id === roomId);
    if (!room || !placementState.vaishnavId) return;

    const data = {
        room_id: roomId,
        vaishnava_id: placementState.vaishnavId,
        retreat_id: placementState.retreatId,
        check_in: placementState.checkIn || null,
        check_out: placementState.checkOut || null,
        status: 'confirmed'
    };

    try {
        if (placementState.existingResidentId) {
            // Обновить существующее размещение
            const { error } = await Layout.db
                .from('residents')
                .update(data)
                .eq('id', placementState.existingResidentId);
            if (error) throw error;
        } else {
            // Создать новое
            const { error } = await Layout.db
                .from('residents')
                .insert(data);
            if (error) throw error;
        }

        placementModal.close();
        await loadRegistrations();
    } catch (err) {
        console.error('Error saving placement:', err);
        Layout.showNotification(t('placement_error') + ': ' + err.message, 'error');
    }
}

// Старые функции для совместимости (deprecated)
function updateRoomsList() { onPlacementDatesChange(); }
function selectRoom(roomId, buildingId) { selectPlacementRoom(roomId, buildingId); }

// ==================== INFO MODAL ====================
function openInfoModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    const modal = document.getElementById('infoModal');
    const content = document.getElementById('infoModalContent');
    const title = document.getElementById('infoModalTitle');

    const v = reg.vaishnavas;
    const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '';
    const spiritualName = v?.spiritual_name || '';
    title.textContent = spiritualName || name || 'Информация о госте';

    // Get transfer info
    const transfers = reg.guest_transfers || [];
    const arrival = transfers.find(t => t.direction === 'arrival');
    const departure = transfers.find(t => t.direction === 'departure');

    const sections = [];

    // Contact info
    if (v?.phone || v?.email || v?.telegram) {
        let contactHtml = '<div class="flex flex-wrap gap-2">';

        // WhatsApp
        if (v.phone && v.has_whatsapp) {
            const waNumber = v.phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
            contactHtml += `
                <a href="https://wa.me/${waNumber}" target="_blank" class="btn btn-sm btn-success gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                    WhatsApp
                </a>
            `;
        }

        // Telegram
        if (v.telegram) {
            const tgUsername = encodeURIComponent(v.telegram.replace(/^@/, ''));
            contactHtml += `
                <a href="https://t.me/${tgUsername}" target="_blank" class="btn btn-sm btn-info gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                    Telegram
                </a>
            `;
        }

        // Phone (if no WhatsApp, show as call link)
        if (v.phone && !v.has_whatsapp) {
            const phoneNumber = encodeURIComponent(v.phone);
            contactHtml += `
                <a href="tel:${phoneNumber}" class="btn btn-sm btn-ghost gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/></svg>
                    ${e(v.phone)}
                </a>
            `;
        }

        // Email
        if (v.email) {
            const emailAddr = encodeURIComponent(v.email);
            contactHtml += `
                <a href="mailto:${emailAddr}" class="btn btn-sm btn-ghost gap-1">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                    Email
                </a>
            `;
        }

        contactHtml += '</div>';
        sections.push(contactHtml);
    }

    // Flight info
    if (arrival || departure) {
        let flightHtml = '<div class="grid grid-cols-2 gap-4">';
        if (arrival) {
            const arrDate = arrival.flight_datetime ? formatFlightDateTime(arrival.flight_datetime) : (arrival.notes || '—');
            flightHtml += `
                <div>
                    <div class="text-xs opacity-50 mb-1">Прилёт</div>
                    <div class="font-medium">${arrDate}</div>
                    ${arrival.flight_number ? `<div class="text-sm opacity-70">${arrival.flight_number}</div>` : ''}
                    ${arrival.needs_transfer === 'yes' ? '<div class="text-sm">🚐 Нужен трансфер</div>' : ''}
                </div>
            `;
        }
        if (departure) {
            const depDate = departure.flight_datetime ? formatFlightDateTime(departure.flight_datetime) : (departure.notes || '—');
            flightHtml += `
                <div>
                    <div class="text-xs opacity-50 mb-1">Вылет</div>
                    <div class="font-medium">${depDate}</div>
                    ${departure.flight_number ? `<div class="text-sm opacity-70">${departure.flight_number}</div>` : ''}
                    ${departure.needs_transfer === 'yes' ? '<div class="text-sm">🚐 Нужен трансфер</div>' : ''}
                </div>
            `;
        }
        flightHtml += '</div>';
        sections.push(flightHtml);
    }

    // Companions (Family)
    if (reg.companions) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">Семья / Сопровождающие</div>
                <div>${e(reg.companions)}</div>
            </div>
        `);
    }

    // Extended stay
    if (reg.extended_stay) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">После ретрита</div>
                <div>${e(reg.extended_stay)}</div>
            </div>
        `);
    }

    // Accommodation wishes
    if (reg.accommodation_wishes) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">Пожелания по проживанию</div>
                <div>${e(reg.accommodation_wishes)}</div>
            </div>
        `);
    }

    // Org notes
    if (reg.org_notes) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">Комментарий ОП</div>
                <div class="whitespace-pre-wrap">${e(reg.org_notes)}</div>
            </div>
        `);
    }

    // Guest questions
    if (reg.guest_questions) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">Вопросы</div>
                <div class="whitespace-pre-wrap">${e(reg.guest_questions)}</div>
            </div>
        `);
    }

    content.innerHTML = sections.length > 0
        ? sections.join('<div class="divider my-2"></div>')
        : '<div class="text-center opacity-50 py-4">Нет дополнительной информации</div>';

    modal.showModal();
}

// ==================== CSV IMPORT ====================
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
                logMessage(log, `✓ Создан: ${result.name}`, 'success');
            } else if (result.status === 'updated') {
                importStats.updated++;
                logMessage(log, `↻ Обновлён: ${result.name}`, 'info');
            } else if (result.status === 'conflict') {
                conflicts.push(result);
                logMessage(log, `⚠ Конфликт: ${result.name}`, 'warning');
            } else if (result.status === 'skipped') {
                importStats.skipped++;
                logMessage(log, `— Пропущен: ${row.name || row.name2}`, 'info');
            }
        } catch (err) {
            logMessage(log, `✗ Ошибка строка ${i + 1}: ${err.message}`, 'error');
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
        displayName: `${firstName} ${lastName}`.trim() || row.name2 || 'Без имени',

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

        // Email match (+5)
        if (parsed.email && v.email && parsed.email.toLowerCase() === v.email.toLowerCase()) {
            score += 5;
        }

        // Phone match (+4)
        if (parsed.phone && v.phone) {
            const p1 = parsed.phone.replace(/\D/g, '');
            const p2 = v.phone.replace(/\D/g, '');
            if (p1.length >= 10 && p2.length >= 10 && p1.slice(-10) === p2.slice(-10)) {
                score += 4;
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

    // Add to local cache
    vaishnavas.push({ id: data.id, ...parsed });

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
        status: 'guest',
        companions: parsed.companions,
        accommodation_wishes: parsed.accommodationWishes,
        payment_notes: parsed.paymentNotes,
        org_notes: parsed.orgNotes,
        extended_stay: parsed.extendedStay,
        guest_questions: parsed.guestQuestions
    };

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

function parseDateTimeString(str, retreatYear) {
    if (!str) return null;

    const months = {
        'января': 1, 'февраля': 2, 'марта': 3, 'апреля': 4,
        'мая': 5, 'июня': 6, 'июля': 7, 'августа': 8,
        'сентября': 9, 'октября': 10, 'ноября': 11, 'декабря': 12
    };

    // Format: "7 февраля 18:30" or "7 февраля, 18:30"
    let match = str.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)[,]?\s*(\d{1,2}):(\d{2})/i);
    if (match) {
        const day = parseInt(match[1]);
        const month = months[match[2].toLowerCase()];
        const hour = parseInt(match[3]);
        const minute = parseInt(match[4]);
        const year = retreatYear || new Date().getFullYear();
        return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    // Format: "22.02.26 5:50" or "22.02.2026 5:50"
    match = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        let year = parseInt(match[3]);
        if (year < 100) year += 2000;
        const hour = parseInt(match[4]);
        const minute = parseInt(match[5]);
        return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    // Format: "06.02.2026 в 04.05" (с предлогом "в" и точкой в времени)
    match = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*в\s*(\d{1,2})\.(\d{2})/i);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        let year = parseInt(match[3]);
        if (year < 100) year += 2000;
        const hour = parseInt(match[4]);
        const minute = parseInt(match[5]);
        return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    // Format: "7.02. в 00.25" или "7.02 в 00:25" (день.месяц без года, предлог "в", время)
    match = str.match(/(\d{1,2})\.(\d{1,2})\.?\s*в\s*(\d{1,2})[.:](\d{2})/i);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        const hour = parseInt(match[3]);
        const minute = parseInt(match[4]);
        const year = retreatYear || new Date().getFullYear();
        return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    // Format: "7.02 00:25" или "7.02. 00.25" (день.месяц без года, время без "в")
    match = str.match(/(\d{1,2})\.(\d{1,2})\.?\s+(\d{1,2})[.:](\d{2})/);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        const hour = parseInt(match[3]);
        const minute = parseInt(match[4]);
        const year = retreatYear || new Date().getFullYear();
        return new Date(year, month - 1, day, hour, minute).toISOString();
    }

    // Format: "06.02.2026" or "22.02.26" (только дата без времени)
    match = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?!\s*[\d:в])/);
    if (match) {
        const day = parseInt(match[1]);
        const month = parseInt(match[2]);
        let year = parseInt(match[3]);
        if (year < 100) year += 2000;
        return new Date(year, month - 1, day, 12, 0).toISOString();
    }

    // Format: "7 февраля" (no time)
    match = str.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/i);
    if (match) {
        const day = parseInt(match[1]);
        const month = months[match[2].toLowerCase()];
        const year = retreatYear || new Date().getFullYear();
        return new Date(year, month - 1, day, 12, 0).toISOString();
    }

    // Can't parse - return null
    return null;
}

async function createTransfers(registrationId, parsed) {
    // Delete existing transfers for this registration
    await Layout.db
        .from('guest_transfers')
        .delete()
        .eq('registration_id', registrationId);

    const transfers = [];
    const retreatYear = retreat?.start_date ? new Date(retreat.start_date).getFullYear() : null;

    // Arrival
    if (parsed.arrivalTime || parsed.arrivalFlight) {
        const flightDatetime = parseDateTimeString(parsed.arrivalTime, retreatYear);
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
        const flightDatetime = parseDateTimeString(parsed.departureTime, retreatYear);
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
                        <strong>Строка ${c.rowNum}:</strong> ${e(c.name)}
                        <span class="badge badge-sm ml-2">${c.candidates[0]?.score || 0} баллов</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 text-sm mb-3">
                    <div>
                        <div class="font-medium mb-1">В CSV:</div>
                        <div>${e(parsed.firstName)} ${e(parsed.lastName)}</div>
                        <div>${e(parsed.spiritualName || '—')}</div>
                        <div>${e(parsed.email || '—')}</div>
                        <div>${e(parsed.phone || '—')}</div>
                    </div>
                    <div>
                        <div class="font-medium mb-1">В базе:</div>
                        ${candidate ? `
                            <div class="${parsed.firstName === candidate.first_name ? 'match-same' : 'match-diff'}">${e(candidate.first_name)} ${e(candidate.last_name || '')}</div>
                            <div class="${parsed.spiritualName === candidate.spiritual_name ? 'match-same' : 'match-diff'}">${e(candidate.spiritual_name || '—')}</div>
                            <div class="${parsed.email === candidate.email ? 'match-same' : 'match-diff'}">${e(candidate.email || '—')}</div>
                            <div class="${normalizePhone(parsed.phone) === normalizePhone(candidate.phone) ? 'match-same' : 'match-diff'}">${e(candidate.phone || '—')}</div>
                        ` : '<div class="opacity-50">Нет совпадений</div>'}
                    </div>
                </div>

                <div class="flex gap-4">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="update" class="radio radio-sm" ${candidate ? 'checked' : ''} />
                        <span>Это тот же человек — обновить</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="create" class="radio radio-sm" ${!candidate ? 'checked' : ''} />
                        <span>Создать нового</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="skip" class="radio radio-sm" />
                        <span>Пропустить</span>
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

    document.getElementById('importSummary').textContent =
        `Создано: ${importStats.created}, Обновлено: ${importStats.updated}, Пропущено: ${importStats.skipped}`;

    // Reload data
    loadRegistrations();
    loadVaishnavas();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'preliminary' });
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

// Handle browser back/forward cache (bfcache)
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        // Page was restored from bfcache, re-render to get fresh translations
        renderTable();
    }
});

init();
