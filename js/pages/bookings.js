// ==================== STATE ====================
let bookings = [];
let allBookings = [];
let buildings = [];
let rooms = [];
let floorPlans = [];
let retreats = [];
let currentFilter = 'all';
let currentView = 'list';
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();
let selectedBookingId = null;

// New booking state
let bookingStep = 1;
let bookingSelectedBeds = new Set();
let bookingBuildingId = null;

const statusColors = {
    available: '#10b981',
    occupied: '#8b5cf6',
    booked: '#eab308',
    cleaning: '#ef4444',
    maintenance: '#6b7280',
    selected: '#6366f1'
};

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
const today = DateUtils.toISO(new Date());

// ==================== DATA ====================
async function loadInitialData() {
    // Load buildings
    buildings = await Cache.getOrLoad('buildings', async () => {
        const { data, error } = await Layout.db
            .from('buildings')
            .select('id, name_ru, name_en, name_hi')
            .eq('is_active', true)
            .order('sort_order');
        if (error) { console.error('Error loading buildings:', error); return null; }
        return data;
    }) || [];

    // Load rooms (кэш 1 час)
    rooms = await Cache.getOrLoad('rooms', async () => {
        const { data, error } = await Layout.db
            .from('rooms')
            .select('id, number, floor, building_id, capacity, plan_x, plan_y, plan_width, plan_height')
            .eq('is_active', true);
        if (error) { console.error('Error loading rooms:', error); return null; }
        return data;
    }, 3600000) || [];

    // Load floor plans
    const { data: plansData } = await Layout.db
        .from('floor_plans')
        .select('*')
        .order('floor');
    floorPlans = plansData || [];

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
        .select('*, retreats(id, name_ru, name_en)')
        .order('check_in', { ascending: true });

    // Filter by status
    if (currentFilter === 'not_checked_in') {
        // Load bookings where dates are active (will filter by beds_pending later)
        query = query.eq('status', 'active').lte('check_in', today).gte('check_out', today);
    } else if (currentFilter === 'upcoming') {
        query = query.eq('status', 'active').gt('check_in', today);
    }

    const { data, error } = await query;

    if (error) {
        console.error('Error loading bookings:', error);
        return;
    }

    bookings = data || [];

    // Load all residents for these bookings in ONE query (instead of N+1)
    if (bookings.length > 0) {
        const bookingIds = bookings.map(b => b.id);
        const { data: allResidents } = await Layout.db
            .from('residents')
            .select('id, booking_id, vaishnava_id, guest_name')
            .in('booking_id', bookingIds)
            .eq('status', 'confirmed');

        // Group residents by booking_id
        const residentsByBooking = {};
        (allResidents || []).forEach(r => {
            if (!residentsByBooking[r.booking_id]) {
                residentsByBooking[r.booking_id] = [];
            }
            residentsByBooking[r.booking_id].push(r);
        });

        // Calculate stats for each booking
        for (const booking of bookings) {
            const stats = residentsByBooking[booking.id] || [];
            const filled = stats.filter(r => r.vaishnava_id || r.guest_name).length;
            const pending = stats.length - filled;
            booking.beds_filled = filled;
            booking.beds_pending = pending;
        }
    }

    // For "not_checked_in" filter, only show bookings with unfilled beds
    if (currentFilter === 'not_checked_in') {
        bookings = bookings.filter(b => b.beds_pending > 0);
    }

    renderBookings();
}

async function loadAllBookings() {
    const { data, error } = await Layout.db
        .from('bookings')
        .select('id, name, contact_name, check_in, check_out, beds_count, status')
        .eq('status', 'active')
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

    list.innerHTML = bookings.map(booking => {
        const checkIn = DateUtils.parseDate(booking.check_in);
        const checkOut = DateUtils.parseDate(booking.check_out);
        const isActive = booking.status === 'active' && booking.check_in <= today && booking.check_out >= today;
        const isUpcoming = booking.status === 'active' && booking.check_in > today;
        const isCancelled = booking.status === 'cancelled';

        const totalBeds = booking.beds_count;
        const filledBeds = booking.beds_filled || 0;
        const progressPercent = totalBeds > 0 ? Math.round((filledBeds / totalBeds) * 100) : 0;

        // Display name or contact_name
        const displayName = booking.name || booking.contact_name;

        let statusBadge = '';
        if (isCancelled) {
            statusBadge = `<span class="badge badge-error badge-sm">${t('booking_status_cancelled')}</span>`;
        } else if (isActive && booking.beds_pending > 0) {
            statusBadge = `<span class="badge badge-warning badge-sm">${t('bookings_filter_not_checked_in')}</span>`;
        } else if (isActive && booking.beds_pending === 0) {
            statusBadge = `<span class="badge badge-success badge-sm">${t('booking_status_checked_in')}</span>`;
        } else if (isUpcoming) {
            statusBadge = `<span class="badge badge-info badge-sm">${t('bookings_filter_upcoming')}</span>`;
        }

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
                                    <span>${t('booking_progress')}</span>
                                    <span>${filledBeds}/${totalBeds}</span>
                                </div>
                                <progress class="progress ${progressPercent === 100 ? 'progress-success' : progressPercent > 0 ? 'progress-warning' : ''} w-full" value="${progressPercent}" max="100"></progress>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    // Делегирование кликов в списке бронирований
    if (!list._delegated) {
        list._delegated = true;
        list.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="open-booking-modal"]');
            if (el) openBookingModal(el.dataset.id);
        });
    }
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

// ==================== NEW BOOKING MODAL ====================
function openNewBookingModal() {
    bookingStep = 1;
    bookingSelectedBeds.clear();

    const form = Layout.$('#newBookingForm');
    form.reset();
    form.check_in.value = today;
    form.check_out.value = '';

    // Populate retreat select
    const retreatSelect = Layout.$('#newBookingRetreatSelect');
    retreatSelect.innerHTML = `<option value="">—</option>` +
        retreats.map(r => `<option value="${r.id}">${Layout.getName(r)}</option>`).join('');

    // Populate building select for step 2
    const buildingSelect = Layout.$('#newBookingBuildingSelect');
    buildingSelect.innerHTML = buildings.map(b =>
        `<option value="${b.id}">${Layout.getName(b)}</option>`
    ).join('');
    bookingBuildingId = buildings[0]?.id;

    // Populate building scope select for step 1
    // Считаем ёмкость каждого здания
    const buildingCapacity = {};
    let totalCapacity = 0;
    rooms.forEach(r => {
        if (!buildingCapacity[r.building_id]) buildingCapacity[r.building_id] = 0;
        buildingCapacity[r.building_id] += r.capacity || 0;
        totalCapacity += r.capacity || 0;
    });

    const guesthouse = buildings.find(b => b.name_ru === 'Гостевой дом' || b.name_en === 'Guest House');
    const buildingScopeSelect = Layout.$('#newBookingBuildingScope');
    buildingScopeSelect.innerHTML =
        (guesthouse ? `<option value="${guesthouse.id}">${Layout.getName(guesthouse)} (${buildingCapacity[guesthouse.id] || 0})</option>` : '') +
        `<option value="all">${t('booking_all_buildings')} (${totalCapacity})</option>` +
        buildings.filter(b => b.id !== guesthouse?.id).map(b =>
            `<option value="${b.id}">${Layout.getName(b)} (${buildingCapacity[b.id] || 0})</option>`
        ).join('');

    updateBookingStepIndicators();
    Layout.$('#bookingStep1').classList.remove('hidden');
    Layout.$('#bookingStep2').classList.add('hidden');

    Layout.$('#newBookingModal').showModal();
}

function closeNewBookingModal() {
    Layout.$('#newBookingModal').close();
    bookingSelectedBeds.clear();
}

function updateBookingStepIndicators() {
    const step1 = Layout.$('#bookingStep1Indicator');
    const step2 = Layout.$('#bookingStep2Indicator');

    if (bookingStep === 1) {
        step1.classList.remove('opacity-40');
        step1.querySelector('span:first-child').classList.add('bg-primary', 'text-primary-content');
        step1.querySelector('span:first-child').classList.remove('bg-base-300');
        step2.classList.add('opacity-40');
        step2.querySelector('span:first-child').classList.remove('bg-primary', 'text-primary-content');
        step2.querySelector('span:first-child').classList.add('bg-base-300');
    } else {
        step1.classList.add('opacity-40');
        step1.querySelector('span:first-child').classList.remove('bg-primary', 'text-primary-content');
        step1.querySelector('span:first-child').classList.add('bg-base-300');
        step2.classList.remove('opacity-40');
        step2.querySelector('span:first-child').classList.add('bg-primary', 'text-primary-content');
        step2.querySelector('span:first-child').classList.remove('bg-base-300');
    }
}

async function goToBookingStep2() {
    const form = Layout.$('#newBookingForm');
    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    const bedsCount = parseInt(form.beds_count.value) || 1;
    const checkIn = form.check_in.value;
    const checkOut = form.check_out.value;
    const buildingScope = form.building_scope.value;

    // Определяем building_ids для проверки
    const buildingIds = buildingScope === 'all' ? null : [buildingScope];

    // Проверяем доступность на весь период
    const { data: problemDates, error } = await Layout.db.rpc('check_booking_availability', {
        p_check_in: checkIn,
        p_check_out: checkOut,
        p_beds_needed: bedsCount,
        p_building_ids: buildingIds
    });

    if (error) {
        console.error('Error checking availability:', error);
    } else if (problemDates && problemDates.length > 0) {
        const buildingName = buildingScope === 'all'
            ? t('booking_all_buildings')
            : Layout.getName(buildings.find(b => b.id === buildingScope)) || '';

        showAvailabilityError(problemDates, buildingName, bedsCount);
        return;
    }

    bookingStep = 2;
    updateBookingStepIndicators();
    Layout.$('#bookingStep1').classList.add('hidden');
    Layout.$('#bookingStep2').classList.remove('hidden');

    // Устанавливаем выбранное здание для отображения плана (или первое, если "все")
    const buildingSelect = Layout.$('#newBookingBuildingSelect');
    if (buildingScope !== 'all') {
        buildingSelect.value = buildingScope;
        bookingBuildingId = buildingScope;
    }

    Layout.$('#bookingTotalCount').textContent = bedsCount;
    Layout.$('#bookingSelectedCount').textContent = bookingSelectedBeds.size;

    renderBookingPlan();
}

function goToBookingStep1() {
    bookingStep = 1;
    updateBookingStepIndicators();
    Layout.$('#bookingStep1').classList.remove('hidden');
    Layout.$('#bookingStep2').classList.add('hidden');
}

function showAvailabilityError(problemDates, buildingName, bedsNeeded) {
    const dateFormatter = new Intl.DateTimeFormat(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU', {
        day: 'numeric',
        month: 'long',
        weekday: 'short'
    });

    Layout.$('#availabilityErrorBuilding').textContent = buildingName;
    Layout.$('#availabilityErrorRequired').textContent = bedsNeeded;

    const datesContainer = Layout.$('#availabilityErrorDates');
    datesContainer.innerHTML = problemDates.map(d => {
        const date = DateUtils.parseDate(d.problem_date);
        const percent = Math.round((d.available_beds / d.total_capacity) * 100);
        const colorClass = percent < 30 ? 'bg-error' : percent < 70 ? 'bg-warning' : 'bg-success';

        return `
            <div class="flex items-center justify-between py-2 border-b border-base-300 last:border-0">
                <span class="font-medium">${dateFormatter.format(date)}</span>
                <div class="flex items-center gap-3">
                    <div class="w-24 bg-base-300 rounded-full h-2">
                        <div class="${colorClass} h-2 rounded-full" style="width: ${100 - percent}%"></div>
                    </div>
                    <span class="text-sm opacity-70 w-20 text-right">
                        ${t('booking_available')} <strong>${d.available_beds}</strong>
                    </span>
                </div>
            </div>
        `;
    }).join('');

    Layout.$('#availabilityErrorModal').showModal();
}

function closeAvailabilityErrorModal() {
    Layout.$('#availabilityErrorModal').close();
}

async function renderBookingPlan() {
    const container = Layout.$('#bookingPlanContainer');
    const buildingSelect = Layout.$('#newBookingBuildingSelect');
    bookingBuildingId = buildingSelect.value;

    const form = Layout.$('#newBookingForm');
    const checkIn = form.check_in.value;

    // Load occupancy for the booking dates
    const { data: bookingOccupancy } = await Layout.db.rpc('get_room_occupancy_with_bookings', { target_date: checkIn });

    // Get floor plans for selected building
    const buildingPlans = floorPlans.filter(p => p.building_id === bookingBuildingId).sort((a, b) => a.floor - b.floor);
    const buildingRooms = rooms.filter(r => r.building_id === bookingBuildingId);

    if (buildingPlans.length === 0) {
        container.innerHTML = `<div class="col-span-2 text-center py-8 opacity-50">${t('floor_plan_no_plan')}</div>`;
        return;
    }

    container.innerHTML = buildingPlans.map(plan => `
        <div class="bg-base-200 rounded-lg p-2">
            <div class="text-xs font-medium mb-1 opacity-60">${t('floor_plan_floor')} ${plan.floor}</div>
            <div class="floor-plan-container relative">
                <img src="${plan.image_url}" alt="${t('floor_plan_floor')} ${plan.floor}" class="w-full" />
                <svg class="floor-plan-svg absolute top-0 left-0 w-full h-full" id="bookingPlanSvg_${plan.floor}" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
            </div>
        </div>
    `).join('');

    buildingPlans.forEach(plan => {
        renderBookingPlanMarkers(plan.floor, buildingRooms, bookingOccupancy || []);
    });
}

function renderBookingPlanMarkers(floor, buildingRooms, bookingOccupancy) {
    const svg = Layout.$(`#bookingPlanSvg_${floor}`);
    if (!svg) return;

    svg.innerHTML = '';

    const floorRooms = buildingRooms.filter(r =>
        r.floor === floor &&
        r.plan_x != null &&
        r.plan_y != null &&
        r.status !== 'maintenance' &&
        r.status !== 'mothballed'
    );

    floorRooms.forEach(room => {
        const roomOcc = bookingOccupancy.find(o => o.room_id === room.id);
        const occupied = roomOcc?.occupied || 0;
        const booked = roomOcc?.booked || 0;
        const capacity = roomOcc?.capacity || room.capacity || 1;

        const x = parseFloat(room.plan_x);
        const y = parseFloat(room.plan_y);
        const w = parseFloat(room.plan_width) || 8;
        const h = parseFloat(room.plan_height) || 8;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('data-room-id', room.id);

        if (capacity === 2) {
            const halfW = w / 2;
            for (let i = 0; i < 2; i++) {
                const bedKey = `${room.id}_${i}`;
                const isOccupied = i < occupied;
                const isBooked = i >= occupied && i < occupied + booked;
                const isSelected = bookingSelectedBeds.has(bedKey);
                const isAvailable = !isOccupied && !isBooked;

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', x + i * halfW);
                rect.setAttribute('y', y);
                rect.setAttribute('width', halfW);
                rect.setAttribute('height', h);

                if (isSelected) {
                    rect.setAttribute('fill', statusColors.selected);
                } else if (isOccupied) {
                    rect.setAttribute('fill', statusColors.occupied);
                } else if (isBooked) {
                    rect.setAttribute('fill', statusColors.booked);
                } else {
                    rect.setAttribute('fill', statusColors.available);
                }

                if (isAvailable || isSelected) {
                    rect.style.cursor = 'pointer';
                    rect.onclick = () => toggleBookingBed(room.id, i, capacity);
                }

                g.appendChild(rect);
            }
        } else if (capacity === 3) {
            const thirdW = w / 3;
            for (let i = 0; i < 3; i++) {
                const bedKey = `${room.id}_${i}`;
                const isOccupied = i < occupied;
                const isBooked = i >= occupied && i < occupied + booked;
                const isSelected = bookingSelectedBeds.has(bedKey);
                const isAvailable = !isOccupied && !isBooked;

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', x + i * thirdW);
                rect.setAttribute('y', y);
                rect.setAttribute('width', thirdW);
                rect.setAttribute('height', h);

                if (isSelected) {
                    rect.setAttribute('fill', statusColors.selected);
                } else if (isOccupied) {
                    rect.setAttribute('fill', statusColors.occupied);
                } else if (isBooked) {
                    rect.setAttribute('fill', statusColors.booked);
                } else {
                    rect.setAttribute('fill', statusColors.available);
                }

                if (isAvailable || isSelected) {
                    rect.style.cursor = 'pointer';
                    rect.onclick = () => toggleBookingBed(room.id, i, capacity);
                }

                g.appendChild(rect);
            }
        } else if (capacity === 4) {
            const halfW = w / 2;
            const halfH = h / 2;
            const positions = [[0, 0], [1, 0], [0, 1], [1, 1]];
            for (let i = 0; i < 4; i++) {
                const [px, py] = positions[i];
                const bedKey = `${room.id}_${i}`;
                const isOccupied = i < occupied;
                const isBooked = i >= occupied && i < occupied + booked;
                const isSelected = bookingSelectedBeds.has(bedKey);
                const isAvailable = !isOccupied && !isBooked;

                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', x + px * halfW);
                rect.setAttribute('y', y + py * halfH);
                rect.setAttribute('width', halfW);
                rect.setAttribute('height', halfH);

                if (isSelected) {
                    rect.setAttribute('fill', statusColors.selected);
                } else if (isOccupied) {
                    rect.setAttribute('fill', statusColors.occupied);
                } else if (isBooked) {
                    rect.setAttribute('fill', statusColors.booked);
                } else {
                    rect.setAttribute('fill', statusColors.available);
                }

                if (isAvailable || isSelected) {
                    rect.style.cursor = 'pointer';
                    rect.onclick = () => toggleBookingBed(room.id, i, capacity);
                }

                g.appendChild(rect);
            }
        } else {
            const bedKey = `${room.id}_0`;
            const isOccupied = occupied > 0;
            const isBooked = booked > 0;
            const isSelected = bookingSelectedBeds.has(bedKey);
            const isAvailable = !isOccupied && !isBooked;

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', x);
            rect.setAttribute('y', y);
            rect.setAttribute('width', w);
            rect.setAttribute('height', h);

            if (isSelected) {
                rect.setAttribute('fill', statusColors.selected);
            } else if (isOccupied) {
                rect.setAttribute('fill', statusColors.occupied);
            } else if (isBooked) {
                rect.setAttribute('fill', statusColors.booked);
            } else {
                rect.setAttribute('fill', statusColors.available);
            }

            if (isAvailable || isSelected) {
                rect.style.cursor = 'pointer';
                rect.onclick = () => toggleBookingBed(room.id, 0, capacity);
            }

            g.appendChild(rect);
        }

        // Room number label
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x + w / 2);
        text.setAttribute('y', y + h / 2);
        text.classList.add('room-label');
        text.textContent = room.number;
        text.style.pointerEvents = 'none';

        g.appendChild(text);
        svg.appendChild(g);
    });
}

function toggleBookingBed(roomId, bedIndex, capacity) {
    const bedKey = `${roomId}_${bedIndex}`;
    const form = Layout.$('#newBookingForm');
    const maxBeds = parseInt(form.beds_count.value) || 1;

    if (bookingSelectedBeds.has(bedKey)) {
        bookingSelectedBeds.delete(bedKey);
    } else {
        if (bookingSelectedBeds.size >= maxBeds) {
            return;
        }
        bookingSelectedBeds.add(bedKey);
    }

    Layout.$('#bookingSelectedCount').textContent = bookingSelectedBeds.size;

    const saveBtn = Layout.$('#bookingSaveBtn');
    saveBtn.disabled = bookingSelectedBeds.size !== maxBeds;

    // Обновляем только визуальное состояние без полной перерисовки
    updateBookingBedVisual(roomId, bedIndex, capacity);
}

function updateBookingBedVisual(roomId, bedIndex, capacity) {
    const bedKey = `${roomId}_${bedIndex}`;
    const isSelected = bookingSelectedBeds.has(bedKey);

    // Находим все SVG элементы комнаты
    document.querySelectorAll(`[data-room-id="${roomId}"]`).forEach(roomGroup => {
        const rects = roomGroup.querySelectorAll('rect');

        if (capacity === 1) {
            // Одноместная комната - обновляем единственный прямоугольник
            const rect = rects[0];
            if (rect) {
                rect.setAttribute('fill', isSelected ? statusColors.selected : statusColors.available);
            }
        } else {
            // Многоместная - обновляем конкретное место
            const rect = rects[bedIndex];
            if (rect) {
                rect.setAttribute('fill', isSelected ? statusColors.selected : statusColors.available);
            }
        }
    });
}

async function saveNewBooking() {
    const form = Layout.$('#newBookingForm');
    const bedsCount = parseInt(form.beds_count.value) || 1;

    if (bookingSelectedBeds.size !== bedsCount) {
        Layout.showNotification(t('select_beds_on_plan').replace('{count}', bedsCount), 'error');
        return;
    }

    try {
        const bookingData = {
            name: form.name.value.trim() || null,
            contact_name: form.contact_name.value.trim(),
            contact_phone: form.contact_phone.value.trim() || null,
            contact_email: form.contact_email.value.trim() || null,
            contact_country: form.contact_country.value.trim() || null,
            beds_count: bedsCount,
            check_in: form.check_in.value,
            check_out: form.check_out.value,
            retreat_id: form.retreat_id.value || null,
            notes: form.notes.value.trim() || null,
            status: 'active'
        };

        const { data: booking, error: bookingError } = await Layout.db
            .from('bookings')
            .insert(bookingData)
            .select()
            .single();

        if (bookingError) throw bookingError;

        // Create placeholder residents for each selected bed
        const residentsData = [];
        bookingSelectedBeds.forEach(bedKey => {
            const [roomId] = bedKey.split('_');
            residentsData.push({
                room_id: roomId,
                booking_id: booking.id,
                check_in: form.check_in.value,
                check_out: form.check_out.value,
                has_housing: true,
                has_meals: null,
                status: 'confirmed'
            });
        });

        const { error: residentsError } = await Layout.db
            .from('residents')
            .insert(residentsData);

        if (residentsError) throw residentsError;

        closeNewBookingModal();
        await loadBookings();
        await loadAllBookings();

    } catch (err) {
        console.error('Error saving booking:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
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
    await loadBookings();
    await loadAllBookings();
    Layout.hideLoader();
}

init();
