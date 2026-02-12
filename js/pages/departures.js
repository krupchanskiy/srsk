const t = key => Layout.t(key);

let retreatId = null;
let registrations = [];
let residentsMap = new Map(); // vaishnava_id → { roomNumber, buildingName, buildingId }
let buildings = [];
let selectedBuildingId = 'all';
let searchQuery = '';

// Заменить битое изображение на заглушку с инициалами
window.replacePhotoWithPlaceholder = function(img) {
    const initials = img.dataset.initials || '?';
    const placeholder = document.createElement('div');
    placeholder.className = 'w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold';
    placeholder.textContent = initials;
    img.replaceWith(placeholder);
};

// Глобальный обработчик клика по аватарам (event delegation для XSS-безопасности)
document.addEventListener('click', function(event) {
    const avatarPhoto = event.target.closest('.avatar-photo');
    if (avatarPhoto && avatarPhoto.dataset.photoUrl) {
        event.stopPropagation();
        Layout.openPhotoModal(avatarPhoto.dataset.photoUrl);
    }
});

// ==================== DATA LOADING ====================
async function loadRetreats() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('*')
        .order('start_date', { ascending: false });

    if (error) {
        console.error('Error loading retreats:', error);
        return;
    }

    const select = document.getElementById('retreatSelect');
    select.innerHTML = `<option value="">${t('select_retreat')}</option>` +
        (data || []).map(r => `<option value="${r.id}">${Layout.getName(r)}</option>`).join('');

    // Check URL for retreat id
    const urlParams = new URLSearchParams(window.location.search);
    const urlRetreatId = urlParams.get('retreat');
    if (urlRetreatId) {
        select.value = urlRetreatId;
        onRetreatChange(urlRetreatId);
    } else if (data && data.length > 0) {
        // Автовыбор ближайшего ретрита
        const today = toLocalDateStr(new Date());
        const active = data.filter(r => r.end_date >= today);
        const nearest = active.length > 0 ? active[active.length - 1] : data[0];
        select.value = nearest.id;
        onRetreatChange(nearest.id);
    }
}

async function onRetreatChange(id) {
    retreatId = id;

    // Update URL
    const url = new URL(window.location);
    if (id) {
        url.searchParams.set('retreat', id);
    } else {
        url.searchParams.delete('retreat');
    }
    window.history.replaceState({}, '', url);

    if (!id) {
        registrations = [];
        residentsMap = new Map();
        buildings = [];
        selectedBuildingId = 'all';
        renderTable();
        document.getElementById('statsWrapper').style.display = 'none';
        return;
    }

    // Сброс фильтра при смене ретрита
    selectedBuildingId = 'all';
    if (document.getElementById('buildingFilter')) {
        document.getElementById('buildingFilter').value = 'all';
    }

    await loadRegistrations();
}

async function loadRegistrations() {
    Layout.showLoader();

    const regResult = await Layout.db
        .from('retreat_registrations')
        .select(`
            id,
            vaishnava_id,
            status,
            vaishnavas (id, first_name, last_name, spiritual_name, gender, birth_date, phone, telegram, has_whatsapp, photo_url),
            guest_transfers (*)
        `)
        .eq('retreat_id', retreatId)
        .eq('is_deleted', false)
        .in('status', ['guest', 'team']);

    if (regResult.error) {
        Layout.hideLoader();
        console.error('Error loading registrations:', regResult.error);
        return;
    }

    registrations = regResult.data || [];

    // Собираем vaishnava_id для загрузки размещений
    const vaishnavaIds = registrations.map(r => r.vaishnava_id).filter(Boolean);

    residentsMap = new Map();
    if (vaishnavaIds.length > 0) {
        const resResult = await Layout.db
            .from('residents')
            .select('vaishnava_id, room_id, rooms(number, buildings(id, name_ru, name_en, name_hi))')
            .in('vaishnava_id', vaishnavaIds)
            .eq('status', 'confirmed');

        if (resResult.data) {
            resResult.data.forEach(r => {
                if (r.vaishnava_id) {
                    if (!r.room_id) {
                        // Self-accommodation (NULL room_id)
                        residentsMap.set(r.vaishnava_id, {
                            roomNumber: null,
                            buildingName: null,
                            buildingId: 'self',
                            isSelfAccommodation: true
                        });
                    } else if (r.rooms) {
                        residentsMap.set(r.vaishnava_id, {
                            roomNumber: r.rooms.number,
                            buildingName: Layout.getName(r.rooms.buildings),
                            buildingId: r.rooms.buildings.id,
                            isSelfAccommodation: false
                        });
                    }
                }
            });
        }
    }

    // Загружаем список зданий для фильтра
    await loadBuildings();

    Layout.hideLoader();

    updateStats();
    renderTable();
    document.getElementById('statsWrapper').style.display = '';
}

async function loadBuildings() {
    buildings = await Cache.getOrLoad('buildings_names', async () => {
        const { data, error } = await Layout.db
            .from('buildings')
            .select('id, name_ru, name_en, name_hi')
            .eq('is_active', true)
            .order('sort_order');
        if (error) { console.error('Error loading buildings:', error); return null; }
        return data;
    }, 3600000) || [];
    renderBuildingFilter();
}

function renderBuildingFilter() {
    const select = document.getElementById('buildingFilter');
    if (!select) return;

    const e = Layout.escapeHtml;
    let html = `<option value="all">${t('all_buildings')}</option>`;
    buildings.forEach(b => {
        html += `<option value="${e(b.id)}">${e(Layout.getName(b))}</option>`;
    });
    select.innerHTML = html;
}

function onBuildingChange(buildingId) {
    selectedBuildingId = buildingId;
    renderTable();
}

// Алиас для DateUtils.toISO (обратная совместимость)
function toLocalDateStr(date) {
    return DateUtils.toISO(date);
}

function updateStats() {
    const total = registrations.length;
    let withTime = 0;
    let noTime = 0;
    let today = 0;
    let tomorrow = 0;

    const now = new Date();
    const todayStr = toLocalDateStr(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = toLocalDateStr(tomorrowDate);

    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.direction === 'departure');
        if (departure?.flight_datetime) {
            withTime++;
            const estimatedDate = new Date(departure.flight_datetime);
            estimatedDate.setHours(estimatedDate.getHours() - 7);
            const estimatedStr = toLocalDateStr(estimatedDate);

            if (estimatedStr === todayStr) today++;
            if (estimatedStr === tomorrowStr) tomorrow++;
        } else {
            noTime++;
        }
    });

    document.getElementById('statToday').textContent = today;
    document.getElementById('statTomorrow').textContent = tomorrow;
    document.getElementById('statWithTime').textContent = withTime;
    document.getElementById('statNoTime').textContent = noTime;

    const chartDateInput = document.getElementById('chartDate');
    if (!chartDateInput.value) {
        chartDateInput.value = todayStr;
    }
    updateChart();
}

// ==================== STATS BLOCK ====================
const STATS_COLLAPSED_KEY = 'srsk_departures_stats_collapsed';

function toggleStatsBlock() {
    const statsBlock = document.getElementById('statsBlock');
    const icon = document.getElementById('statsToggleIcon');
    const isCollapsed = statsBlock.style.display === 'none';

    if (isCollapsed) {
        statsBlock.style.display = '';
        icon.textContent = '▼';
        localStorage.setItem(STATS_COLLAPSED_KEY, '0'); // 0 = развернут
    } else {
        statsBlock.style.display = 'none';
        icon.textContent = '▶';
        localStorage.setItem(STATS_COLLAPSED_KEY, '1'); // 1 = свернут
    }
}

function initStatsState() {
    const statsBlock = document.getElementById('statsBlock');
    const icon = document.getElementById('statsToggleIcon');
    let savedState;
    try { savedState = localStorage.getItem(STATS_COLLAPSED_KEY); } catch { savedState = null; }

    // По умолчанию свернут (если нет сохраненного состояния или сохранено '1')
    const isExpanded = savedState === '0';

    if (isExpanded) {
        statsBlock.style.display = '';
        icon.textContent = '▼';
    } else {
        statsBlock.style.display = 'none';
        icon.textContent = '▶';
    }
}

function updateChart() {
    const selectedDate = document.getElementById('chartDate').value;
    if (!selectedDate) return;

    const hourCounts = {};
    for (let h = 0; h < 24; h++) {
        hourCounts[h] = 0;
    }

    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.direction === 'departure');
        if (departure?.flight_datetime) {
            const estimatedDate = new Date(departure.flight_datetime);
            estimatedDate.setHours(estimatedDate.getHours() - 7);
            const dateStr = toLocalDateStr(estimatedDate);

            if (dateStr === selectedDate) {
                const hour = estimatedDate.getHours();
                hourCounts[hour]++;
            }
        }
    });

    const maxCount = Math.max(...Object.values(hourCounts), 1);

    const hoursOrder = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23];
    const chartBars = document.getElementById('chartBars');

    const maxBarHeight = 120;
    chartBars.innerHTML = hoursOrder.map(h => {
        const count = hourCounts[h];
        const heightPx = count > 0 ? Math.max(Math.round((count / maxCount) * maxBarHeight), 10) : 5;
        const barBg = count > 0 ? '#570df8' : '#e5e7eb';
        const title = `${h.toString().padStart(2, '0')}:00 — ${count} чел.`;

        return `<div style="flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 8px;" title="${title}">
            ${count > 0 ? `<div style="font-size: 11px; font-weight: 500; margin-bottom: 2px;">${count}</div>` : ''}
            <div style="width: 100%; height: ${heightPx}px; background: ${barBg}; border-radius: 4px 4px 0 0;"></div>
        </div>`;
    }).join('');
}

function changeChartDate(delta) {
    const input = document.getElementById('chartDate');
    const date = new Date(input.value + 'T12:00:00');
    date.setDate(date.getDate() + delta);
    input.value = toLocalDateStr(date);
    updateChart();
}

// ==================== HELPERS ====================
function calculateAge(birthDate) {
    if (!birthDate) return '';
    return DateUtils.calculateAge(birthDate);
}

function formatDateTime(datetime) {
    if (!datetime) return '';
    const date = new Date(datetime);
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day}.${month} ${hours}:${minutes}`;
}

function formatTime(datetime) {
    if (!datetime) return '';
    const date = new Date(datetime);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

function addHours(datetime, hours) {
    if (!datetime) return null;
    const date = new Date(datetime);
    date.setHours(date.getHours() + hours);
    return date.toISOString();
}

function formatDateLabel(dateStr) {
    const date = new Date(dateStr + 'T12:00:00');
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const weekDays = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
    return `${day}.${month}, ${weekDays[date.getDay()]}`;
}

function formatPhone(phone) {
    if (!phone) return '';
    return phone.replace(/[^\d+]/g, '');
}

// ==================== SEARCH ====================
function onSearchInput(query) {
    searchQuery = query.toLowerCase().trim();
    document.getElementById('searchClear').classList.toggle('hidden', !query);
    renderTable();
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    searchQuery = '';
    document.getElementById('searchClear').classList.add('hidden');
    renderTable();
}

function getFilteredRegistrations() {
    let filtered = [...registrations];

    // Фильтр по гостинице
    if (selectedBuildingId !== 'all') {
        filtered = filtered.filter(reg => {
            const accommodation = reg.vaishnava_id ? residentsMap.get(reg.vaishnava_id) : null;
            return accommodation && accommodation.buildingId === selectedBuildingId;
        });
    }

    // Фильтр по поиску
    if (searchQuery) {
        filtered = filtered.filter(reg => {
            const v = reg.vaishnavas;
            const name = `${v?.spiritual_name || ''} ${v?.first_name || ''} ${v?.last_name || ''}`.toLowerCase();
            return name.includes(searchQuery);
        });
    }

    return filtered;
}

// ==================== RENDER ====================
function getGroupLabel(dateStr) {
    const now = new Date();
    const todayStr = toLocalDateStr(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = toLocalDateStr(tomorrowDate);
    const dayAfterDate = new Date(now);
    dayAfterDate.setDate(dayAfterDate.getDate() + 2);
    const dayAfterStr = toLocalDateStr(dayAfterDate);

    if (dateStr === todayStr) return `${t('today')}, ${formatDateLabel(dateStr)}`;
    if (dateStr === tomorrowStr) return `${t('tomorrow')}, ${formatDateLabel(dateStr)}`;
    return formatDateLabel(dateStr);
}

function renderRow(reg) {
    const e = Layout.escapeHtml;
    const v = reg.vaishnavas;
    const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
    const spiritualName = v?.spiritual_name || '';

    const mainName = spiritualName || name;
    const subName = spiritualName ? name : '';

    const genderLabel = v?.gender === 'male' ? t('male_short') : v?.gender === 'female' ? t('female_short') : '';
    const age = v?.birth_date ? calculateAge(v.birth_date) : '';
    const genderAge = [genderLabel, age].filter(Boolean).join(', ');

    const departure = (reg.guest_transfers || []).find(t => t.direction === 'departure');
    const flightTime = departure?.flight_datetime;
    const estimatedCheckout = flightTime ? addHours(flightTime, -7) : null;
    const needsTransfer = departure?.needs_transfer === 'yes';
    const taxiOrdered = departure?.taxi_status === 'ordered';

    const accommodation = v ? residentsMap.get(v.id) : null;

    const phone = v?.phone ? formatPhone(v.phone) : '';
    const hasWhatsapp = v?.has_whatsapp && phone;
    const telegram = v?.telegram;

    // Аватар: фото или инициалы
    const photoUrl = v?.photo_url;
    const initials = e((spiritualName || name)
        .split(' ')
        .map(w => w[0])
        .join('')
        .substring(0, 2)
        .toUpperCase());

    const avatarHtml = photoUrl
        ? `<img src="${e(photoUrl)}" class="w-10 h-10 rounded-full object-cover cursor-pointer avatar-photo" alt="" data-initials="${initials}" data-photo-url="${e(photoUrl)}" onerror="replacePhotoWithPlaceholder(this)">`
        : `<div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold">${initials}</div>`;

    // Контакты
    let contactsHtml = '';
    if (hasWhatsapp) {
        contactsHtml += `<a href="https://wa.me/${phone.replace('+', '')}" target="_blank" class="text-green-600 hover:underline text-xs" title="WhatsApp">WA</a>`;
    } else if (phone) {
        contactsHtml += `<a href="tel:${phone}" class="hover:underline text-xs">${e(v.phone)}</a>`;
    }
    if (telegram) {
        const tgUsername = telegram.replace(/^@/, '');
        if (contactsHtml) contactsHtml += ' · ';
        contactsHtml += `<a href="https://t.me/${tgUsername}" target="_blank" class="text-blue-500 hover:underline text-xs" title="Telegram">TG</a>`;
    }

    return `
        <tr class="hover cursor-pointer" data-action="navigate-person" data-id="${v?.id}">
            <td>
                <div class="flex items-center gap-3">
                    ${avatarHtml}
                    <div class="min-w-0">
                        <div class="font-medium">${e(mainName)}</div>
                        ${subName ? `<div class="text-xs opacity-60">${e(subName)}</div>` : ''}
                    </div>
                </div>
            </td>
            <td class="text-sm">${genderAge || '—'}</td>
            <td class="text-sm text-center">
                <div class="font-semibold">${estimatedCheckout ? formatTime(estimatedCheckout) : '—'}</div>
                ${needsTransfer ? (taxiOrdered ? `<div class="badge badge-success badge-xs gap-1 mt-1 cursor-pointer" data-action="show-taxi-details" data-id="${departure.id}"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 103.07 59.75" fill="currentColor"><path d="M5.75,53.47c-1.68-1.71-2.63-4.23-2.68-6.64,2.97-10.49,6.26-20.89,9.36-31.35,1.71-5.78,1.81-10.95,9.24-12.11h58.86c3.74.23,7.15,2.76,8.35,6.35.33,1,.31,1.98.58,2.89,3.38,11.42,6.9,22.8,10.18,34.25-.11,4.72-3.5,8.64-8.16,9.3H11.55c-2.09-.16-4.35-1.22-5.8-2.7ZM21.72,9.78c-2.2.69-1.86,2.64-2.36,4.28-3.3,10.95-6.61,21.9-9.85,32.87-.47,2.23,1.92,3.11,3.77,3.19h76.19c1.99-.17,3.63-.69,3.83-2.97-3.25-10.64-6.4-21.3-9.61-31.95-.48-1.59-.56-4.58-2.24-5.26l-59.73-.16Z"/><polygon points="60.75 20.68 63.64 26.16 67.25 20.68 72.58 20.68 66.57 29.82 72.29 38.86 66.96 38.86 63.64 33.67 61.04 38.86 55.27 38.86 60.98 29.81 55.27 20.68 60.75 20.68"/><path d="M37.96,38.86l6.09-18.15,4.45-.05,6.48,18.2h-4.76l-1.27-3.29-4.91-.14-.89,3.43h-5.19ZM48.06,31.93c-.5-1.5-.78-3.12-1.3-4.61-.1-.28-.03-.66-.42-.58l-1.45,5.19h3.17Z"/><polygon points="39.12 20.68 39.12 25.01 33.92 25.01 33.92 38.86 28.73 38.86 28.73 25.01 23.54 25.01 23.54 20.68 39.12 20.68"/><rect x="74.03" y="20.68" width="5.19" height="18.18"/></svg>${t('ordered')}</div>` : `<div class="badge badge-warning badge-xs gap-1 mt-1 cursor-pointer" data-action="open-taxi-modal" data-id="${departure.id}"><svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 103.07 59.75" fill="currentColor"><path d="M5.75,53.47c-1.68-1.71-2.63-4.23-2.68-6.64,2.97-10.49,6.26-20.89,9.36-31.35,1.71-5.78,1.81-10.95,9.24-12.11h58.86c3.74.23,7.15,2.76,8.35,6.35.33,1,.31,1.98.58,2.89,3.38,11.42,6.9,22.8,10.18,34.25-.11,4.72-3.5,8.64-8.16,9.3H11.55c-2.09-.16-4.35-1.22-5.8-2.7ZM21.72,9.78c-2.2.69-1.86,2.64-2.36,4.28-3.3,10.95-6.61,21.9-9.85,32.87-.47,2.23,1.92,3.11,3.77,3.19h76.19c1.99-.17,3.63-.69,3.83-2.97-3.25-10.64-6.4-21.3-9.61-31.95-.48-1.59-.56-4.58-2.24-5.26l-59.73-.16Z"/><polygon points="60.75 20.68 63.64 26.16 67.25 20.68 72.58 20.68 66.57 29.82 72.29 38.86 66.96 38.86 63.64 33.67 61.04 38.86 55.27 38.86 60.98 29.81 55.27 20.68 60.75 20.68"/><path d="M37.96,38.86l6.09-18.15,4.45-.05,6.48,18.2h-4.76l-1.27-3.29-4.91-.14-.89,3.43h-5.19ZM48.06,31.93c-.5-1.5-.78-3.12-1.3-4.61-.1-.28-.03-.66-.42-.58l-1.45,5.19h3.17Z"/><polygon points="39.12 20.68 39.12 25.01 33.92 25.01 33.92 38.86 28.73 38.86 28.73 25.01 23.54 25.01 23.54 20.68 39.12 20.68"/><rect x="74.03" y="20.68" width="5.19" height="18.18"/></svg>${t('needs_transfer')}</div>`) : ''}
            </td>
            <td class="text-sm text-center">
                <div>${flightTime ? formatDateTime(flightTime) : '—'}</div>
            </td>
            <td class="text-sm ${accommodation?.isSelfAccommodation ? 'bg-error/20 font-medium text-error' : (accommodation ? 'bg-success/20 font-medium' : '')}">${accommodation?.isSelfAccommodation ? Layout.t('self_accommodation') : (accommodation ? `${accommodation.buildingName}, ${accommodation.roomNumber}` : '—')}</td>
            <td class="text-sm">${contactsHtml || '—'}</td>
        </tr>
    `;
}

function renderCard(reg) {
    const v = reg.vaishnavas;
    const name = v ? `${v.first_name || ''} ${v.last_name || ''}`.trim() : '—';
    const spiritualName = v?.spiritual_name || '';

    const genderLabel = v?.gender === 'male' ? t('male_short') : v?.gender === 'female' ? t('female_short') : '';
    const age = v?.birth_date ? calculateAge(v.birth_date) : '';
    const genderAge = [genderLabel, age].filter(Boolean).join(', ');

    const departure = (reg.guest_transfers || []).find(t => t.direction === 'departure');
    const flightTime = departure?.flight_datetime;
    const estimatedCheckout = flightTime ? addHours(flightTime, -7) : null;

    const accommodation = v ? residentsMap.get(v.id) : null;

    const phone = v?.phone ? formatPhone(v.phone) : '';
    const hasWhatsapp = v?.has_whatsapp && phone;
    const telegram = v?.telegram;

    // Строим карточку
    let html = `<div class="bg-base-100 rounded-lg shadow p-3 flex flex-col gap-1.5">`;

    // Имя (клик → person.html)
    html += `<a href="../vaishnavas/person.html?id=${v?.id}" class="hover:underline">`;
    if (spiritualName) {
        html += `<span class="font-semibold">${spiritualName}</span>`;
        html += `<span class="text-xs opacity-60 ml-1.5">${name}</span>`;
    } else {
        html += `<span class="font-semibold">${name}</span>`;
    }
    html += `</a>`;

    // Информация в строку
    const infoParts = [];
    if (genderAge) infoParts.push(genderAge);
    if (estimatedCheckout) {
        infoParts.push(`<span class="font-semibold text-base-content" title="Выезд из ШРСК">← ${formatTime(estimatedCheckout)}</span>`);
    }
    if (flightTime) {
        infoParts.push(`<span title="Время вылета">✈ ${formatDateTime(flightTime)}</span>`);
    }
    if (departure?.needs_transfer === 'yes') {
        if (departure.taxi_status === 'ordered') {
            infoParts.push(`<span class="badge badge-success badge-sm gap-1 cursor-pointer" data-action="show-taxi-details" data-id="${departure.id}">🚕 ${t('ordered')}</span>`);
        } else {
            infoParts.push(`<span class="badge badge-warning badge-sm gap-1 cursor-pointer" data-action="open-taxi-modal" data-id="${departure.id}">🚕 ${t('needs_transfer')}</span>`);
        }
    }
    if (accommodation) {
        if (accommodation.isSelfAccommodation) {
            infoParts.push(`<span class="font-semibold text-error bg-error/20 px-2 py-1 rounded" title="Размещение">🏠 ${Layout.t('self_accommodation')}</span>`);
        } else {
            infoParts.push(`<span class="font-semibold bg-success/20 px-2 py-1 rounded" title="Размещение">🏠 ${accommodation.buildingName}, ${accommodation.roomNumber}</span>`);
        }
    }

    if (infoParts.length) {
        html += `<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm opacity-70">${infoParts.join('')}</div>`;
    }

    // Контакты
    const contactParts = [];
    if (hasWhatsapp) {
        contactParts.push(`<a href="https://wa.me/${phone.replace('+', '')}" target="_blank" class="btn btn-xs btn-ghost gap-1 text-green-600" title="WhatsApp">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.126.554 4.12 1.522 5.856L.057 23.988l6.272-1.418A11.935 11.935 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.75c-1.875 0-3.66-.507-5.228-1.467l-.375-.222-3.89.88.918-3.792-.244-.388A9.698 9.698 0 012.25 12 9.75 9.75 0 0112 2.25 9.75 9.75 0 0121.75 12 9.75 9.75 0 0112 21.75z"/></svg>
            WA</a>`);
    } else if (phone) {
        contactParts.push(`<a href="tel:${phone}" class="btn btn-xs btn-ghost gap-1" title="Позвонить">📞 ${v.phone}</a>`);
    }
    if (telegram) {
        const tgUsername = telegram.replace(/^@/, '');
        contactParts.push(`<a href="https://t.me/${tgUsername}" target="_blank" class="btn btn-xs btn-ghost gap-1 text-blue-500" title="Telegram">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
            TG</a>`);
    }

    if (contactParts.length) {
        html += `<div class="flex items-center gap-1 -ml-1">${contactParts.join('')}</div>`;
    }

    html += `</div>`;
    return html;
}

function renderTable() {
    const container = document.getElementById('tableContainer');
    const noData = document.getElementById('noData');

    if (!retreatId || registrations.length === 0) {
        container.innerHTML = '';
        noData.classList.remove('hidden');
        return;
    }

    noData.classList.add('hidden');
    const filtered = getFilteredRegistrations();

    if (filtered.length === 0) {
        container.innerHTML = `<div class="text-center py-8 opacity-50">${t('nothing_found')}</div>`;
        return;
    }

    // Группируем по дате estimated checkout
    const groups = new Map(); // dateStr → [regs]
    const noTimeGroup = [];

    filtered.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.direction === 'departure');
        if (departure?.flight_datetime) {
            const estimatedDate = new Date(departure.flight_datetime);
            estimatedDate.setHours(estimatedDate.getHours() - 7);
            const dateStr = toLocalDateStr(estimatedDate);

            if (!groups.has(dateStr)) groups.set(dateStr, []);
            groups.get(dateStr).push(reg);
        } else {
            noTimeGroup.push(reg);
        }
    });

    // Сортируем группы по дате
    const sortedDates = [...groups.keys()].sort();

    // Внутри каждой группы сортируем по estimated checkout
    for (const [dateStr, regs] of groups) {
        regs.sort((a, b) => {
            const aTransfer = (a.guest_transfers || []).find(t => t.direction === 'departure');
            const bTransfer = (b.guest_transfers || []).find(t => t.direction === 'departure');
            return (aTransfer?.flight_datetime || '').localeCompare(bTransfer?.flight_datetime || '');
        });
    }

    // Рендерим
    let html = '';

    for (const dateStr of sortedDates) {
        const regs = groups.get(dateStr);
        const label = getGroupLabel(dateStr);
        html += `
            <div class="mb-6">
                <h3 class="font-semibold text-sm mb-2 flex items-center gap-2">
                    ${label}
                    <span class="badge badge-sm badge-ghost">${regs.length}</span>
                </h3>
                <div class="bg-base-100 rounded-xl shadow overflow-x-auto">
                    <table class="table table-zebra">
                        <thead>
                            <tr>
                                <th>${t('name')}</th>
                                <th>${t('gender_age')}</th>
                                <th class="text-center">${t('departure_from_srsc')}</th>
                                <th class="text-center">${t('flight_departure')}</th>
                                <th>${t('accommodation')}</th>
                                <th>${t('contacts')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${regs.map(r => renderRow(r)).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    if (noTimeGroup.length > 0) {
        // Сортируем по имени
        noTimeGroup.sort((a, b) => {
            const aName = (a.vaishnavas?.spiritual_name || `${a.vaishnavas?.first_name || ''} ${a.vaishnavas?.last_name || ''}`.trim()).toLowerCase();
            const bName = (b.vaishnavas?.spiritual_name || `${b.vaishnavas?.first_name || ''} ${b.vaishnavas?.last_name || ''}`.trim()).toLowerCase();
            return aName.localeCompare(bName);
        });

        html += `
            <div class="mb-6">
                <h3 class="font-semibold text-sm mb-2 flex items-center gap-2 text-warning">
                    ${t('no_departure_time')}
                    <span class="badge badge-sm badge-warning">${noTimeGroup.length}</span>
                </h3>
                <div class="bg-base-100 rounded-xl shadow overflow-x-auto">
                    <table class="table table-zebra">
                        <thead>
                            <tr>
                                <th>${t('name')}</th>
                                <th>${t('gender_age')}</th>
                                <th class="text-center">${t('departure_from_srsc')}</th>
                                <th class="text-center">${t('flight_departure')}</th>
                                <th>${t('accommodation')}</th>
                                <th>${t('contacts')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${noTimeGroup.map(r => renderRow(r)).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    container.innerHTML = html;

    // Делегирование кликов в таблице выездов
    if (!container._delegated) {
        container._delegated = true;
        container.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            const id = btn.dataset.id;
            switch (btn.dataset.action) {
                case 'navigate-person': window.location.href = `../vaishnavas/person.html?id=${id}`; break;
                case 'show-taxi-details': ev.stopPropagation(); showTaxiDetails(id); break;
                case 'open-taxi-modal': ev.stopPropagation(); openTaxiModal(id); break;
            }
        });
    }
}

// ==================== ТАКСИ ====================
function openTaxiModal(transferId) {
    document.getElementById('taxiTransferId').value = transferId;
    document.getElementById('taxiDriverInfo').value = '';
    let taxiName = '';
    try { taxiName = localStorage.getItem('srsk_taxi_name') || ''; } catch {}
    document.getElementById('taxiOrderedBy').value = taxiName;
    document.getElementById('taxiModal').showModal();
}

async function saveTaxiOrder() {
    const transferId = document.getElementById('taxiTransferId').value;
    const driverInfo = document.getElementById('taxiDriverInfo').value.trim();
    const orderedBy = document.getElementById('taxiOrderedBy').value.trim();

    if (!orderedBy) {
        Layout.showNotification(t('specify_your_name'), 'warning');
        return;
    }

    localStorage.setItem('srsk_taxi_name', orderedBy);

    const { error } = await Layout.db
        .from('guest_transfers')
        .update({
            taxi_status: 'ordered',
            taxi_driver_info: driverInfo || null,
            taxi_ordered_by: orderedBy
        })
        .eq('id', transferId);

    if (error) {
        Layout.handleError(error, 'Сохранение заказа такси');
        return;
    }

    document.getElementById('taxiModal').close();

    // Обновляем локальные данные
    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.id === transferId);
        if (departure) {
            departure.taxi_status = 'ordered';
            departure.taxi_driver_info = driverInfo || null;
            departure.taxi_ordered_by = orderedBy;
        }
    });
    renderTable();
}

function showTaxiDetails(transferId) {
    let transfer = null;
    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.id === transferId);
        if (departure) transfer = departure;
    });
    if (!transfer) return;

    document.getElementById('taxiDetailsTransferId').value = transferId;
    document.getElementById('taxiDetailsDriver').value = transfer.taxi_driver_info || '';
    document.getElementById('taxiDetailsOrderedBy').value = transfer.taxi_ordered_by || '';
    document.getElementById('taxiDetailsModal').showModal();
}

async function saveEditedTaxiDetails() {
    const transferId = document.getElementById('taxiDetailsTransferId').value;
    const driverInfo = document.getElementById('taxiDetailsDriver').value.trim();
    const orderedBy = document.getElementById('taxiDetailsOrderedBy').value.trim();

    if (!orderedBy) {
        Layout.showNotification(t('specify_your_name'), 'warning');
        return;
    }

    const { error } = await Layout.db
        .from('guest_transfers')
        .update({
            taxi_driver_info: driverInfo || null,
            taxi_ordered_by: orderedBy
        })
        .eq('id', transferId);

    if (error) {
        Layout.handleError(error, 'Обновление информации о такси');
        return;
    }

    document.getElementById('taxiDetailsModal').close();

    // Обновляем локальные данные
    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.id === transferId);
        if (departure) {
            departure.taxi_driver_info = driverInfo || null;
            departure.taxi_ordered_by = orderedBy;
        }
    });
    renderTable();
}

async function cancelTaxiFromDetails() {
    const transferId = document.getElementById('taxiDetailsTransferId').value;
    document.getElementById('taxiDetailsModal').close();
    await cancelTaxi(transferId);
}

async function cancelTaxi(transferId) {
    const { error } = await Layout.db
        .from('guest_transfers')
        .update({
            taxi_status: null,
            taxi_driver_info: null,
            taxi_ordered_by: null
        })
        .eq('id', transferId);

    if (error) {
        Layout.handleError(error, 'Отмена такси');
        return;
    }

    // Обновляем локальные данные
    registrations.forEach(reg => {
        const departure = (reg.guest_transfers || []).find(t => t.id === transferId);
        if (departure) {
            departure.taxi_status = null;
            departure.taxi_driver_info = null;
            departure.taxi_ordered_by = null;
        }
    });
    renderTable();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'departures' });
    initStatsState();
    Layout.showLoader();
    await loadRetreats();
    Layout.hideLoader();

    // Realtime: автообновление при изменениях
    subscribeToRealtime();
}

// Realtime подписка
function subscribeToRealtime() {
    Layout.db.channel('departures-realtime')
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'guest_transfers' },
            handleRealtimeChange
        )
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'residents' },
            handleRealtimeChange
        )
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log('Realtime: подключено к выездам');
            }
        });
}

let realtimeTimeout = null;
function handleRealtimeChange(payload) {
    console.log('Realtime изменение:', payload.table, payload.eventType);
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadRegistrations();
        renderTable();
        Layout.showNotification('Данные обновлены', 'info');
    }, 500);
}

init();
