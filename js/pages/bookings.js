// ==================== STATE ====================
let bookings = [];
let allBookings = [];
let buildings = [];
let retreats = [];
let currentFilter = 'all';
// Живая бронь: из шахматки создаётся со статусом confirmed, отсюда — active. Раньше
// вкладки и календарь видели только active, и брони из шахматки (группа БЧС) пропадали (ВГ, 29.09)
const LIVE = ['active', 'confirmed'];

// Место «заехало» — отметка «заехал» в шахматке (как у кухни) или уже выехал
const заехал = r => !!r.arrived_at || r.status === 'checked_out';

// Статус брони по её местам в шахматке (ВГ, 29.09):
// upcoming — все места впереди; not_arrived — срок идёт, но кто-то без отметки «заехал»;
// living — живут сейчас, все отмечены; left — все места закончились;
// cancelled — снята; empty — в шахматке мест нет (требует внимания)
function состояниеБрони(booking, места) {
    if (booking.status === 'cancelled') return 'cancelled';
    if (!места.length) return 'empty';
    const конец = r => r.check_out || r.check_in;
    if (места.every(r => конец(r) < today)) return 'left';
    const сейчас = места.filter(r => r.check_in <= today && конец(r) >= today);
    if (!сейчас.length) return 'upcoming';
    return сейчас.some(r => !заехал(r)) ? 'not_arrived' : 'living';
}
let currentView = 'list';
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedBookingId = null;

// CRM mode: crm_deal_id из URL
let crmDealId = null;

const t = key => Layout.t(key);
// перевод с запасным текстом — новые ключи, пока у людей старый кэш переводов
const tr = (key, fb) => { const v = Layout.t(key); return v && v !== key ? v : fb; };
const e = str => Layout.escapeHtml(str);
const today = DateUtils.toISO(new Date());

// ==================== DATA ====================
async function loadInitialData() {
    // Load buildings — только названия, отдельным ключом: под 'buildings' шахматка
    // держит полные здания (временные, порядок, даты аренды) и путала порядок
    buildings = await Cache.getOrLoad('buildings_names', async () => {
        const { data, error } = await Layout.db
            .from('buildings')
            .select('id, name_ru, name_en, name_hi')
            .eq('is_active', true)
            .order('sort_order');
        if (error) { console.error('Error loading buildings:', error); return null; }
        return data;
    }) || [];

    // Load retreats (кэш 30 мин)
    retreats = await Cache.getOrLoad('retreats', async () => {
        const { data, error } = await Layout.db
            .from('retreats')
            .select('*')
            .order('start_date', { ascending: false });
        if (error) { console.error('Error loading retreats:', error); return null; }
        return data;
    }, 1800000) || [];
}

async function loadBookings() {
    let query = Layout.db
        .from('bookings')
        .select('*, retreats(id, name_ru, name_en, name_hi, start_date, end_date, is_external)')
        .order('check_in', { ascending: true });

    // Схема «шахматка главная» (ВГ, 29.09): даты и места брони база держит по шахматке (584),
    // статус считается здесь по местам. «Прошедшие» — выехавшие и снятые, остальные вкладки —
    // живые брони, разложенные по статусу
    if (currentFilter === 'past') {
        query = query.or(`check_out.lt.${today},status.eq.cancelled`);
    } else {
        query = query.in('status', LIVE).gte('check_out', today);
    }

    const { data, error } = await query;

    if (error) {
        console.error('Error loading bookings:', error);
        return;
    }

    bookings = data || [];

    // Места всех броней одним запросом
    if (bookings.length > 0) {
        const bookingIds = bookings.map(b => b.id);
        const { data: allResidents } = await Layout.db
            .from('residents')
            .select('id, booking_id, vaishnava_id, guest_name, check_in, check_out, status, arrived_at')
            .in('booking_id', bookingIds)
            .neq('status', 'cancelled');

        const residentsByBooking = {};
        (allResidents || []).forEach(r => {
            (residentsByBooking[r.booking_id] = residentsByBooking[r.booking_id] || []).push(r);
        });

        for (const booking of bookings) {
            const места = residentsByBooking[booking.id] || [];
            booking.beds_placed = места.length;   // сколько мест брони стоит в шахматке
            booking.beds_arrived = места.filter(заехал).length;
            booking.state = состояниеБрони(booking, места);
        }
    }

    // Сколько броней требуют внимания — на вкладке, чтобы было видно сразу
    if (currentFilter !== 'past') {
        const n = bookings.filter(b => b.state === 'empty').length;
        const tab = Layout.$('#filtersBlock [data-filter="attention"] .tab-count');
        if (tab) tab.textContent = n ? ` (${n})` : '';
    }

    const нужное = { checked_in: 'living', not_checked_in: 'not_arrived', upcoming: 'upcoming', attention: 'empty' }[currentFilter];
    if (нужное) bookings = bookings.filter(b => b.state === нужное);

    renderBookings();
}

async function loadAllBookings() {
    const { data, error } = await Layout.db
        .from('bookings')
        .select('id, name, contact_name, check_in, check_out, beds_count, status')
        .in('status', LIVE)
        .order('check_in');

    if (error) {
        console.error('Error loading all bookings:', error);
        return;
    }

    allBookings = data || [];
}

async function loadBookingDetails(bookingId) {
    const { data } = await Layout.db.rpc('get_booking_details', { booking_uuid: bookingId });
    return data?.[0] || null;
}

// ==================== VIEW ====================
function setView(view) {
    currentView = view;

    Layout.$('#viewListBtn').classList.toggle('tab-active', view === 'list');
    Layout.$('#viewCalendarBtn').classList.toggle('tab-active', view === 'calendar');

    Layout.$('#listView').classList.toggle('hidden', view !== 'list');
    Layout.$('#calendarView').classList.toggle('hidden', view !== 'calendar');
    Layout.$('#filtersBlock').classList.toggle('hidden', view !== 'list');

    if (view === 'calendar') {
        renderCalendarView();
    }
}

function setFilter(filter) {
    currentFilter = filter;

    Layout.$$('#filtersBlock .tab').forEach(tab => {
        tab.classList.toggle('tab-active', tab.dataset.filter === filter);
    });

    loadBookings();
}

// ==================== RENDER ====================
function renderBookings() {
    const list = Layout.$('#bookingsList');
    const emptyState = Layout.$('#emptyState');

    if (bookings.length === 0) {
        list.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }

    list.classList.remove('hidden');
    emptyState.classList.add('hidden');

    // Порядок (ВГ, 29.09): ближайшие сверху, дальше по датам; в «Прошедших» — свежие сверху.
    // Брони одного события — одним блоком, блок стоит по дате своей первой брони;
    // при одной дате — по алфавиту
    const назад = currentFilter === 'past';
    const имя = b => (b.name || b.contact_name || '').toLowerCase();
    const поДате = (a, b) => (назад ? b.check_in.localeCompare(a.check_in) : a.check_in.localeCompare(b.check_in))
        || имя(a).localeCompare(имя(b), 'ru');
    const блоки = [];
    const поСобытию = new Map();
    for (const b of [...bookings].sort(поДате)) {
        if (!b.retreats) { блоки.push({ одна: b, check_in: b.check_in, name: имя(b) }); continue; }
        let g = поСобытию.get(b.retreats.id);
        if (!g) { g = { событие: b.retreats, брони: [], check_in: b.check_in, name: Layout.getName(b.retreats).toLowerCase() }; поСобытию.set(b.retreats.id, g); блоки.push(g); }
        g.брони.push(b);
    }
    блоки.sort(поДате);
    list.innerHTML = блоки.map(g => g.одна ? bookingCard(g.одна) : eventBlock(g)).join('');

    // Делегирование кликов в списке бронирований
    if (!list._delegated) {
        list._delegated = true;
        list.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="open-booking-modal"]');
            if (el) openBookingModal(el.dataset.id);
        });
    }
}

// Карточка одной брони
function bookingCard(booking) {
    const checkIn = DateUtils.parseDate(booking.check_in);
    const checkOut = DateUtils.parseDate(booking.check_out);
    const isCancelled = booking.state === 'cancelled' || booking.status === 'cancelled';

    const totalBeds = booking.beds_placed ?? booking.beds_count;
    const arrived = booking.beds_arrived || 0;
    const progressPercent = totalBeds > 0 ? Math.round((arrived / totalBeds) * 100) : 0;

    // Display name or contact_name
    const displayName = booking.name || booking.contact_name;

    const ЗНАЧКИ = {
        cancelled: ['badge-error', t('booking_status_cancelled')],
        empty: ['badge-warning', tr('booking_no_places', 'Нет в шахматке'), tr('booking_no_places_hint', 'У брони нет ни одного места в шахматке: кухня её не считает. Поставьте места в шахматку или отмените бронь')],
        left: ['badge-ghost', tr('booking_state_left', 'Выехали')],
        not_arrived: ['badge-warning', t('bookings_filter_not_checked_in')],
        living: ['badge-success', t('booking_status_checked_in')],
        upcoming: ['badge-info', t('bookings_filter_upcoming')]
    };
    const [цвет, текст, подсказка] = ЗНАЧКИ[booking.state] || [];
    const statusBadge = текст ? `<span class="badge ${цвет} badge-sm" ${подсказка ? `title="${e(подсказка)}"` : ''}>${e(текст)}</span>` : '';

    return `
        <div class="bg-base-100 rounded-lg shadow-sm overflow-hidden ${isCancelled ? 'opacity-50' : ''}" data-action="open-booking-modal" data-id="${booking.id}">
            <div class="p-4 cursor-pointer hover:bg-base-200/50 transition-colors">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div class="flex-1">
                        <div class="flex items-center gap-2 mb-1">
                            <h3 class="font-semibold text-lg">${displayName}</h3>
                            ${statusBadge}
                        </div>
                        <div class="text-sm opacity-60">
                            ${checkIn.toLocaleDateString()} — ${checkOut.toLocaleDateString()}
                            ${booking.retreats ? ` · ${Layout.getName(booking.retreats)}` : ''}
                        </div>
                    </div>

                    <div class="flex items-center gap-4">
                        <div class="text-center">
                            <div class="text-2xl font-bold">${totalBeds}</div>
                            <div class="text-xs opacity-60">${t('booking_beds')}</div>
                        </div>

                        <div class="w-24">
                            <div class="flex justify-between text-xs mb-1">
                                <span>${e(tr('booking_arrived', 'Заехали'))}</span>
                                <span>${arrived}/${totalBeds}</span>
                            </div>
                            <progress class="progress ${progressPercent === 100 ? 'progress-success' : progressPercent > 0 ? 'progress-warning' : ''} w-full" value="${progressPercent}" max="100"></progress>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Блок события: название, наш/сторонний, даты, сколько броней и мест; внутри — брони по датам
function eventBlock(g) {
    const ev = g.событие;
    const мест = g.брони.reduce((a, b) => a + (Number(b.beds_count) || 0), 0);
    const тип = ev.is_external
        ? `<span class="badge badge-outline badge-sm">${e(tr('retreats_is_external', 'Стороннее мероприятие'))}</span>`
        : `<span class="badge badge-ghost badge-sm">${e(tr('group_event_retreat', 'Наш ретрит'))}</span>`;
    const даты = ev.start_date ? `${DateUtils.parseDate(ev.start_date).toLocaleDateString()} — ${DateUtils.parseDate(ev.end_date).toLocaleDateString()}` : '';
    return `<details class="bg-base-200/60 rounded-xl" open>
        <summary class="cursor-pointer px-4 py-3 flex flex-wrap items-center gap-2">
            <span class="font-semibold text-lg">${e(Layout.getName(ev))}</span> ${тип}
            <span class="text-sm opacity-60">${даты} · броней ${g.брони.length} · мест ${мест}</span>
        </summary>
        <div class="space-y-2 px-2 pb-2">${g.брони.map(bookingCard).join('')}</div>
    </details>`;
}

function renderCalendarView() {
    const title = new Date(calendarYear, calendarMonth).toLocaleDateString(
        Layout.currentLang === 'en' ? 'en-US' : 'ru-RU',
        { month: 'long', year: 'numeric' }
    );
    Layout.$('#calendarTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);

    const grid = Layout.$('#calendarGrid');
    const firstDay = new Date(calendarYear, calendarMonth, 1);

    let startDay = new Date(firstDay);
    const dayOfWeek = startDay.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startDay.setDate(startDay.getDate() - diff);

    const days = [];
    const current = new Date(startDay);
    for (let i = 0; i < 42; i++) {
        days.push(new Date(current));
        current.setDate(current.getDate() + 1);
    }

    grid.innerHTML = days.map(day => {
        const dateStr = DateUtils.toISO(day);
        const isOtherMonth = day.getMonth() !== calendarMonth;
        const isToday = dateStr === today;

        const dayBookings = allBookings.filter(b =>
            b.check_in <= dateStr && b.check_out >= dateStr
        );
        const bookingCount = dayBookings.length;

        return `
            <div class="calendar-day border border-base-200 rounded p-2 ${isOtherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''} ${bookingCount > 0 ? 'cursor-pointer hover:bg-base-200' : ''}"
                 ${bookingCount > 0 ? `data-action="open-day-modal" data-date="${dateStr}"` : ''}>
                <div class="text-sm font-medium ${isToday ? 'text-primary' : ''}">${day.getDate()}</div>
                ${bookingCount > 0 ? `
                    <div class="booking-count text-warning">${bookingCount}</div>
                ` : ''}
            </div>
        `;
    }).join('');

    // Делегирование кликов в календаре
    if (!grid._delegated) {
        grid._delegated = true;
        grid.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="open-day-modal"]');
            if (el) openDayModal(el.dataset.date);
        });
    }
}

// ==================== CALENDAR NAVIGATION ====================
function prevMonth() {
    calendarMonth--;
    if (calendarMonth < 0) {
        calendarMonth = 11;
        calendarYear--;
    }
    renderCalendarView();
}

function nextMonth() {
    calendarMonth++;
    if (calendarMonth > 11) {
        calendarMonth = 0;
        calendarYear++;
    }
    renderCalendarView();
}

// ==================== DAY MODAL ====================
function openDayModal(dateStr) {
    const dayBookings = allBookings.filter(b =>
        b.check_in <= dateStr && b.check_out >= dateStr
    );

    if (dayBookings.length === 0) return;

    const date = DateUtils.parseDate(dateStr);
    Layout.$('#dayModalTitle').textContent = `${t('bookings_title')} — ${date.toLocaleDateString()}`;

    const dayModalContentEl = Layout.$('#dayModalContent');
    dayModalContentEl.innerHTML = dayBookings.map(b => `
        <div class="flex items-center justify-between p-3 bg-warning/10 border border-warning/30 rounded-lg cursor-pointer hover:bg-warning/20 transition-colors"
             data-action="open-booking-from-day" data-id="${b.id}">
            <div>
                <div class="font-medium">${e(b.name || b.contact_name)}</div>
                <div class="text-sm opacity-60">
                    ${DateUtils.parseDate(b.check_in).toLocaleDateString()} — ${DateUtils.parseDate(b.check_out).toLocaleDateString()}
                </div>
            </div>
            <div class="text-right">
                <div class="text-lg font-bold">${b.beds_count}</div>
                <div class="text-xs opacity-60">${t('booking_beds')}</div>
            </div>
        </div>
    `).join('');

    // Делегирование кликов в модалке дня
    if (!dayModalContentEl._delegated) {
        dayModalContentEl._delegated = true;
        dayModalContentEl.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="open-booking-from-day"]');
            if (el) { closeDayModal(); openBookingModal(el.dataset.id); }
        });
    }

    Layout.$('#dayModal').showModal();
}

function closeDayModal() {
    Layout.$('#dayModal').close();
}

// Архив ретритов в списке окна брони (js/retreat-select.js)
RetreatSelect.setSource(() => retreats, { noneLabel: () => '—' });

// Окно «Регистрация группы» (js/group-booking.js) — то же, что в шахматке; с id брони — правка её номеров
function openGroupBooking(bookingId = null) {
    if (bookingId) closeBookingModal();
    GroupBooking.open({ bookingId, onSaved: async () => { await loadBookings(); await loadAllBookings(); } });
}

// «Человек или семья» — то же окно, один номер, люди поимённо (часть 4, ВГ 08.10)
function openPersonBooking() {
    GroupBooking.open({ mode: 'person', onSaved: async () => { await loadBookings(); await loadAllBookings(); } });
}

// ==================== BOOKING DETAILS MODAL ====================
async function openBookingModal(bookingId) {
    selectedBookingId = bookingId;
    const details = await loadBookingDetails(bookingId);
    if (!details) return;

    const content = Layout.$('#bookingModalContent');
    const rooms = details.rooms || [];

    const filledRooms = rooms.filter(r => r.is_filled);
    const pendingRooms = rooms.filter(r => !r.is_filled);

    content.innerHTML = `
        ${details.name ? `
            <div class="text-xl font-bold mb-2">${details.name}</div>
        ` : ''}
        <!-- Contact Info -->
        <div class="bg-base-200 rounded-lg p-4">
            <h4 class="font-medium mb-2">${t('booking_contact')}</h4>
            <div class="grid grid-cols-2 gap-2 text-sm">
                <div class="opacity-60">${t('booking_contact_name')}</div>
                <div class="font-medium">${e(details.contact_name)}</div>
                ${details.contact_phone ? `
                    <div class="opacity-60">${t('booking_contact_phone')}</div>
                    <div>${e(details.contact_phone)}</div>
                ` : ''}
                ${details.contact_email ? `
                    <div class="opacity-60">${t('booking_contact_email')}</div>
                    <div>${e(details.contact_email)}</div>
                ` : ''}
                ${details.contact_country ? `
                    <div class="opacity-60">${t('booking_contact_country')}</div>
                    <div>${e(details.contact_country)}</div>
                ` : ''}
            </div>
        </div>

        <!-- Booking Info -->
        <div class="grid grid-cols-2 gap-4">
            <div class="bg-base-200 rounded-lg p-4">
                <div class="text-sm opacity-60 mb-1">${t('check_in')}</div>
                <div class="font-medium">${DateUtils.parseDate(details.check_in).toLocaleDateString()}</div>
            </div>
            <div class="bg-base-200 rounded-lg p-4">
                <div class="text-sm opacity-60 mb-1">${t('check_out')}</div>
                <div class="font-medium">${DateUtils.parseDate(details.check_out).toLocaleDateString()}</div>
            </div>
        </div>

        <!-- Progress -->
        <div class="bg-base-200 rounded-lg p-4">
            <div class="flex justify-between items-center mb-2">
                <span class="font-medium">${t('booking_progress')}</span>
                <span class="text-sm">${details.beds_filled} / ${details.beds_count} ${t('booking_filled')}</span>
            </div>
            <progress class="progress ${details.beds_filled === details.beds_count ? 'progress-success' : 'progress-warning'} w-full" value="${details.beds_filled}" max="${details.beds_count}"></progress>
        </div>

        ${details.retreat_name_ru ? `
            <div class="flex items-center gap-2">
                <span class="badge badge-primary">${Layout.currentLang === 'ru' ? details.retreat_name_ru : details.retreat_name_en || details.retreat_name_ru}</span>
            </div>
        ` : ''}

        ${details.notes ? `
            <div class="text-sm opacity-70 italic">${e(details.notes)}</div>
        ` : ''}

        <!-- Rooms -->
        ${rooms.length > 0 ? `
            <div>
                <h4 class="font-medium mb-2">${t('booking_view_rooms')}</h4>
                <div class="space-y-2">
                    ${filledRooms.map(r => `
                        <div class="flex items-center justify-between p-2 bg-success/10 rounded border border-success/30">
                            <div>
                                <span class="font-medium">${Layout.currentLang === 'ru' ? r.building_name_ru : r.building_name_en || r.building_name_ru} / ${r.room_number}</span>
                            </div>
                            <div class="text-sm">${e(r.guest_name || r.team_member_name || '')}</div>
                        </div>
                    `).join('')}
                    ${pendingRooms.map(r => `
                        <a href="occupancy.html?room=${r.room_id}" class="flex items-center justify-between p-2 bg-warning/10 rounded border border-warning/30 hover:bg-warning/20 transition-colors">
                            <div>
                                <span class="font-medium">${Layout.currentLang === 'ru' ? r.building_name_ru : r.building_name_en || r.building_name_ru} / ${r.room_number}</span>
                            </div>
                            <div class="badge badge-warning badge-sm">${t('booking_placeholder')}</div>
                        </a>
                    `).join('')}
                </div>
            </div>
        ` : ''}
    `;

    const cancelBtn = Layout.$('#bookingModal .btn-error');
    if (cancelBtn) {
        cancelBtn.classList.toggle('hidden', details.status === 'cancelled');
    }

    Layout.$('#bookingModal').showModal();
}

function closeBookingModal() {
    Layout.$('#bookingModal').close();
    selectedBookingId = null;
}

async function cancelBooking() {
    if (!selectedBookingId) return;
    if (!confirm(t('bookings_confirm_cancel'))) return;

    try {
        const { error: bookingError } = await Layout.db
            .from('bookings')
            .update({ status: 'cancelled' })
            .eq('id', selectedBookingId);

        if (bookingError) throw bookingError;

        const { error: residentsError } = await Layout.db
            .from('residents')
            .update({ status: 'cancelled' })
            .eq('booking_id', selectedBookingId);

        if (residentsError) throw residentsError;

        closeBookingModal();
        await loadBookings();
        await loadAllBookings();

    } catch (err) {
        console.error('Error cancelling booking:', err);
        Layout.showNotification(t('cancel_error') + ': ' + err.message, 'error');
    }
}

async function deleteBookingPermanently() {
    if (!selectedBookingId) return;
    if (!confirm(t('bookings_confirm_delete'))) return;

    try {
        // Сначала удаляем связанных резидентов
        const { error: residentsError } = await Layout.db
            .from('residents')
            .delete()
            .eq('booking_id', selectedBookingId);

        if (residentsError) throw residentsError;

        // Затем удаляем саму бронь
        const { error: bookingError } = await Layout.db
            .from('bookings')
            .delete()
            .eq('id', selectedBookingId);

        if (bookingError) throw bookingError;

        closeBookingModal();
        await loadBookings();
        await loadAllBookings();

    } catch (err) {
        console.error('Error deleting booking:', err);
        Layout.showNotification(t('bookings_delete_error') + ': ' + err.message, 'error');
    }
}

// ==================== INIT ====================
function updateUI() {
    Layout.updateAllTranslations();
}

window.onLanguageChange = () => {
    updateUI();
    renderBookings();
    if (currentView === 'calendar') {
        renderCalendarView();
    }
};

async function init() {
    await Layout.init({ module: 'housing', menuId: 'reception', itemId: 'bookings' });
    Layout.showLoader();
    updateUI();
    await loadInitialData();

    // Проверяем CRM-режим (переход с карточки сделки)
    const urlParams = new URLSearchParams(window.location.search);
    crmDealId = urlParams.get('crm_deal_id') || null;

    if (crmDealId) {
        // Показываем кнопку «Вернуться к сделке» только если НЕ в iframe
        if (window.parent === window) {
            const backBar = document.getElementById('crmBackBar');
            const backLink = document.getElementById('crmBackLink');
            if (backBar) backBar.classList.remove('hidden');
            if (backLink) backLink.href = `../crm/deal.html?id=${crmDealId}`;
        }
        // «Забронировать номер» из сделки (часть 4, ВГ 08.10): окно «Человек или семья» —
        // гость сделки и его спутники поимённо, один номер; здания — по типу проживания в чек-листе
        const q = n => urlParams.get(n) || '';
        const members = q('member_names').split(', ').filter(Boolean).map(name => ({ name }));
        await GroupBooking.open({
            mode: 'person',
            crmDealId,
            checkIn: q('check_in'),
            checkOut: q('check_out'),
            retreatId: q('retreat_id'),
            people: [{ vid: q('vaishnava_id'), name: q('contact_name') }, ...members],
            contact: { name: q('contact_name'), phone: q('contact_phone'), email: q('contact_email') },
            buildingIds: q('building_ids').split(',').filter(Boolean),
            onSaved: ({ bookingId, roomId }) => {
                // В окне сделки (iframe) — сообщаем родителю, отдельной страницей — назад к сделке
                if (window.parent !== window) {
                    window.parent.postMessage({ type: 'crm_booking_saved', booking_id: bookingId, room_id: roomId }, '*');
                } else {
                    window.location.href = `../crm/deal.html?id=${crmDealId}`;
                }
            }
        });
        Layout.hideLoader();
        return;
    }

    await loadBookings();
    await loadAllBookings();
    Layout.hideLoader();
}

init();
