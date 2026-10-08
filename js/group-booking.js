// ==================== GROUP-BOOKING.JS ====================
// Окно «Регистрация группы» (ВГ, 08.10.2026, «Шахматка 8», часть 2) — одно и то же
// в шахматке и на «Бронированиях»:
//   ретрит первым → название и контакт из ретрита → даты → сколько людей →
//   номера по зданиям (свободен / в стык / занято частично / нахлёст — нельзя),
//   в каждом номере 1..свободных кроватей → «Самостоятельное проживание: N» →
//   счётчик людей и мест.
// Существующая групповая бронь открывается здесь же на правку: места добавляются,
// убираются только безымянные и не заехавшие (имена убирают в шахматке).
// Запрет накладок держит база (триггер residents_conflict_guard, мигр. 655) —
// окно лишь не даёт выбрать заведомо занятое.
//
// GroupBooking.open({ checkIn, checkOut, roomId, selfCount, bookingId, onSaved })

const GroupBooking = (() => {
'use strict';

const e = s => Layout.escapeHtml(s ?? '');
const tf = (key, fallback) => { const v = Layout.t(key); return !v || v === key ? fallback : v; };
const SELF = 'self';
const addDays = (iso, n) => { const d = DateUtils.parseDate(iso); d.setDate(d.getDate() + n); return DateUtils.toISO(d); };
const personName = v => v ? (v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim()) : '';

let S = null;       // состояние открытого окна
let ready = false;  // разметка вставлена

function canEdit() {
    return !!(window.hasPermission?.('edit_timeline') || window.hasPermission?.('create_booking'));
}

// ---------- разметка ----------
function ensureDialog() {
    if (ready) return;
    ready = true;
    const style = document.createElement('style');
    style.textContent = `
        #groupBookingModal .gb-rooms { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; }
        #groupBookingModal .gb-room { border: 1px solid oklch(var(--bc) / .15); border-radius: 8px; padding: 6px 8px; cursor: pointer; user-select: none; }
        #groupBookingModal .gb-room .gb-num { font-weight: 600; }
        #groupBookingModal .gb-room .gb-sub { font-size: 11px; line-height: 1.2; }
        #groupBookingModal .gb-room select { margin-top: 4px; width: 100%; }
        #groupBookingModal .gb-free { background: #ecfdf5; border-color: #a7f3d0; }
        #groupBookingModal .gb-adjacent { background: #fffbeb; border-color: #fcd34d; }
        #groupBookingModal .gb-partial { background: #fff7ed; border-color: #fdba74; }
        #groupBookingModal .gb-busy { background: #fef2f2; border-color: #fecaca; color: #991b1b; cursor: not-allowed; }
        #groupBookingModal .gb-picked { outline: 2px solid var(--current-color, #8b5cf6); outline-offset: -1px; }
        #groupBookingModal details:not([open]) .details-chevron { transform: rotate(-90deg); }
    `;
    document.head.appendChild(style);

    const dlg = document.createElement('dialog');
    dlg.id = 'groupBookingModal';
    dlg.className = 'modal';
    dlg.innerHTML = `
        <div class="modal-box max-w-4xl relative flex flex-col" style="max-height: 92vh">
            <button type="button" class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" data-gb="close">✕</button>
            <h3 class="font-bold text-lg mb-3" id="gbTitle"></h3>
            <div class="overflow-y-auto flex-1 pr-1">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label class="form-control sm:col-span-2">
                        <span class="label-text font-medium mb-1">${e(tf('booking_retreat', 'Ретрит'))}</span>
                        <select id="gbRetreat" class="select select-bordered select-sm w-full"></select>
                        <span id="gbRetreatWarn" class="text-xs text-warning mt-1 hidden"></span>
                    </label>
                    <label class="form-control">
                        <span class="label-text font-medium mb-1">${e(tf('timeline_group_name', 'Название группы'))}</span>
                        <input id="gbName" class="input input-bordered input-sm w-full" />
                    </label>
                    <label class="form-control">
                        <span class="label-text font-medium mb-1">${e(tf('booking_contact_name', 'Контактное лицо'))}</span>
                        <input id="gbContactName" class="input input-bordered input-sm w-full" />
                    </label>
                    <label class="form-control">
                        <span class="label-text font-medium mb-1">${e(tf('booking_contact_phone', 'Телефон'))}</span>
                        <input id="gbContactPhone" class="input input-bordered input-sm w-full" />
                    </label>
                    <label class="form-control">
                        <span class="label-text font-medium mb-1">Telegram</span>
                        <input id="gbContactTelegram" class="input input-bordered input-sm w-full" />
                    </label>
                    <div class="grid grid-cols-3 gap-3 sm:col-span-2">
                        <label class="form-control">
                            <span class="label-text font-medium mb-1">${e(tf('check_in', 'Заезд'))}</span>
                            <input id="gbIn" type="date" class="input input-bordered input-sm w-full" />
                        </label>
                        <label class="form-control">
                            <span class="label-text font-medium mb-1">${e(tf('check_out', 'Выезд'))}</span>
                            <input id="gbOut" type="date" class="input input-bordered input-sm w-full" />
                        </label>
                        <label class="form-control">
                            <span class="label-text font-medium mb-1">${e(tf('timeline_group_people', 'Людей'))}</span>
                            <input id="gbPeople" type="number" min="1" max="500" class="input input-bordered input-sm w-full" />
                        </label>
                    </div>
                    <div id="gbMeals" class="sm:col-span-2 flex flex-wrap items-center gap-4 text-sm">
                        <span class="font-medium">${e(tf('timeline_prasad', 'Прасад'))}:</span>
                        <label class="flex items-center gap-1"><input type="checkbox" id="gbBreakfast" class="checkbox checkbox-sm" checked> ${e(tf('breakfast', 'Завтрак'))}</label>
                        <label class="flex items-center gap-1"><input type="checkbox" id="gbLunch" class="checkbox checkbox-sm" checked> ${e(tf('lunch', 'Обед'))}</label>
                    </div>
                    <div id="gbMealNote" class="sm:col-span-2 text-xs opacity-80 hidden"></div>
                    <label class="form-control sm:col-span-2">
                        <span class="label-text font-medium mb-1">${e(tf('booking_notes', 'Примечания'))}</span>
                        <input id="gbNotes" class="input input-bordered input-sm w-full" />
                    </label>
                </div>

                <div class="flex flex-wrap items-center gap-3 text-xs mt-4 mb-2 opacity-80">
                    <span class="font-medium text-sm opacity-100">${e(tf('timeline_group_rooms', 'Номера'))}</span>
                    <span class="flex items-center gap-1"><span class="w-3 h-3 rounded gb-free" style="border:1px solid #a7f3d0;background:#ecfdf5"></span>${e(tf('timeline_room_free', 'свободен'))}</span>
                    <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="border:1px solid #fcd34d;background:#fffbeb"></span>${e(tf('timeline_room_adjacent', 'в стык'))}</span>
                    <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="border:1px solid #fdba74;background:#fff7ed"></span>${e(tf('timeline_room_partial', 'занят частично'))}</span>
                    <span class="flex items-center gap-1"><span class="w-3 h-3 rounded" style="border:1px solid #fecaca;background:#fef2f2"></span>${e(tf('timeline_room_overlap', 'нахлёст — нельзя'))}</span>
                </div>
                <div id="gbBuildings" class="space-y-2"></div>

                <div class="flex flex-wrap items-center gap-3 mt-4 p-3 rounded-lg bg-base-200">
                    <span class="font-medium">${e(tf('timeline_self_stay', 'Самостоятельное проживание'))}:</span>
                    <input id="gbSelf" type="number" min="0" max="500" value="0" class="input input-bordered input-sm w-24" />
                    <span class="text-xs opacity-70">${e(tf('timeline_self_add_hint', 'без номера — живёт вне ашрама'))}</span>
                </div>
            </div>

            <div class="mt-3 pt-3 border-t flex flex-wrap items-center gap-3">
                <div id="gbCounter" class="text-sm flex-1"></div>
                <button type="button" class="btn btn-ghost btn-sm" data-gb="close">${e(tf('close', 'Закрыть'))}</button>
                <button type="button" class="btn btn-primary btn-sm" id="gbSave">${e(tf('save', 'Сохранить'))}</button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>`;
    document.body.appendChild(dlg);

    dlg.addEventListener('click', ev => {
        if (ev.target.closest('[data-gb="close"]')) { dlg.close(); return; }
        if (ev.target.closest('select')) return;
        const card = ev.target.closest('[data-room-card]');
        if (card) toggleRoom(card.dataset.roomCard);
    });
    dlg.addEventListener('change', ev => {
        const sel = ev.target.closest('select[data-room]');
        if (sel) { setPick(sel.dataset.room, parseInt(sel.value) || 0); return; }
    });
    $('gbRetreat').addEventListener('change', () => applyRetreat());
    $('gbIn').addEventListener('change', onDatesChanged);
    $('gbOut').addEventListener('change', onDatesChanged);
    $('gbPeople').addEventListener('input', renderCounter);
    $('gbSelf').addEventListener('input', () => {
        const min = S.minSeats[SELF] || 0;
        S.picks[SELF] = Math.max(min, parseInt($('gbSelf').value) || 0);
        renderCounter();
    });
    $('gbSelf').addEventListener('change', () => { $('gbSelf').value = S.picks[SELF] || 0; });
    $('gbName').addEventListener('input', () => { $('gbName').dataset.manual = '1'; });
    $('gbContactName').addEventListener('input', () => { delete $('gbContactName').dataset.auto; });
    $('gbSave').addEventListener('click', save);
}

const $ = id => document.getElementById(id);

// ---------- данные ----------
async function loadRefs() {
    const [b, r, rt, fe, cat] = await Promise.all([
        Layout.db.from('buildings').select('id, name_ru, name_en, name_hi, is_temporary, sort_order')
            .eq('is_active', true).order('sort_order'),
        Layout.db.from('rooms').select('id, number, floor, building_id, capacity, status').eq('is_active', true),
        Layout.db.from('retreats')
            .select('id, name_ru, name_en, name_hi, start_date, end_date, is_external, contact_vaishnava_id')
            .order('start_date'),
        Layout.db.from('retreat_fact_end').select('retreat_id, fact_end'),
        Layout.db.from('resident_categories').select('id, slug')
    ]);
    const err = b.error || r.error || rt.error || cat.error;
    if (err) throw err;
    const factEnd = new Map((fe.data || []).map(f => [f.retreat_id, f.fact_end]));
    S.buildings = b.data || [];
    S.rooms = (r.data || []).filter(x => x.status !== 'maintenance' && x.status !== 'mothballed')
        .sort((a, c) => (a.floor || 0) - (c.floor || 0)
            || String(a.number).localeCompare(String(c.number), 'ru', { numeric: true }));
    S.retreats = (rt.data || []).map(x => ({ ...x, fact_end: factEnd.get(x.id) || x.end_date }));
    S.groupCategoryId = (cat.data || []).find(c => c.slug === 'group')?.id || null;
}

// Существующая бронь: её места по номерам; убрать можно только безымянные и не заехавшие
async function loadBooking(bookingId) {
    const [{ data: bk, error: e1 }, { data: seats, error: e2 }] = await Promise.all([
        Layout.db.from('bookings').select('*').eq('id', bookingId).single(),
        Layout.db.from('residents')
            .select('id, room_id, vaishnava_id, guest_name, arrived_at, check_in, check_out, status, created_at, category_id, retreat_id, breakfast, lunch, has_meals, department_id')
            .eq('booking_id', bookingId).neq('status', 'cancelled')
    ]);
    if (e1 || e2) throw e1 || e2;
    S.booking = bk;
    S.seats = seats || [];
    S.origPicks = {};
    S.minSeats = {};
    for (const s of S.seats) {
        const k = s.room_id || SELF;
        S.origPicks[k] = (S.origPicks[k] || 0) + 1;
        if (!isRemovable(s)) S.minSeats[k] = (S.minSeats[k] || 0) + 1;
    }
    S.picks = { ...S.origPicks };
}

const isRemovable = s => s.status === 'confirmed' && !s.vaishnava_id && !s.guest_name && !s.arrived_at;

// Занятость номеров на даты окна — без мест этой брони
async function loadOccupancy() {
    const from = $('gbIn').value, to = $('gbOut').value;
    S.occ = new Map();
    if (!from || !to || to <= from) return;
    const { data, error } = await Layout.db.from('residents')
        .select('id, room_id, check_in, check_out, booking_id')
        .in('status', ['confirmed', 'booked'])
        .not('room_id', 'is', null)
        .lte('check_in', to)
        .or(`check_out.is.null,check_out.gte.${from}`);
    if (error) { Layout.handleError?.(error, 'Занятость номеров'); return; }
    const nights = [];
    for (let d = from; d < to; d = addDays(d, 1)) nights.push(d);
    const byRoom = new Map();
    for (const o of data || []) {
        if (S.booking && o.booking_id === S.booking.id) continue;
        if (!byRoom.has(o.room_id)) byRoom.set(o.room_id, []);
        byRoom.get(o.room_id).push(o);
    }
    for (const [roomId, list] of byRoom) {
        let peak = 0;
        for (const n of nights) {
            const c = list.filter(o => o.check_in <= n && (!o.check_out || o.check_out > n)).length;
            if (c > peak) peak = c;
        }
        const adjacent = list.some(o => o.check_out === from || o.check_in === to);
        S.occ.set(roomId, { peak, adjacent });
    }
}

function roomState(room) {
    const cap = room.capacity || 1;
    const o = S.occ.get(room.id) || { peak: 0, adjacent: false };
    const free = Math.max(0, cap - o.peak);
    const kind = o.peak >= cap ? 'busy' : o.peak > 0 ? 'partial' : o.adjacent ? 'adjacent' : 'free';
    return { cap, free, kind, peak: o.peak };
}

// ---------- ретрит ----------
function fillRetreats(selectedId) {
    $('gbRetreat').innerHTML = RetreatSelect.html(S.retreats, selectedId, $('gbIn').value, $('gbOut').value,
        { noneLabel: tf('timeline_no_retreat', '— без ретрита —') });
    $('gbRetreat').value = selectedId || '';
}

function retreatWarn() {
    const id = $('gbRetreat').value;
    const bad = RetreatSelect.mismatch?.(S.retreats, id, $('gbIn').value, $('gbOut').value);
    $('gbRetreatWarn').textContent = bad ? RetreatSelect.mismatchText() : '';
    $('gbRetreatWarn').classList.toggle('hidden', !bad);
}

// Ретрит подставляет название, контакт и (у новой брони пустые) даты
async function applyRetreat() {
    const r = S.retreats.find(x => x.id === $('gbRetreat').value);
    if (!S.booking) {
        if ($('gbName').dataset.manual !== '1') $('gbName').value = r ? Layout.getName(r) : '';
        if (r && !S.datesTouched) {
            $('gbIn').value = r.start_date;
            $('gbOut').value = r.end_date;
            await onDatesChanged(true);
        }
        const cn = $('gbContactName');
        if (!cn.value.trim() || cn.dataset.auto === '1') {
            let v = null;
            if (r?.contact_vaishnava_id) {
                const { data } = await Layout.db.from('vaishnavas')
                    .select('id, spiritual_name, first_name, last_name, phone, telegram, telegram_username')
                    .eq('id', r.contact_vaishnava_id).maybeSingle();
                v = data;
            }
            cn.value = personName(v);
            $('gbContactPhone').value = v?.phone || '';
            $('gbContactTelegram').value = v ? (v.telegram || v.telegram_username || '') : '';
            if (v) cn.dataset.auto = '1'; else delete cn.dataset.auto;
        }
    }
    retreatWarn();
    applyMealGroup();
}

// «Разовое питание по дням» у ретрита — кухня считает по заявке, галочек прасада у мест нет
async function applyMealGroup() {
    const retreatId = $('gbRetreat').value;
    let mg = null;
    if (retreatId && $('gbIn').value) {
        const { data } = await Layout.db.from('meal_groups').select('id, name')
            .eq('retreat_id', retreatId).eq('by_day', true)
            .lte('start_date', $('gbOut').value || $('gbIn').value).gte('end_date', $('gbIn').value).limit(1);
        mg = data?.[0] || null;
    }
    if ($('gbRetreat').value !== retreatId) return;
    S.mealGroup = mg;
    $('gbMeals').classList.toggle('hidden', !!mg || !!S.booking);
    $('gbMealNote').classList.toggle('hidden', !mg);
    $('gbMealNote').innerHTML = mg
        ? `Питание отдельно от проживания: кухня считает по заявке «${e(mg.name)}» в <a class="link link-primary" href="../vaishnavas/groups.html" target="_blank">Разовом питании</a>.`
        : '';
}

async function onDatesChanged(fromRetreat) {
    if (fromRetreat !== true) S.datesTouched = true;
    const keep = $('gbRetreat').value;
    fillRetreats(keep);
    retreatWarn();
    await loadOccupancy();
    // Выбор, ставший невозможным на новые даты, урезаем до свободного
    for (const room of S.rooms) {
        const p = S.picks[room.id] || 0;
        if (!p) continue;
        const max = Math.max(roomState(room).free, S.minSeats[room.id] || 0);
        if (p > max) S.picks[room.id] = max;
    }
    renderRooms();
    applyMealGroup();
}

// ---------- номера ----------
function setPick(roomId, n) {
    const room = S.rooms.find(r => r.id === roomId);
    if (!room) return;
    const min = S.minSeats[roomId] || 0;
    const max = Math.max(roomState(room).free, min);
    S.picks[roomId] = Math.min(max, Math.max(min, n));
    renderRooms();
}

function toggleRoom(roomId) {
    const room = S.rooms.find(r => r.id === roomId);
    if (!room) return;
    const st = roomState(room);
    if ((S.picks[roomId] || 0) > 0) setPick(roomId, 0);
    else if (st.free > 0) setPick(roomId, st.free);
}

function renderRooms() {
    const openNow = new Set([...document.querySelectorAll('#gbBuildings details[open]')].map(d => d.dataset.building));
    const html = S.buildings.map((b, i) => {
        const rooms = S.rooms.filter(r => r.building_id === b.id);
        if (!rooms.length) return '';
        let freeBeds = 0, picked = 0;
        const cards = rooms.map(room => {
            const st = roomState(room);
            const p = S.picks[room.id] || 0;
            freeBeds += st.free;
            picked += p;
            const min = S.minSeats[room.id] || 0;
            const max = Math.max(st.free, min);
            const sub = st.kind === 'busy' ? tf('timeline_room_overlap', 'нахлёст — нельзя')
                : st.kind === 'partial' ? `${tf('timeline_room_busy_of', 'занято')} ${st.peak} ${tf('booking_of', 'из')} ${st.cap}`
                : st.kind === 'adjacent' ? tf('timeline_room_adjacent', 'в стык')
                : tf('timeline_room_free', 'свободен');
            const opts = [];
            for (let n = min; n <= max; n++) opts.push(`<option value="${n}" ${n === p ? 'selected' : ''}>${n || '—'}</option>`);
            const disabled = max === 0;
            return `<div class="gb-room gb-${disabled ? 'busy' : st.kind}${p ? ' gb-picked' : ''}" data-room-card="${room.id}">
                <div class="flex justify-between gap-1"><span class="gb-num">№${e(room.number)}</span><span class="text-xs opacity-60">${st.cap}</span></div>
                <div class="gb-sub">${e(sub)}${min ? ` · ${e(tf('timeline_room_named', 'с именами'))}: ${min}` : ''}</div>
                ${disabled ? '' : `<select class="select select-bordered select-xs" data-room="${room.id}">${opts.join('')}</select>`}
            </div>`;
        }).join('');
        const isOpen = picked > 0 || openNow.has(b.id) || (!openNow.size && i === 0);
        return `<details data-building="${b.id}" class="rounded-lg border border-base-300" ${isOpen ? 'open' : ''}>
            <summary class="cursor-pointer px-3 py-2 flex items-center gap-2 list-none">
                <svg class="details-chevron w-4 h-4 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                <span class="font-medium">${e(Layout.getName(b))}</span>
                <span class="text-xs opacity-60">${e(tf('timeline_free_beds', 'свободно мест'))}: ${freeBeds}</span>
                ${picked ? `<span class="badge badge-primary badge-sm ml-auto">${e(tf('booking_selected', 'Выбрано'))}: ${picked}</span>` : ''}
            </summary>
            <div class="gb-rooms px-3 pb-3">${cards}</div>
        </details>`;
    }).join('');
    $('gbBuildings').innerHTML = html;
    renderCounter();
}

function seatTotals() {
    let inRooms = 0;
    for (const [k, n] of Object.entries(S.picks)) if (k !== SELF) inRooms += n || 0;
    const self = S.picks[SELF] || 0;
    return { inRooms, self, total: inRooms + self };
}

function renderCounter() {
    const { inRooms, self, total } = seatTotals();
    const people = parseInt($('gbPeople').value) || 0;
    let diff = '';
    if (people && total < people) diff = `<span class="text-error font-medium">${e(tf('timeline_group_short', 'не хватает мест'))}: ${people - total}</span>`;
    else if (people && total > people) diff = `<span class="text-warning font-medium">${e(tf('timeline_group_extra', 'мест больше, чем людей'))}: ${total - people}</span>`;
    else if (people) diff = `<span class="text-success font-medium">${e(tf('timeline_group_match', 'сходится'))}</span>`;
    $('gbCounter').innerHTML = `${e(tf('timeline_group_people', 'Людей'))}: <b>${people || '—'}</b> · `
        + `${e(tf('timeline_group_seats', 'Мест'))}: <b>${total}</b> `
        + `<span class="opacity-60">(${e(tf('timeline_group_in_rooms', 'в номерах'))} ${inRooms}, ${e(tf('timeline_group_self_short', 'без номера'))} ${self})</span>`
        + (diff ? ` · ${diff}` : '');
}

// ---------- открыть ----------
async function open(opts = {}) {
    if (!canEdit()) return;
    ensureDialog();
    S = { picks: {}, origPicks: {}, minSeats: {}, occ: new Map(), booking: null, seats: [],
        onSaved: opts.onSaved, datesTouched: false };
    $('gbTitle').textContent = opts.bookingId
        ? tf('timeline_group_edit', 'Групповая бронь: номера и места')
        : tf('timeline_group_title', 'Регистрация группы');
    for (const id of ['gbName', 'gbContactName', 'gbContactPhone', 'gbContactTelegram', 'gbNotes', 'gbPeople']) {
        $(id).value = '';
        delete $(id).dataset.manual;
        delete $(id).dataset.auto;
    }
    $('gbBreakfast').checked = $('gbLunch').checked = true;
    $('gbBuildings').innerHTML = `<div class="text-center py-6"><span class="loading loading-spinner"></span></div>`;
    $('groupBookingModal').showModal();

    try {
        await loadRefs();
        if (opts.bookingId) await loadBooking(opts.bookingId);
    } catch (err) {
        Layout.handleError?.(err, 'Регистрация группы');
        $('groupBookingModal').close();
        return;
    }

    if (S.booking) {
        const b = S.booking;
        $('gbName').value = b.name || '';
        $('gbName').dataset.manual = '1';
        $('gbContactName').value = b.contact_name || '';
        $('gbContactPhone').value = b.contact_phone || '';
        $('gbContactTelegram').value = b.contact_telegram || '';
        $('gbNotes').value = b.notes || '';
        $('gbIn').value = b.check_in;
        $('gbOut').value = b.check_out;
        $('gbPeople').value = S.seats.length;
        S.datesTouched = true;
        fillRetreats(b.retreat_id || '');
    } else {
        $('gbIn').value = opts.checkIn || '';
        $('gbOut').value = opts.checkOut || '';
        if (opts.selfCount) S.picks[SELF] = opts.selfCount;
        fillRetreats('');
    }
    $('gbSelf').value = S.picks[SELF] || 0;
    $('gbSelf').min = S.minSeats[SELF] || 0;
    retreatWarn();
    await loadOccupancy();
    if (opts.roomId) {
        const room = S.rooms.find(r => r.id === opts.roomId);
        if (room) S.picks[room.id] = roomState(room).free;
    }
    renderRooms();
    applyMealGroup();
}

// ---------- сохранить ----------
async function save() {
    const btn = $('gbSave');
    const from = $('gbIn').value, to = $('gbOut').value;
    const retreatId = $('gbRetreat').value || null;
    const retreat = S.retreats.find(r => r.id === retreatId);
    const name = $('gbName').value.trim();
    const { total } = seatTotals();
    const people = parseInt($('gbPeople').value) || 0;

    if (!from || !to) return Layout.showNotification(tf('timeline_dates_required', 'Укажите заезд и выезд'), 'error');
    if (to <= from) return Layout.showNotification(tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда'), 'error');
    if (!name && !retreat) return Layout.showNotification(tf('timeline_group_name_required', 'Выберите ретрит или впишите название группы'), 'error');
    if (!total) return Layout.showNotification(tf('timeline_group_no_seats', 'Выберите номера или места без номера'), 'error');
    if (people && people !== total && !confirm(`${tf('timeline_group_people', 'Людей')}: ${people}, ${tf('timeline_group_seats', 'мест').toLowerCase()}: ${total}. ${tf('save', 'Сохранить')}?`)) return;

    const head = {
        name: name || Layout.getName(retreat),
        contact_name: $('gbContactName').value.trim() || name || Layout.getName(retreat),
        contact_phone: $('gbContactPhone').value.trim() || null,
        contact_telegram: $('gbContactTelegram').value.trim() || null,
        retreat_id: retreatId,
        notes: $('gbNotes').value.trim() || null
    };

    btn.disabled = true;
    try {
        const ok = S.booking ? await saveEdit(head, from, to, retreatId) : await saveNew(head, from, to, retreat);
        if (!ok) return;
        $('groupBookingModal').close();
        Layout.showNotification(tf('saved', 'Сохранено'), 'success');
        await S.onSaved?.();
    } finally {
        btn.disabled = false;
    }
}

function seatRow(base, roomId) {
    return { ...base, room_id: roomId === SELF ? null : roomId, has_housing: roomId !== SELF,
        has_meals: roomId === SELF ? (base.breakfast || base.lunch) : null };
}

async function saveNew(head, from, to, retreat) {
    const { total } = seatTotals();
    const { data: booking, error } = await Layout.db.from('bookings')
        .insert({ ...head, check_in: from, check_out: to, beds_count: total, status: 'confirmed' })
        .select().single();
    if (error) { Layout.showNotification(error.message, 'error'); return false; }

    const byDay = !!S.mealGroup;
    const base = {
        booking_id: booking.id,
        retreat_id: head.retreat_id,
        // Стороннее мероприятие — категория «Группа»; иначе default колонки («Гость»)
        ...(retreat?.is_external && S.groupCategoryId ? { category_id: S.groupCategoryId } : {}),
        check_in: from,
        check_out: to,
        breakfast: !byDay && $('gbBreakfast').checked,
        lunch: !byDay && $('gbLunch').checked,
        status: 'confirmed'
    };
    const rows = [];
    for (const [k, n] of Object.entries(S.picks)) for (let i = 0; i < n; i++) rows.push(seatRow(base, k));
    const { error: e2 } = await Layout.db.from('residents').insert(rows);
    if (e2) {
        // Места не встали (накладка — 655): пустую бронь этого сохранения убираем, окно остаётся
        await Layout.db.from('bookings').delete().eq('id', booking.id);
        Layout.showNotification(e2.message, 'error');
        return false;
    }
    return true;
}

// Правка: шапка брони, затем убрать лишние места, сдвинуть общие даты, добавить новые.
// Даты меняем только у мест с прежними общими датами — свои даты людей не трогаем.
async function saveEdit(head, from, to, retreatId) {
    const b = S.booking;
    const fail = async err => {
        Layout.showNotification(err.message || String(err), 'error');
        // Часть могла сохраниться — перечитываем бронь, окно остаётся открытым
        await loadBooking(b.id).catch(() => {});
        $('gbSelf').value = S.picks[SELF] || 0;
        await loadOccupancy();
        renderRooms();
        return false;
    };

    let r = await Layout.db.from('bookings').update(head).eq('id', b.id);
    if (r.error) return fail(r.error);

    // 1) убрать
    const keys = new Set([...Object.keys(S.picks), ...Object.keys(S.origPicks)]);
    const toAdd = [];
    for (const k of keys) {
        const delta = (S.picks[k] || 0) - (S.origPicks[k] || 0);
        if (delta > 0) toAdd.push([k, delta]);
        if (delta >= 0) continue;
        const ids = S.seats.filter(s => (s.room_id || SELF) === k && isRemovable(s))
            .sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)))
            .slice(0, -delta).map(s => s.id);
        if (ids.length < -delta) return fail(new Error(tf('timeline_group_named_left', 'В номере остались места с именами — уберите их в шахматке')));
        r = await Layout.db.from('residents').delete().in('id', ids);
        if (r.error) return fail(r.error);
    }

    // 2) общие даты
    if (from !== b.check_in) {
        r = await Layout.db.from('residents').update({ check_in: from })
            .eq('booking_id', b.id).eq('check_in', b.check_in).is('arrived_at', null).neq('status', 'cancelled');
        if (r.error) return fail(r.error);
    }
    if (to !== b.check_out) {
        r = await Layout.db.from('residents').update({ check_out: to })
            .eq('booking_id', b.id).eq('check_out', b.check_out).neq('status', 'cancelled');
        if (r.error) return fail(r.error);
    }

    // 3) ретрит — у всех мест брони
    if ((retreatId || null) !== (b.retreat_id || null)) {
        r = await Layout.db.from('residents').update({ retreat_id: retreatId })
            .eq('booking_id', b.id).neq('status', 'cancelled');
        if (r.error) return fail(r.error);
    }

    // 4) добавить — как у имеющегося места брони
    if (toAdd.length) {
        const tpl = S.seats[0] || {};
        const base = {
            booking_id: b.id,
            retreat_id: retreatId,
            ...(tpl.category_id ? { category_id: tpl.category_id } : {}),
            department_id: tpl.department_id || null,
            check_in: from,
            check_out: to,
            breakfast: tpl.breakfast ?? !S.mealGroup,
            lunch: tpl.lunch ?? !S.mealGroup,
            status: 'confirmed'
        };
        const rows = [];
        for (const [k, n] of toAdd) for (let i = 0; i < n; i++) rows.push(seatRow(base, k));
        r = await Layout.db.from('residents').insert(rows);
        if (r.error) return fail(r.error);
    }
    return true;
}

return { open };
})();
