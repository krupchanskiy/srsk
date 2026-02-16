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

// Сдвигает datetime значение на N часов (локальное время).
// .slice(0,16) убирает таймзону из TIMESTAMPTZ, т.к. БД хранит локальное время как UTC.
function addHoursToDatetime(datetimeStr, hours) {
    if (!datetimeStr) return null;
    const d = new Date(datetimeStr.slice(0, 16));
    d.setHours(d.getHours() + hours);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Форматирует datetime в читаемый вид: "12 фев, 14:30" (или "12 фев" если время 00:00)
function formatDatetimeShort(datetimeStr) {
    if (!datetimeStr) return '—';
    const d = new Date(datetimeStr.slice(0, 16));
    const months = DateUtils.monthNamesShort.ru;
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${d.getDate()} ${months[d.getMonth()]}`;
    if (d.getHours() === 0 && d.getMinutes() === 0) return dateStr;
    return `${dateStr}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
    select.innerHTML = `<option value="">${t('preliminary_select_retreat')}</option>` +
        allRetreats.map(r => `<option value="${r.id}">${Layout.getName(r)}</option>`).join('');

    // Check URL for retreat id
    const params = new URLSearchParams(window.location.search);
    const urlId = params.get('id');

    if (urlId && allRetreats.find(r => r.id === urlId)) {
        select.value = urlId;
        await selectRetreat(urlId);
    } else if (allRetreats.length > 0) {
        // Auto-select nearest retreat
        const today = DateUtils.toISO(new Date());

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

    document.getElementById('retreatDates').textContent = DateUtils.formatRange(retreat.start_date, retreat.end_date);
    document.title = `${Layout.getName(retreat)} — ${t('preliminary_app_title')}`;

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
            vaishnavas (id, first_name, last_name, spiritual_name, phone, email, telegram, has_whatsapp, photo_url, gender, birth_date, india_experience, parent_id),
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

    // Загружаем размещения и занятость комнат параллельно
    const vaishnavIds = registrations.map(r => r.vaishnava_id).filter(Boolean);

    const [residentsResult] = await Promise.all([
        vaishnavIds.length > 0
            ? Layout.db
                .from('residents')
                .select('*, rooms(id, number, building_id, buildings(id, name_ru, name_en, name_hi))')
                .eq('retreat_id', retreatId)
                .in('vaishnava_id', vaishnavIds)
                .eq('status', 'confirmed')
            : Promise.resolve({ data: [] }),
        loadRoomOccupancy()
    ]);

    // Привязываем residents к регистрациям
    const residentsByVaishnava = (residentsResult.data || []).reduce((acc, res) => {
        acc[res.vaishnava_id] = res;
        return acc;
    }, {});

    registrations.forEach(reg => {
        reg.resident = residentsByVaishnava[reg.vaishnava_id] || null;
    });

    renderTable();
}

async function loadRoomOccupancy() {
    if (!retreat?.start_date || !retreat?.end_date) {
        placementState.occupancy = {};
        return;
    }

    const { data: residentsData, error } = await Layout.db
        .from('residents')
        .select('id, room_id, check_in, check_out')
        .not('room_id', 'is', null)
        .eq('status', 'confirmed')
        .lte('check_in', retreat.end_date)
        .gte('check_out', retreat.start_date);

    if (error) {
        console.error('Error loading room occupancy:', error);
        placementState.occupancy = {};
        return;
    }

    placementState.occupancy = calcPeakOccupancy(residentsData);
}

// Пиковая одновременная занятость комнат (sweep line)
function calcPeakOccupancy(residentsData, excludeId) {
    const byRoom = {};
    (residentsData || []).forEach(r => {
        if (!r.room_id || r.id === excludeId) return;
        (byRoom[r.room_id] ||= []).push(r);
    });

    const occupancy = {};
    for (const [roomId, list] of Object.entries(byRoom)) {
        const events = [];
        list.forEach(r => {
            events.push({ d: r.check_in, v: 1 });
            events.push({ d: r.check_out, v: -1 });
        });
        // Выезд (-1) раньше заезда (+1) в один день — выезд освобождает место
        events.sort((a, b) => a.d.localeCompare(b.d) || a.v - b.v);
        let cur = 0, peak = 0;
        events.forEach(e => { cur += e.v; peak = Math.max(peak, cur); });
        occupancy[roomId] = peak;
    }
    return occupancy;
}

// Даты заезда/выезда: размещение → arrival/departure → рейс → ретрит
function getRegCheckIn(reg) {
    if (reg.resident?.check_in) return reg.resident.check_in;
    if (reg.arrival_datetime) return reg.arrival_datetime.slice(0, 10);
    const flight = (reg.guest_transfers || []).find(t => t.direction === 'arrival');
    if (flight?.flight_datetime) return flight.flight_datetime.slice(0, 10);
    return retreat?.start_date || null;
}

function getRegCheckOut(reg) {
    if (reg.resident?.check_out) return reg.resident.check_out;
    if (reg.departure_datetime) return reg.departure_datetime.slice(0, 10);
    const flight = (reg.guest_transfers || []).find(t => t.direction === 'departure');
    if (flight?.flight_datetime) return flight.flight_datetime.slice(0, 10);
    return retreat?.end_date || null;
}

async function loadVaishnavas() {
    const { data, error } = await Utils.fetchAll((from, to) =>
        Layout.db
            .from('vaishnavas')
            .select('id, first_name, last_name, spiritual_name, phone, email, telegram, birth_date, is_team_member, photo_url')
            .eq('is_deleted', false)
            .order('first_name')
            .range(from, to)
    );

    if (error) {
        console.error('Error loading vaishnavas:', error);
        return;
    }

    vaishnavas = data || [];
}

// ==================== RENDERING ====================

function calculateAge(birthDate) {
    if (!birthDate) return '';
    return DateUtils.calculateAge(birthDate);
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
            aVal = getVaishnavName(a.vaishnavas, '').toLowerCase();
            bVal = getVaishnavName(b.vaishnavas, '').toLowerCase();
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
        } else if (sortField === 'status') {
            const statusOrder = { team: 1, volunteer: 2, guest: 3, vip: 4, cancelled: 5 };
            aVal = statusOrder[a.status] || 99;
            bVal = statusOrder[b.status] || 99;
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

// SVG-иконки для ячеек таблицы
const IC = {
    plane: `<svg class="w-4 h-4 inline -mt-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>`,
    pin: `<svg class="w-4 h-4 inline -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"/></svg>`,
    taxi: `<svg class="w-7 h-7 inline -mt-0.5" viewBox="0 0 103.07 59.75"><path fill="#fbbf24" d="M5.75,53.47c-1.68-1.71-2.63-4.23-2.68-6.64,2.97-10.49,6.26-20.89,9.36-31.35,1.71-5.78,1.81-10.95,9.24-12.11h58.86c3.74.23,7.15,2.76,8.35,6.35.33,1,.31,1.98.58,2.89,3.38,11.42,6.9,22.8,10.18,34.25-.11,4.72-3.5,8.64-8.16,9.3H11.55c-2.09-.16-4.35-1.22-5.8-2.7ZM21.72,9.78c-2.2.69-1.86,2.64-2.36,4.28-3.3,10.95-6.61,21.9-9.85,32.87-.47,2.23,1.92,3.11,3.77,3.19h76.19c1.99-.17,3.63-.69,3.83-2.97-3.25-10.64-6.4-21.3-9.61-31.95-.48-1.59-.56-4.58-2.24-5.26l-59.73-.16Z"/><polygon fill="#1f2937" points="60.75 20.68 63.64 26.16 67.25 20.68 72.58 20.68 66.57 29.82 72.29 38.86 66.96 38.86 63.64 33.67 61.04 38.86 55.27 38.86 60.98 29.81 55.27 20.68 60.75 20.68"/><path fill="#1f2937" d="M37.96,38.86l6.09-18.15,4.45-.05,6.48,18.2h-4.76l-1.27-3.29-4.91-.14-.89,3.43h-5.19ZM48.06,31.93c-.5-1.5-.78-3.12-1.3-4.61-.1-.28-.03-.66-.42-.58l-1.45,5.19h3.17Z"/><polygon fill="#1f2937" points="39.12 20.68 39.12 25.01 33.92 25.01 33.92 38.86 28.73 38.86 28.73 25.01 23.54 25.01 23.54 20.68 39.12 20.68"/><rect fill="#1f2937" x="74.03" y="20.68" width="5.19" height="18.18"/></svg>`,
};

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

    // Проверка прав на редактирование
    const canEdit = window.hasPermission && window.hasPermission('edit_preliminary');
    const disabledAttr = canEdit ? '' : 'disabled';

    // Переводы для статусов
    const statusGuest = t('status_guest');
    const statusTeam = t('status_team');
    const statusVolunteer = t('status_volunteer');
    const statusVip = t('status_vip');
    const statusCancelled = t('status_cancelled');

    // Переводы для типов питания
    const mealTypeNotSpecified = t('not_specified');
    const mealTypePrasad = t('meal_type_prasad');
    const mealTypeSelf = t('meal_type_self');
    const mealTypeChild = t('meal_type_child');

    // Группировка: родители сверху, дети под ними
    const parentRegs = filtered.filter(r => !r.vaishnavas?.parent_id);
    const childRegs = filtered.filter(r => r.vaishnavas?.parent_id);
    const childrenByParent = {};
    childRegs.forEach(r => {
        const pid = r.vaishnavas.parent_id;
        if (!childrenByParent[pid]) childrenByParent[pid] = [];
        childrenByParent[pid].push(r);
    });
    const parentVaishnavIds = new Set(parentRegs.map(r => r.vaishnavas?.id).filter(Boolean));

    const orderedFiltered = [];
    parentRegs.forEach(r => {
        orderedFiltered.push(r);
        const kids = childrenByParent[r.vaishnavas?.id];
        if (kids) kids.forEach(k => orderedFiltered.push(k));
    });
    // Дети без зарегистрированного родителя на этом ретрите
    childRegs.forEach(r => {
        if (!orderedFiltered.includes(r)) orderedFiltered.push(r);
    });

    tbody.innerHTML = orderedFiltered.map(reg => {
        const v = reg.vaishnavas;
        const isChild = !!v?.parent_id;
        const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
        const spiritualName = v?.spiritual_name || '';
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');
        const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
        const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

        // Пол и возраст
        const genderLabel = v?.gender === 'male' ? t('preliminary_gender_m') : v?.gender === 'female' ? t('preliminary_gender_f') : '';
        const age = v?.birth_date ? calculateAge(v.birth_date) : '';
        const genderAge = [genderLabel, age].filter(Boolean).join(', ') || '—';

        // Даты заезда/выезда и информация о рейсах
        const arrivalFlightDt = arrival?.flight_datetime?.slice(0, 16) || '';
        const departureFlightDt = departure?.flight_datetime?.slice(0, 16) || '';
        const arrivalAtAshram = reg.arrival_datetime?.slice(0, 16) || '';
        const departureFromAshram = reg.departure_datetime?.slice(0, 16) || '';

        // Собираем строки для ячейки Заезд (сначала рейс, потом приезд в ШРСК)
        const arrivalLines = [];
        if (arrivalFlightDt) {
            const p = [IC.plane, formatDatetimeShort(arrivalFlightDt)];
            if (arrival?.flight_number) p.push(e(arrival.flight_number));
            if (arrival?.needs_transfer === 'yes') p.push(IC.taxi);
            arrivalLines.push(p.join(' '));
        }
        if (arrivalAtAshram && arrivalAtAshram !== arrivalFlightDt) {
            const p = [IC.pin, formatDatetimeShort(arrivalAtAshram)];
            if (arrivalRetreat?.needs_transfer === 'yes') p.push(IC.taxi);
            arrivalLines.push(p.join(' '));
        }
        if (!arrivalLines.length) {
            const fallback = (reg.resident?.check_in ? reg.resident.check_in + 'T00:00' : null)
                || (retreat?.start_date ? retreat.start_date + 'T00:00' : '');
            arrivalLines.push(fallback ? formatDatetimeShort(fallback) : '—');
        }

        // Собираем строки для ячейки Выезд
        const departureLines = [];
        if (departureFromAshram && departureFromAshram !== departureFlightDt) {
            const p = [IC.pin, formatDatetimeShort(departureFromAshram)];
            if (departureRetreat?.needs_transfer === 'yes') p.push(IC.taxi);
            departureLines.push(p.join(' '));
        }
        if (departureFlightDt) {
            const p = [IC.plane, formatDatetimeShort(departureFlightDt)];
            if (departure?.flight_number) p.push(e(departure.flight_number));
            if (departure?.needs_transfer === 'yes') p.push(IC.taxi);
            departureLines.push(p.join(' '));
        }
        if (!departureLines.length) {
            const fallback = (reg.resident?.check_out ? reg.resident.check_out + 'T00:00' : null)
                || (retreat?.end_date ? retreat.end_date + 'T00:00' : '');
            departureLines.push(fallback ? formatDatetimeShort(fallback) : '—');
        }

        // Проблема: нет данных о прибытии/отъезде.
        // При самостоятельном приезде (direct_arrival=false) отсутствие трансфера arrival — нормально.
        const arrivalProblem = reg.direct_arrival === false
            ? !reg.arrival_datetime
            : (!arrival || (arrival?.notes && !arrival?.flight_datetime));
        const departureProblem = reg.direct_departure === false
            ? !reg.departure_datetime
            : (!departure || (departure?.notes && !departure?.flight_datetime));

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

        const childBadge = isChild ? ` <span class="badge badge-xs badge-warning">${t('preliminary_child')}</span>` : '';

        return `
            <tr class="hover align-top${reg.status === 'cancelled' ? ' row-cancelled' : ''}${isChild ? ' opacity-80' : ''}">
                <td class="cursor-pointer ${buildingId === 'self' ? 'bg-error/20' : (buildingId && roomId) ? 'bg-success/20' : ''}" data-action="navigate-person" data-id="${v?.id}">
                    <div class="flex gap-3 items-center${isChild ? ' pl-4' : ''}">
                        ${photoUrl
                            ? `<img src="${e(photoUrl)}" class="guest-photo avatar-photo" alt="" data-initials="${initialsUpper}" data-photo-url="${e(photoUrl)}" onerror="replaceWithPlaceholder(this)">`
                            : `<div class="guest-photo-placeholder">${initialsUpper}</div>`
                        }
                        <div>
                            ${spiritualName ? `<div class="font-medium">${isChild ? '└ ' : ''}${e(spiritualName)}${childBadge}</div>` : ''}
                            <div class="${spiritualName ? 'text-xs opacity-60' : 'font-medium'}">${!spiritualName && isChild ? '└ ' : ''}${e(name)}${!spiritualName ? childBadge : ''}</div>
                        </div>
                    </div>
                </td>
                <td class="text-sm whitespace-nowrap ${v?.gender === 'male' ? 'bg-blue-500/10' : v?.gender === 'female' ? 'bg-pink-500/10' : ''}">${genderAge}</td>
                <td class="text-sm" data-stop-propagation>
                    <select class="select select-xs select-bordered w-full ${reg.status === 'guest' ? 'status-guest' : reg.status === 'team' ? 'status-team' : reg.status === 'volunteer' ? 'status-volunteer' : reg.status === 'vip' ? 'status-vip' : reg.status === 'cancelled' ? 'status-cancelled' : ''}"
                        data-action="status-change" data-id="${reg.id}"
                        ${disabledAttr}>
                        <option value="guest" ${reg.status === 'guest' ? 'selected' : ''}>${statusGuest}</option>
                        <option value="team" ${reg.status === 'team' ? 'selected' : ''}>${statusTeam}</option>
                        <option value="volunteer" ${reg.status === 'volunteer' ? 'selected' : ''}>${statusVolunteer}</option>
                        <option value="vip" ${reg.status === 'vip' ? 'selected' : ''}>${statusVip}</option>
                        <option value="cancelled" ${reg.status === 'cancelled' ? 'selected' : ''}>${statusCancelled}</option>
                    </select>
                </td>
                <td class="text-sm">${e(v?.india_experience || '—')}</td>
                <td class="text-sm">${e(reg.companions || '—')}</td>
                <td class="text-sm">${e(reg.accommodation_wishes || '—')}</td>
                <td class="text-center text-sm whitespace-nowrap ${arrivalProblem ? 'bg-warning/30' : ''}" data-stop-propagation>
                    ${arrivalLines.map(l => `<div>${l}</div>`).join('')}
                    ${canEdit ? `<a class="text-xs link opacity-60 hover:opacity-100 cursor-pointer" data-action="open-transfer-modal" data-id="${reg.id}">${t('preliminary_edit_short')}</a>` : ''}
                </td>
                <td class="text-center text-sm whitespace-nowrap ${departureProblem ? 'bg-warning/30' : ''}" data-stop-propagation>
                    ${departureLines.map(l => `<div>${l}</div>`).join('')}
                    ${canEdit ? `<a class="text-xs link opacity-60 hover:opacity-100 cursor-pointer" data-action="open-transfer-modal" data-id="${reg.id}">${t('preliminary_edit_short')}</a>` : ''}
                </td>
                <td class="text-sm">${e(reg.extended_stay || '—')}</td>
                <td class="text-sm">${e(reg.guest_questions || '—')}</td>
                <td class="text-sm">${e(reg.org_notes || '—')}</td>
                <td class="text-sm">
                    <select class="select select-xs select-bordered w-full ${reg.meal_type === 'prasad' ? 'meal-prasad' : reg.meal_type === 'self' ? 'meal-self' : reg.meal_type === 'child' ? 'meal-child' : ''}"
                        data-action="meal-type-change" data-id="${reg.id}"
                        ${disabledAttr}>
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
                        data-action="save-local-notes" data-id="${reg.id}"
                        ${disabledAttr}>${e(localNotes || '')}</textarea>
                </td>
                <td class="text-sm ${buildingId === 'self' ? 'bg-error/20' : buildingId ? 'bg-success/20' : ''}">
                    <select class="select select-xs select-bordered w-full"
                        data-action="building-change" data-id="${reg.id}"
                        ${disabledAttr}>
                        <option value="">—</option>
                        ${buildings.map(b => `<option value="${b.id}" ${buildingId === b.id ? 'selected' : ''}>${Layout.getName(b)}</option>`).join('')}
                        <option value="self" ${buildingId === 'self' ? 'selected' : ''}>${t('self_accommodation')}</option>
                    </select>
                </td>
                <td class="text-sm ${buildingId === 'self' ? 'bg-error/20' : roomId ? 'bg-success/20' : ''}">
                    <select class="select select-xs select-bordered w-full ${buildingId === 'self' ? 'hidden' : ''}"
                        id="room_select_${reg.id}"
                        data-action="room-change" data-id="${reg.id}"
                        ${disabledAttr}>
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

// Делегирование кликов в таблице гостей
const guestsTableEl = document.getElementById('guestsTable');
if (guestsTableEl && !guestsTableEl._delegated) {
    guestsTableEl._delegated = true;
    guestsTableEl.addEventListener('click', ev => {
        // Предотвращение всплытия для ячеек с формами, но пропускаем data-action элементы
        const btn = ev.target.closest('[data-action]');
        if (!btn && ev.target.closest('[data-stop-propagation]')) return;
        if (!btn) return;
        const id = btn.dataset.id;
        switch (btn.dataset.action) {
            case 'open-transfer-modal': openTransferModal(id); break;
            case 'navigate-person': window.location.href = `person.html?id=${id}`; break;
        }
    });
    guestsTableEl.addEventListener('change', ev => {
        const target = ev.target.closest('[data-action]');
        if (!target) return;
        const id = target.dataset.id;
        switch (target.dataset.action) {
            case 'status-change': updateStatus(id, target.value, target); break;
            case 'meal-type-change': onMealTypeChange(id, target.value, target); break;
            case 'save-local-notes': saveLocalNotes(id, target.value); break;
            case 'building-change': onBuildingChange(id, target.value); break;
            case 'room-change': onRoomChange(id, target.value); break;
        }
    });
}

// ==================== NOTES (LOCAL STORAGE) ====================
function getLocalNotes(registrationId) {
    const key = `preliminary_notes_${registrationId}`;
    try { return localStorage.getItem(key); } catch { return null; }
}

function saveLocalNotes(registrationId, value) {
    if (!window.hasPermission || !window.hasPermission('edit_preliminary')) {
        Layout.showNotification(t('preliminary_no_permission'), 'error');
        return;
    }
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

        const label = isFull ? `${room.number} (${t('preliminary_room_occupied')})` : room.number;
        const disabled = isFull ? 'disabled' : '';
        const selected = selectedRoomId === room.id ? 'selected' : '';

        html += `<option value="${room.id}" ${disabled} ${selected}>${label}</option>`;
    });

    return html;
}

async function onMealTypeChange(registrationId, mealType, selectElement) {
    // Проверка прав
    if (!window.hasPermission || !window.hasPermission('edit_preliminary')) {
        Layout.showNotification(t('preliminary_no_edit_permission'), 'error');
        return;
    }

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

// ==================== TRANSFER MODAL ====================

let currentTransferRegId = null;

function toggleDirectArrivalModal(checked) {
    document.getElementById('tmCustomArrivalBlock').classList.toggle('hidden', checked);
    document.getElementById('tmCalcArrivalBlock').classList.toggle('hidden', !checked);
    if (checked) updateCalcArrivalModal();
}

function toggleDirectDepartureModal(checked) {
    document.getElementById('tmCustomDepartureBlock').classList.toggle('hidden', checked);
    document.getElementById('tmCalcDepartureBlock').classList.toggle('hidden', !checked);
    if (checked) updateCalcDepartureModal();
}

function updateCalcArrivalModal() {
    const flightVal = document.getElementById('tmArrivalDatetime').value;
    const calc = addHoursToDatetime(flightVal, 4);
    document.getElementById('tmCalcArrivalTime').textContent = formatDatetimeShort(calc);
}

function updateCalcDepartureModal() {
    const flightVal = document.getElementById('tmDepartureDatetime').value;
    const calc = addHoursToDatetime(flightVal, -7);
    document.getElementById('tmCalcDepartureTime').textContent = formatDatetimeShort(calc);
}

function openTransferModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    currentTransferRegId = registrationId;
    document.getElementById('transferRegId').value = registrationId;

    // Имя гостя
    const v = reg.vaishnavas;
    document.getElementById('transferModalName').textContent = getVaishnavName(v, '');

    // Трансферы
    const transfers = reg.guest_transfers || [];
    const arrival = transfers.find(t => t.direction === 'arrival');
    const departure = transfers.find(t => t.direction === 'departure');
    const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
    const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

    // Прилёт
    document.getElementById('tmArrivalDatetime').value = arrival?.flight_datetime ? arrival.flight_datetime.slice(0, 16) : '';
    document.getElementById('tmArrivalFlight').value = arrival?.flight_number || '';
    document.getElementById('tmArrivalTransfer').value = arrival?.needs_transfer || '';

    // Вылет
    document.getElementById('tmDepartureDatetime').value = departure?.flight_datetime ? departure.flight_datetime.slice(0, 16) : '';
    document.getElementById('tmDepartureFlight').value = departure?.flight_number || '';
    document.getElementById('tmDepartureTransfer').value = departure?.needs_transfer || '';

    // Прямой приезд/отъезд
    const directArrival = reg.direct_arrival !== false;
    document.getElementById('tmDirectArrival').checked = directArrival;
    toggleDirectArrivalModal(directArrival);
    document.getElementById('tmArrivalAtAshram').value = reg.arrival_datetime ? reg.arrival_datetime.slice(0, 16) : '';
    document.getElementById('tmArrivalRetreatTransfer').value = arrivalRetreat?.needs_transfer || '';

    const directDeparture = reg.direct_departure !== false;
    document.getElementById('tmDirectDeparture').checked = directDeparture;
    toggleDirectDepartureModal(directDeparture);
    document.getElementById('tmDepartureFromAshram').value = reg.departure_datetime ? reg.departure_datetime.slice(0, 16) : '';
    document.getElementById('tmDepartureRetreatTransfer').value = departureRetreat?.needs_transfer || '';

    document.getElementById('transferModal').showModal();
}

async function saveTransfers() {
    const regId = currentTransferRegId;
    if (!regId) return;

    if (!window.hasPermission || !window.hasPermission('edit_preliminary')) {
        Layout.showNotification(t('preliminary_no_permission'), 'error');
        return;
    }

    const reg = registrations.find(r => r.id === regId);
    if (!reg) return;

    try {
        const directArrival = document.getElementById('tmDirectArrival').checked;
        const directDeparture = document.getElementById('tmDirectDeparture').checked;

        // arrival_datetime: расчёт из рейса +4ч или ручной ввод
        const arrivalDatetime = directArrival
            ? addHoursToDatetime(document.getElementById('tmArrivalDatetime').value, 4)
            : (document.getElementById('tmArrivalAtAshram').value || null);

        // departure_datetime: расчёт из рейса −7ч или ручной ввод
        const departureDatetime = directDeparture
            ? addHoursToDatetime(document.getElementById('tmDepartureDatetime').value, -7)
            : (document.getElementById('tmDepartureFromAshram').value || null);

        // Автоперенос дат в другой ретрит или предупреждение
        let actualArrival = arrivalDatetime;
        let actualDeparture = departureDatetime;
        if (retreat) {
            const moveResult = await Utils.checkAndMoveDatesAcrossRetreats({
                db: Layout.db, registrationId: regId, vaishnavId: reg.vaishnava_id,
                retreat, arrivalDatetime, departureDatetime
            });
            if (moveResult.warnings.length && !confirm(moveResult.warnings.join('\n') + '\n\n' + t('preliminary_save_anyway'))) return;
            if (moveResult.clearedDeparture) actualDeparture = null;
            if (moveResult.clearedArrival) actualArrival = null;
            moveResult.notifications.forEach(n => Layout.showNotification(n, 'info'));
        }

        // 1. Обновляем регистрацию
        const { error: regError } = await Layout.db
            .from('retreat_registrations')
            .update({
                direct_arrival: directArrival,
                direct_departure: directDeparture,
                arrival_datetime: actualArrival,
                departure_datetime: actualDeparture
            })
            .eq('id', regId);
        if (regError) throw regError;

        // 2. Обновляем residents.check_in/check_out
        if (reg.resident?.id) {
            const resUpdate = {};
            if (arrivalDatetime) resUpdate.check_in = arrivalDatetime.slice(0, 10);
            if (departureDatetime) resUpdate.check_out = departureDatetime.slice(0, 10);
            if (Object.keys(resUpdate).length > 0) {
                await Layout.db.from('residents').update(resUpdate).eq('id', reg.resident.id);
            }
        }

        // 3. Upsert трансферов
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');
        const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
        const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

        // Прилёт (аэропорт)
        const arrData = {
            registration_id: regId,
            direction: 'arrival',
            flight_datetime: document.getElementById('tmArrivalDatetime').value || null,
            flight_number: document.getElementById('tmArrivalFlight').value || null,
            needs_transfer: document.getElementById('tmArrivalTransfer').value || null
        };
        if (arrival) {
            await Layout.db.from('guest_transfers').update(arrData).eq('id', arrival.id);
        } else if (arrData.flight_datetime || arrData.flight_number || arrData.needs_transfer) {
            await Layout.db.from('guest_transfers').insert(arrData);
        }

        // Трансфер приезд в ШРСК (если не сразу из аэропорта)
        if (!directArrival) {
            const arrRetreatData = {
                registration_id: regId,
                direction: 'arrival_retreat',
                flight_datetime: document.getElementById('tmArrivalAtAshram').value || null,
                needs_transfer: document.getElementById('tmArrivalRetreatTransfer').value || null
            };
            if (arrivalRetreat) {
                await Layout.db.from('guest_transfers').update(arrRetreatData).eq('id', arrivalRetreat.id);
            } else if (arrRetreatData.flight_datetime || arrRetreatData.needs_transfer) {
                await Layout.db.from('guest_transfers').insert(arrRetreatData);
            }
        } else if (arrivalRetreat) {
            await Layout.db.from('guest_transfers').delete().eq('id', arrivalRetreat.id);
        }

        // Вылет (аэропорт)
        const depData = {
            registration_id: regId,
            direction: 'departure',
            flight_datetime: document.getElementById('tmDepartureDatetime').value || null,
            flight_number: document.getElementById('tmDepartureFlight').value || null,
            needs_transfer: document.getElementById('tmDepartureTransfer').value || null
        };
        if (departure) {
            await Layout.db.from('guest_transfers').update(depData).eq('id', departure.id);
        } else if (depData.flight_datetime || depData.flight_number || depData.needs_transfer) {
            await Layout.db.from('guest_transfers').insert(depData);
        }

        // Трансфер выезд из ШРСК (если не сразу в аэропорт)
        if (!directDeparture) {
            const depRetreatData = {
                registration_id: regId,
                direction: 'departure_retreat',
                flight_datetime: document.getElementById('tmDepartureFromAshram').value || null,
                needs_transfer: document.getElementById('tmDepartureRetreatTransfer').value || null
            };
            if (departureRetreat) {
                await Layout.db.from('guest_transfers').update(depRetreatData).eq('id', departureRetreat.id);
            } else if (depRetreatData.flight_datetime || depRetreatData.needs_transfer) {
                await Layout.db.from('guest_transfers').insert(depRetreatData);
            }
        } else if (departureRetreat) {
            await Layout.db.from('guest_transfers').delete().eq('id', departureRetreat.id);
        }

        // Перезагружаем данные и перерисовываем таблицу
        await loadRegistrations();
        document.getElementById('transferModal').close();
        Layout.showNotification(t('preliminary_transfers_saved'), 'success');
    } catch (err) {
        console.error('Error saving transfers:', err);
        Layout.handleError(err, 'Сохранение трансферов');
    }
}

async function onBuildingChange(registrationId, buildingId) {
    // Проверка прав
    if (!window.hasPermission || !window.hasPermission('edit_preliminary')) {
        Layout.showNotification(t('preliminary_no_edit_permission'), 'error');
        return;
    }

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
    // Проверка прав
    if (!window.hasPermission || !window.hasPermission('edit_preliminary')) {
        Layout.showNotification(t('preliminary_no_edit_permission'), 'error');
        return;
    }

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
        check_in: getRegCheckIn(reg),
        check_out: getRegCheckOut(reg),
        status: 'confirmed',
        category_id: STATUS_CATEGORY_MAP[reg.status] || DEFAULT_CATEGORY_ID,
        has_housing: true,
        has_meals: reg.meal_type !== 'self'
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
        Layout.showNotification(t('preliminary_registration_not_found'), 'error');
        return;
    }

    const data = {
        room_id: null, // NULL indicates self-accommodation
        vaishnava_id: reg.vaishnava_id,
        retreat_id: retreatId,
        check_in: getRegCheckIn(reg),
        check_out: getRegCheckOut(reg),
        status: 'confirmed',
        category_id: STATUS_CATEGORY_MAP[reg.status] || DEFAULT_CATEGORY_ID,
        has_housing: false,
        has_meals: reg.meal_type !== 'self'
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
// === Добавить нового гостя (создание вайшнава + регистрация) ===

function openNewGuestModal() {
    if (!retreatId) {
        Layout.showNotification(t('select_retreat_first'), 'warning');
        return;
    }
    const form = document.getElementById('newGuestForm');
    form.reset();
    // Сброс: галочки включены → скрыть отдельные поля приезда/отъезда
    document.getElementById('arrivalDatetimeRow').classList.add('hidden');
    document.getElementById('departureDatetimeRow').classList.add('hidden');
    document.getElementById('newGuestModal').showModal();
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('newGuestForm');
    if (!form) return;
    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = ev.target;

        // Валидация
        if (!f.gender.value) {
            Layout.showNotification(t('preliminary_specify_gender'), 'warning');
            return;
        }
        if (!f.phone.value.trim() && !f.email.value.trim()) {
            Layout.showNotification(t('preliminary_specify_phone_or_email'), 'warning');
            return;
        }
        if (!f.spiritual_name.value.trim() && (!f.first_name.value.trim() || !f.last_name.value.trim())) {
            Layout.showNotification(t('preliminary_specify_name'), 'warning');
            return;
        }

        try {
            // 1. Создать вайшнава
            const { data: vData, error: vErr } = await Layout.db
                .from('vaishnavas')
                .insert({
                    first_name: f.first_name.value.trim() || null,
                    last_name: f.last_name.value.trim() || null,
                    spiritual_name: f.spiritual_name.value.trim() || null,
                    gender: f.gender.value,
                    birth_date: f.birth_date.value || null,
                    phone: f.phone.value.trim() || null,
                    email: f.email.value.trim() || null,
                    telegram: f.telegram.value.trim() || null,
                    country: f.country.value.trim() || null,
                    city: f.city.value.trim() || null,
                    india_experience: f.india_experience.value.trim() || null
                })
                .select('id')
                .single();
            if (vErr) throw vErr;

            // 2. Создать регистрацию на ретрит
            const directArrival = f.direct_arrival.checked;
            const directDeparture = f.direct_departure.checked;
            // Если «сразу на ретрит» — arrival_datetime = рейс + 4ч (время в пути из аэропорта)
            // Если нет — берём вручную указанное «Время приезда в ШРСК»
            const arrivalDt = directArrival
                ? addHoursToDatetime(f.arrival_flight_datetime.value, 4)
                : (f.arrival_datetime.value || null);
            // Если «с ретрита на самолёт» — departure_datetime = рейс − 7ч (время выезда из ШРСК)
            // Если нет — берём вручную указанное «Время выезда из ШРСК»
            const departureDt = directDeparture
                ? addHoursToDatetime(f.departure_flight_datetime.value, -7)
                : (f.departure_datetime.value || null);

            const { data: regData, error: regErr } = await Layout.db
                .from('retreat_registrations')
                .insert({
                    retreat_id: retreatId,
                    vaishnava_id: vData.id,
                    status: f.status.value || 'guest',
                    meal_type: f.meal_type.value || 'prasad',
                    companions: f.companions.value.trim() || null,
                    accommodation_wishes: f.accommodation_wishes.value.trim() || null,
                    extended_stay: f.extended_stay.value.trim() || null,
                    guest_questions: f.guest_questions.value.trim() || null,
                    org_notes: f.org_notes.value.trim() || null,
                    arrival_datetime: arrivalDt,
                    departure_datetime: departureDt,
                    direct_arrival: directArrival,
                    direct_departure: directDeparture
                })
                .select('id')
                .single();
            if (regErr) throw regErr;

            // 3. Создать трансферы (если есть данные)
            const transfers = [];
            // Трансфер прилёт (аэропорт)
            if (f.arrival_flight_datetime.value || f.arrival_flight.value.trim()) {
                transfers.push({
                    registration_id: regData.id,
                    direction: 'arrival',
                    flight_datetime: f.arrival_flight_datetime.value || null,
                    flight_number: f.arrival_flight.value.trim() || null,
                    needs_transfer: f.arrival_transfer.value || null
                });
            }
            // Трансфер приезд на ретрит (если не сразу из аэропорта)
            if (!directArrival && (f.arrival_datetime.value || f.arrival_retreat_transfer.value)) {
                transfers.push({
                    registration_id: regData.id,
                    direction: 'arrival_retreat',
                    flight_datetime: f.arrival_datetime.value || null,
                    needs_transfer: f.arrival_retreat_transfer.value || null
                });
            }
            // Трансфер отъезд с ретрита (если не сразу в аэропорт)
            if (!directDeparture && (f.departure_datetime.value || f.departure_retreat_transfer.value)) {
                transfers.push({
                    registration_id: regData.id,
                    direction: 'departure_retreat',
                    flight_datetime: f.departure_datetime.value || null,
                    needs_transfer: f.departure_retreat_transfer.value || null
                });
            }
            // Трансфер вылет (аэропорт)
            if (f.departure_flight_datetime.value || f.departure_flight.value.trim()) {
                transfers.push({
                    registration_id: regData.id,
                    direction: 'departure',
                    flight_datetime: f.departure_flight_datetime.value || null,
                    flight_number: f.departure_flight.value.trim() || null,
                    needs_transfer: f.departure_transfer.value || null
                });
            }
            if (transfers.length > 0) {
                const { error: tErr } = await Layout.db
                    .from('guest_transfers')
                    .insert(transfers);
                if (tErr) console.error('Error creating transfers:', tErr);
            }

            document.getElementById('newGuestModal').close();
            await Promise.all([loadVaishnavas(), loadRegistrations()]);
            Layout.showNotification(t('preliminary_guest_added'), 'success');
        } catch (err) {
            Layout.handleError(err, 'Создание гостя');
        }
    });
});

// === Добавить существующего гостя ===

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
        const badge = v.is_team_member ? `<span class="badge badge-xs badge-primary ml-2">${t('preliminary_team')}</span>` : '';
        return `
            <div class="px-3 py-2 hover:bg-base-200 cursor-pointer flex items-center" data-action="select-vaishnav" data-id="${v.id}" data-name="${e(name)}" data-spiritual="${e(v.spiritual_name || '')}">
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

// Делегирование кликов в подсказках вайшнавов
document.getElementById('vaishnavSuggestions').addEventListener('click', ev => {
    const el = ev.target.closest('[data-action="select-vaishnav"]');
    if (el) selectVaishnav(el.dataset.id, el.dataset.name, el.dataset.spiritual);
});

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
// Маппинг статуса регистрации → category_id для шахматки
const STATUS_CATEGORY_MAP = {
    'team': '10c4c929-6aaf-4b73-a15a-b7c5ab70f64b',   // Команда
    'guest': '6ad3bfdd-cb95-453a-b589-986717615736',   // Гость
    'volunteer': 'cdb7a43e-51a8-47cd-ac97-c6fdf4fccd5e', // Волонтёр
    'vip': 'ab57efc9-504a-4a31-93e6-6de8daa46bb7'      // Важный гость
};
const DEFAULT_CATEGORY_ID = '6ad3bfdd-cb95-453a-b589-986717615736'; // Гость

let residentCategories = [];

async function loadResidentCategories() {
    residentCategories = await Cache.getOrLoad('resident_categories', async () => {
        const { data, error } = await Layout.db
            .from('resident_categories')
            .select('id, slug, name_ru, name_en, name_hi, color, sort_order')
            .lt('sort_order', 999)
            .order('sort_order');
        if (error) { console.error('Error loading categories:', error); return []; }
        return data || [];
    }, 5 * 60 * 1000);
}

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
    existingResidentId: null,  // для переселения
    regStatus: null  // статус регистрации для определения категории
};

async function loadBuildingsAndRooms() {
    const [allBuildingsData, floorPlansRes] = await Promise.all([
        Cache.getOrLoad('buildings_with_rooms', async () => {
            const { data, error } = await Layout.db.from('buildings')
                .select('*, rooms(*)')
                .eq('is_active', true)
                .order('sort_order');
            if (error) { console.error('Error loading buildings:', error); return null; }
            return data;
        }, 3600000),
        Layout.db.from('floor_plans')
            .select('*')
    ]);

    if (floorPlansRes.error) console.error('Error loading floor plans:', floorPlansRes.error);

    let allBuildings = allBuildingsData || [];

    // Фильтруем временные здания по датам ретрита
    if (retreat?.start_date && retreat?.end_date) {
        allBuildings = allBuildings.filter(b => {
            // Постоянные здания показываем всегда
            if (!b.is_temporary) return true;
            // Временные без дат — доступны всегда
            if (!b.available_from && !b.available_until) return true;
            // Временные — только если период аренды пересекается с ретритом
            return b.available_from <= retreat.end_date && b.available_until >= retreat.start_date;
        });
    } else {
        // Без ретрита показываем постоянные и временные без дат
        allBuildings = allBuildings.filter(b => {
            if (!b.is_temporary) return true;
            // Временные без дат — доступны всегда
            return !b.available_from && !b.available_until;
        });
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
        checkIn: getRegCheckIn(reg),
        checkOut: getRegCheckOut(reg),
        mode: 'list',
        occupancy: {},
        currentBuildingId: buildings[0]?.id || null,
        currentFloor: 1,
        existingResidentId: reg.resident?.id || null,
        regStatus: reg.status || null,
        mealType: reg.meal_type || null
    };

    const modal = document.getElementById('placementModal');
    const guestInfo = document.getElementById('placementGuestInfo');

    // Показать инфо о госте
    const v = reg.vaishnavas;
    const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
    const spiritualName = v?.spiritual_name ? ` (${v.spiritual_name})` : '';

    guestInfo.innerHTML = `
        <div class="font-medium">${e(name)}${e(spiritualName)}</div>
        ${reg.accommodation_wishes ? `<div class="text-sm opacity-60 mt-1">${t('preliminary_wishes')}: ${e(reg.accommodation_wishes)}</div>` : ''}
    `;

    // Заполнить dropdown категории
    const catSelect = document.getElementById('placementCategory');
    catSelect.innerHTML = residentCategories.map(c =>
        `<option value="${c.id}">${Layout.getName(c)}</option>`
    ).join('');
    // Предвыбрать по статусу регистрации
    const preselectedCat = STATUS_CATEGORY_MAP[reg.status] || DEFAULT_CATEGORY_ID;
    catSelect.value = preselectedCat;

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
    const { data: residentsData, error } = await Layout.db
        .from('residents')
        .select('id, room_id, check_in, check_out')
        .not('room_id', 'is', null)
        .eq('status', 'confirmed')
        .lte('check_in', checkOut)
        .gte('check_out', checkIn);

    if (error) console.error('Error loading residents:', error);

    placementState.occupancy = calcPeakOccupancy(residentsData, placementState.existingResidentId);
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
        roomsList.innerHTML = `<div class="text-center py-4 opacity-50">${t('preliminary_no_buildings')}</div>`;
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
                ${disabled ? 'disabled' : `data-action="select-placement-room" data-id="${room.id}" data-building-id="${building.id}"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html || `<div class="text-center py-4 opacity-50">${t('preliminary_no_rooms')}</div>`;

    // Делегирование кликов в списке комнат
    if (!roomsList._delegated) {
        roomsList._delegated = true;
        roomsList.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            if (btn.dataset.action === 'select-placement-room') {
                selectPlacementRoom(btn.dataset.id, btn.dataset.buildingId);
            }
        });
    }
}

function renderPlacementPlanView() {
    // Табы зданий
    const buildingTabsHtml = buildings.map(b => {
        const hasPlans = floorPlans.some(fp => fp.building_id === b.id);
        const isActive = b.id === placementState.currentBuildingId;
        return `<button type="button" class="tab ${isActive ? 'tab-active' : ''} ${!hasPlans ? 'opacity-50' : ''}"
            data-action="select-plan-building" data-id="${b.id}" ${!hasPlans ? `title="${t('preliminary_no_plan')}"` : ''}>
            ${Layout.getName(b)}
        </button>`;
    }).join('');
    const planBuildingTabsEl = document.getElementById('planBuildingTabs');
    planBuildingTabsEl.innerHTML = buildingTabsHtml;
    if (!planBuildingTabsEl._delegated) {
        planBuildingTabsEl._delegated = true;
        planBuildingTabsEl.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="select-plan-building"]');
            if (btn) selectPlanBuilding(btn.dataset.id);
        });
    }

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
        document.getElementById('planNoFloorPlan').textContent = t('preliminary_no_plans_for_building');
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
            data-action="select-plan-floor" data-floor="${floor}">
            ${floor} ${t('preliminary_floor')}
        </button>`;
    }).join('');
    const planFloorTabsEl = document.getElementById('planFloorTabs');
    planFloorTabsEl.innerHTML = floorTabsHtml;
    if (!planFloorTabsEl._delegated) {
        planFloorTabsEl._delegated = true;
        planFloorTabsEl.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="select-plan-floor"]');
            if (btn) selectPlanFloor(Number(btn.dataset.floor));
        });
    }

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

        const clickAttrs = isFull ? '' : `data-action="select-placement-room" data-id="${room.id}" data-building-id="${building.id}"`;
        const disabledClass = isFull ? 'disabled' : '';

        svgContent += `
            <g class="room-marker ${disabledClass}" ${clickAttrs}>
                <rect x="${x}" y="${y}" width="${w}" height="${h}"
                    fill="${fillColor}" rx="0.5" opacity="0.85" />
                <text x="${x + w/2}" y="${y + h/2}" class="room-label">
                    ${room.number}${occupied > 0 ? ` (${occupied}/${capacity})` : ''}
                </text>
            </g>`;
    });

    svg.innerHTML = svgContent;

    // Делегирование кликов по комнатам на плане
    if (!svg._delegated) {
        svg._delegated = true;
        svg.addEventListener('click', ev => {
            const g = ev.target.closest('[data-action="select-placement-room"]');
            if (g) selectPlacementRoom(g.dataset.id, g.dataset.buildingId);
        });
    }
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
        status: 'confirmed',
        category_id: document.getElementById('placementCategory')?.value
            || STATUS_CATEGORY_MAP[placementState.regStatus]
            || DEFAULT_CATEGORY_ID,
        has_housing: true,
        has_meals: placementState.mealType ? placementState.mealType !== 'self' : true
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
    title.textContent = spiritualName || name || t('preliminary_guest_info');

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
                    <div class="text-xs opacity-50 mb-1">${t('preliminary_arrival_flight')}</div>
                    <div class="font-medium">${arrDate}</div>
                    ${arrival.flight_number ? `<div class="text-sm opacity-70">${arrival.flight_number}</div>` : ''}
                    ${arrival.needs_transfer === 'yes' ? `<div class="text-sm">${t('preliminary_needs_transfer')}</div>` : ''}
                </div>
            `;
        }
        if (departure) {
            const depDate = departure.flight_datetime ? formatFlightDateTime(departure.flight_datetime) : (departure.notes || '—');
            flightHtml += `
                <div>
                    <div class="text-xs opacity-50 mb-1">${t('preliminary_departure_flight')}</div>
                    <div class="font-medium">${depDate}</div>
                    ${departure.flight_number ? `<div class="text-sm opacity-70">${departure.flight_number}</div>` : ''}
                    ${departure.needs_transfer === 'yes' ? `<div class="text-sm">${t('preliminary_needs_transfer')}</div>` : ''}
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
                <div class="text-xs opacity-50 mb-1">${t('preliminary_companions')}</div>
                <div>${e(reg.companions)}</div>
            </div>
        `);
    }

    // Extended stay
    if (reg.extended_stay) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">${t('preliminary_after_retreat')}</div>
                <div>${e(reg.extended_stay)}</div>
            </div>
        `);
    }

    // Accommodation wishes
    if (reg.accommodation_wishes) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">${t('preliminary_accommodation_wishes')}</div>
                <div>${e(reg.accommodation_wishes)}</div>
            </div>
        `);
    }

    // Org notes
    if (reg.org_notes) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">${t('preliminary_org_notes')}</div>
                <div class="whitespace-pre-wrap">${e(reg.org_notes)}</div>
            </div>
        `);
    }

    // Guest questions
    if (reg.guest_questions) {
        sections.push(`
            <div>
                <div class="text-xs opacity-50 mb-1">${t('preliminary_questions')}</div>
                <div class="whitespace-pre-wrap">${e(reg.guest_questions)}</div>
            </div>
        `);
    }

    content.innerHTML = sections.length > 0
        ? sections.join('<div class="divider my-2"></div>')
        : `<div class="text-center opacity-50 py-4">${t('preliminary_no_additional_info')}</div>`;

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
                logMessage(log, `✓ ${t('preliminary_import_created')}: ${result.name}`, 'success');
            } else if (result.status === 'updated') {
                importStats.updated++;
                logMessage(log, `↻ ${t('preliminary_import_updated')}: ${result.name}`, 'info');
            } else if (result.status === 'conflict') {
                conflicts.push(result);
                logMessage(log, `⚠ ${t('preliminary_import_conflict')}: ${result.name}`, 'warning');
            } else if (result.status === 'skipped') {
                importStats.skipped++;
                logMessage(log, `— ${t('preliminary_import_skipped')}: ${row.name || row.name2}`, 'info');
            }
        } catch (err) {
            logMessage(log, `✗ ${t('preliminary_import_error_row')} ${i + 1}: ${err.message}`, 'error');
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
        displayName: `${firstName} ${lastName}`.trim() || row.name2 || t('preliminary_no_name'),

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
                        <strong>${t('preliminary_import_row')} ${c.rowNum}:</strong> ${e(c.name)}
                        <span class="badge badge-sm ml-2">${c.candidates[0]?.score || 0} ${t('preliminary_import_points')}</span>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 text-sm mb-3">
                    <div>
                        <div class="font-medium mb-1">${t('preliminary_import_in_csv')}:</div>
                        <div>${e(parsed.firstName)} ${e(parsed.lastName)}</div>
                        <div>${e(parsed.spiritualName || '—')}</div>
                        <div>${e(parsed.email || '—')}</div>
                        <div>${e(parsed.phone || '—')}</div>
                    </div>
                    <div>
                        <div class="font-medium mb-1">${t('preliminary_import_in_db')}:</div>
                        ${candidate ? `
                            <div class="${parsed.firstName === candidate.first_name ? 'match-same' : 'match-diff'}">${e(candidate.first_name)} ${e(candidate.last_name || '')}</div>
                            <div class="${parsed.spiritualName === candidate.spiritual_name ? 'match-same' : 'match-diff'}">${e(candidate.spiritual_name || '—')}</div>
                            <div class="${parsed.email === candidate.email ? 'match-same' : 'match-diff'}">${e(candidate.email || '—')}</div>
                            <div class="${normalizePhone(parsed.phone) === normalizePhone(candidate.phone) ? 'match-same' : 'match-diff'}">${e(candidate.phone || '—')}</div>
                        ` : `<div class="opacity-50">${t('preliminary_import_no_matches')}</div>`}
                    </div>
                </div>

                <div class="flex gap-4">
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="update" class="radio radio-sm" ${candidate ? 'checked' : ''} />
                        <span>${t('preliminary_import_same_person')}</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="create" class="radio radio-sm" ${!candidate ? 'checked' : ''} />
                        <span>${t('preliminary_import_create_new')}</span>
                    </label>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="conflict_${idx}" value="skip" class="radio radio-sm" />
                        <span>${t('preliminary_import_skip')}</span>
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
        `${t('preliminary_import_created')}: ${importStats.created}, ${t('preliminary_import_updated')}: ${importStats.updated}, ${t('preliminary_import_skipped')}: ${importStats.skipped}`;

    // Reload data
    loadRegistrations();
    loadVaishnavas();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'preliminary' });
    Layout.showLoader();

    await Promise.all([loadAllRetreats(), loadVaishnavas(), loadBuildingsAndRooms(), loadResidentCategories()]);

    setupFilters();
    updateSortIcons();
    subscribeToRealtime();

    // Если auth ещё не готов — перерисовать таблицу после готовности прав
    if (!window.currentUser) {
        window.addEventListener('authReady', () => renderTable(), { once: true });
    }

    Layout.hideLoader();
}

// ==================== REALTIME ====================
let realtimeTimeout = null;

function subscribeToRealtime() {
    const channel = Layout.db.channel('preliminary-realtime');

    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'residents' },
        handleRealtimeChange
    );

    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'retreat_registrations' },
        handleRealtimeChange
    );

    channel.subscribe();
}

function handleRealtimeChange(payload) {
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadRegistrations();
        renderTable();
        Layout.showNotification(t('preliminary_data_updated'), 'info');
    }, 500);
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
