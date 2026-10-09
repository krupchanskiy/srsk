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
            <div id="gbMain" class="overflow-y-auto flex-1 pr-1">
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
                    <button type="button" class="btn btn-xs btn-outline ml-auto" data-gb="list">${e(tf('timeline_group_paste_list', 'Вставить список'))}</button>
                </div>
                <div id="gbListSummary" class="hidden mb-2 p-3 rounded-lg text-sm bg-info/10"></div>
                <div id="gbBuildings" class="space-y-2"></div>

                <div class="flex flex-wrap items-center gap-3 mt-4 p-3 rounded-lg bg-base-200">
                    <span class="font-medium">${e(tf('timeline_self_stay', 'Самостоятельное проживание'))}:</span>
                    <input id="gbSelf" type="number" min="0" max="500" value="0" class="input input-bordered input-sm w-24" />
                    <span class="text-xs opacity-70">${e(tf('timeline_self_add_hint', 'без номера — живёт вне ашрама'))}</span>
                    <div id="gbSelfNames" class="w-full"></div>
                </div>
            </div>

            <div id="gbList" class="hidden overflow-y-auto flex-1 pr-1">
                <ol class="text-sm mb-3 list-decimal pl-5 space-y-1">
                    <li>${e(tf('timeline_list_step1', 'Откройте таблицу организатора как есть — ничего не сортируйте и не переставляйте, лишние столбцы не удаляйте.'))}</li>
                    <li>${e(tf('timeline_list_step2', 'Выделите всю таблицу вместе со строкой заголовков (мышью или Cmd+A) и скопируйте (Cmd+C).'))}</li>
                    <li>${e(tf('timeline_list_step3', 'Нажмите в поле ниже и вставьте (Cmd+V).'))}</li>
                    <li>${e(tf('timeline_list_step4', 'Под полем появятся карточки столбцов. У каждой выберите, что в ней: Имя, Номер комнаты, Заезд, Выезд, Дни, Сколько человек, Телефон. Ненужные столбцы — «— не брать —».'))}</li>
                    <li>${e(tf('timeline_list_step5', 'Проверьте таблицу внизу: жёлтое «тот же?» — выберите человека из базы или «другой человек»; красный номер — комната не найдена, выберите её сами. Комнату и даты можно поправить у любого.'))}</li>
                    <li>${e(tf('timeline_list_step6', 'Нажмите «Расставить по номерам», проверьте номера в окне группы и нажмите «Сохранить».'))}</li>
                </ol>
                <p class="text-xs opacity-70 mb-2">${e(tf('timeline_list_room_optional', 'Столбец с номером комнаты не обязателен: без него люди встанут на места, отмеченные в окне группы.'))}</p>
                <textarea id="gbPaste" rows="6" class="textarea textarea-bordered w-full font-mono text-xs" placeholder="Пример:&#10;Имя&#9;Номер комнаты&#9;Заезд&#9;Выезд&#10;Радха Рани д.д.&#9;14&#9;12.10&#9;22.10&#10;Иван +1&#9;15&#9;12.10&#9;20.10"></textarea>
                <div id="gbMap" class="mt-3"></div>
                <div id="gbPreview" class="mt-3"></div>
            </div>
            <div id="gbListFooter" class="hidden mt-3 pt-3 border-t flex flex-wrap items-center gap-3">
                <div id="gbListCounter" class="text-sm flex-1"></div>
                <button type="button" class="btn btn-ghost btn-sm" data-gb="list-back">${e(tf('booking_back', 'Назад'))}</button>
                <button type="button" class="btn btn-primary btn-sm" data-gb="list-apply">${e(tf('timeline_list_apply', 'Расставить по номерам'))}</button>
            </div>

            <div id="gbFooter" class="mt-3 pt-3 border-t flex flex-wrap items-center gap-3">
                <div id="gbCounter" class="text-sm flex-1"></div>
                <button type="button" class="btn btn-ghost btn-sm" data-gb="close">${e(tf('close', 'Закрыть'))}</button>
                <button type="button" class="btn btn-primary btn-sm" id="gbSave">${e(tf('save', 'Сохранить'))}</button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>`;
    document.body.appendChild(dlg);

    dlg.addEventListener('click', ev => {
        if (ev.target.closest('[data-gb="close"]')) { dlg.close(); return; }
        if (ev.target.closest('[data-gb="list"]')) { showList(true); return; }
        if (ev.target.closest('[data-gb="list-back"]')) { showList(false); return; }
        if (ev.target.closest('[data-gb="list-apply"]')) { applyList(); return; }
        if (ev.target.closest('[data-gb="list-clear"]')) { S.assign = []; S.manual = []; renderRooms(); return; }
        if (ev.target.closest('#gbList')) return;
        if (ev.target.closest('select')) return;
        const card = ev.target.closest('[data-room-card]');
        if (card) toggleRoom(card.dataset.roomCard);
    });
    dlg.addEventListener('change', ev => {
        const sel = ev.target.closest('select[data-room]');
        if (sel) { setPick(sel.dataset.room, parseInt(sel.value) || 0); return; }
        if (ev.target.closest('#gbList')) onListEdit(ev);
    });
    let pasteTimer;
    $('gbPaste').addEventListener('input', () => { clearTimeout(pasteTimer); pasteTimer = setTimeout(renderList, 250); });
    $('gbRetreat').addEventListener('change', () => applyRetreat());
    $('gbIn').addEventListener('change', onDatesChanged);
    $('gbOut').addEventListener('change', onDatesChanged);
    $('gbPeople').addEventListener('input', renderCounter);
    $('gbSelf').addEventListener('input', () => {
        const min = minFor(SELF);
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
        Layout.db.from('buildings').select('id, name_ru, name_en, name_hi, is_temporary, sort_order, available_from, available_until')
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
    // Порядок как в шахматке: сначала наши постоянные здания (Гостевой дом первым), потом временные
    S.buildings = (b.data || []).sort((x, y) => (x.is_temporary ? 1 : 0) - (y.is_temporary ? 1 : 0)
        || (x.sort_order || 0) - (y.sort_order || 0));
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
        const max = Math.max(roomState(room).free, minFor(room.id));
        if (p > max) S.picks[room.id] = max;
    }
    renderRooms();
    applyMealGroup();
}

// ---------- номера ----------
function setPick(roomId, n) {
    const room = S.rooms.find(r => r.id === roomId);
    if (!room) return;
    const min = minFor(roomId);
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
    const from = $('gbIn').value, to = $('gbOut').value;
    const shown = S.buildings.filter(b => !b.is_temporary || (S.rooms.some(r => r.building_id === b.id && (S.picks[r.id] || S.occ.has(r.id)))
        || (from && to && b.available_from && b.available_until && b.available_from <= to && b.available_until >= from)));
    const html = shown.map((b, i) => {
        const rooms = S.rooms.filter(r => r.building_id === b.id);
        if (!rooms.length) return '';
        let freeBeds = 0, picked = 0;
        const cards = rooms.map(room => {
            const st = roomState(room);
            const p = S.picks[room.id] || 0;
            freeBeds += st.free;
            picked += p;
            const min = minFor(room.id);
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
                ${assignedNames(room.id)}
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
    $('gbSelfNames').innerHTML = assignedNames(SELF);
    renderListSummary();
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

// ---------- вставка списка (часть 3, ВГ 08.10) ----------
// Организатор присылает таблицу в своём виде: строка = человек (Дикша: имя, №, дата заезда)
// или строка = компания («сколько человек», «14 и 15» — Говинда). Вставляем как есть,
// выбираем, какой столбец что значит, сверяем имена со справочником и расставляем людей
// по номерам из списка (организаторы расселяют сами). Спутники без имени — «Имя +1».
// Не помещается (людей в номере больше, чем мест, замена посреди срока) — «разберите вручную».
const ROLES = [
    ['', '— не брать —'], ['name', 'Имя'], ['room', 'Номер комнаты'], ['in', 'Заезд'], ['out', 'Выезд'],
    ['days', 'Дни («14 и 15»)'], ['count', 'Сколько человек'], ['phone', 'Телефон']
];
const ROLE_RE = [
    ['count', /сколько|кол-?во|колич|человек|чел\.?$|people|pax|persons/i],
    ['phone', /тел|phone|whats|моб/i],
    ['in', /заезд|приезд|прибыт|arriv|check.?in/i],
    ['out', /выезд|отъезд|убыт|depart|check.?out/i],
    ['days', /^дни|^даты?$|days|числа/i],
    ['room', /номер|комнат|room|^№|^#$|^no\.?$/i],
    ['name', /имя|фио|name|участ|гост|компан|духовн|семья|family/i]
];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NAME_STOP = new Set(['prabhu', 'prabhuji', 'mataji', 'das', 'dasa', 'dasi', 'devi', 'dd', 'd', 'pr', 'm']);

function showList(on) {
    $('gbMain').classList.toggle('hidden', on);
    $('gbFooter').classList.toggle('hidden', on);
    $('gbList').classList.toggle('hidden', !on);
    $('gbListFooter').classList.toggle('hidden', !on);
    $('gbTitle').textContent = on ? tf('timeline_group_paste_list', 'Вставить список')
        : (S.booking ? tf('timeline_group_edit', 'Расселение группы') : tf('timeline_group_title', 'Регистрация группы'));
    if (on) { loadPeople(); $('gbPaste').focus(); renderList(); }
}

async function loadPeople() {
    if (S.people) return;
    const { data, error } = await Layout.db.from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name, phone')
        .or('is_deleted.is.null,is_deleted.eq.false').range(0, 4999);
    if (error) { Layout.handleError?.(error, 'Справочник'); S.people = []; return; }
    S.people = (data || []).map(v => ({ ...v,
        keys: [v.spiritual_name, `${v.first_name || ''} ${v.last_name || ''}`, `${v.last_name || ''} ${v.first_name || ''}`]
            .map(normName).filter(k => k.length >= 3) }));
    if (S.rows) renderList();
}

// Кириллица и латиница к одному виду: «Гауранга-чаран дас» = «Gauranga Charan das»
function normName(str) {
    return Translit.ru(String(str || '').toLowerCase()).normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z]+/g, ' ').trim().split(' ').filter(w => w && !NAME_STOP.has(w)).join('');
}

function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}

// Сверка с базой: точно один → «есть в базе»; похожие → «тот же?»; иначе новый (имя без карточки)
function matchPerson(name) {
    const q = normName(name);
    if (!q || !S.people) return { kind: 'new', cands: [] };
    const exact = S.people.filter(v => v.keys.includes(q));
    if (exact.length === 1) return { kind: 'exact', cands: exact };
    const similar = exact.length ? exact : S.people.filter(v => v.keys.some(k =>
        (q.length >= 5 && k.length >= 5 && (k.includes(q) || q.includes(k))) || (q.length >= 6 && lev(q, k) <= 2)));
    return similar.length ? { kind: 'similar', cands: similar.slice(0, 4) } : { kind: 'new', cands: [] };
}

function splitTable(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return [];
    const delim = lines.some(l => l.includes('\t')) ? '\t' : lines.some(l => l.includes(';')) ? ';' : null;
    return lines.map(l => (delim ? l.split(delim) : [l]).map(c => c.trim().replace(/^"(.*)"$/, '$1')));
}

// Дата из клетки: «12.10», «12.10.2026», «2026-10-12», «12 окт», «14 и 15» (дни месяца брони)
function parseDates(text, base) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return [];
    const b = DateUtils.parseDate(base || DateUtils.toISO(new Date()));
    const mk = (y, m, d) => {
        if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
        let yy = y ? (y < 100 ? 2000 + y : y) : b.getFullYear();
        let dt = new Date(yy, m - 1, d);
        if (!y && dt < new Date(b.getFullYear(), b.getMonth() - 6, 1)) dt = new Date(yy + 1, m - 1, d);
        return DateUtils.toISO(dt);
    };
    const out = [];
    let m;
    const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/g;
    while ((m = iso.exec(t))) out.push(mk(+m[1], +m[2], +m[3]));
    if (!out.length) {
        const dm = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/g;
        while ((m = dm.exec(t))) out.push(mk(m[3] ? +m[3] : 0, +m[2], +m[1]));
    }
    if (!out.length) {
        const words = /(\d{1,2})\s*([a-zа-яё]{3,})/g;
        while ((m = words.exec(t))) {
            let mi = MONTHS.findIndex(x => m[2].startsWith(x));
            if (mi < 0) mi = MONTHS_EN.findIndex(x => m[2].startsWith(x));
            if (mi >= 0) out.push(mk(0, mi + 1, +m[1]));
        }
    }
    if (!out.length) {
        // Только числа: дни месяца заезда брони («14 и 15», «14-15»); время «14:00» не дата
        const days = t.replace(/\d{1,2}:\d{2}/g, '').match(/\b\d{1,2}\b/g) || [];
        for (const d of days) out.push(mk(0, b.getMonth() + 1, +d));
    }
    return out.filter(Boolean).sort();
}

function autoMap(header, rows) {
    const map = header.map(h => (ROLE_RE.find(([, re]) => re.test(h || '')) || [''])[0]);
    // Без заголовка: один столбец — имена; иначе первый текстовый — имя
    if (!map.some(Boolean)) {
        const cols = header.length;
        if (cols === 1) return ['name'];
        const textCol = [...Array(cols).keys()].find(c => rows.filter(r => /[a-zа-яё]{3}/i.test(r[c] || '')).length > rows.length / 2);
        if (textCol != null) map[textCol] = 'name';
        // Столбцы с датами «12.10» — первый заезд, второй выезд
        const dateCols = [...Array(cols).keys()].filter(c => map[c] === ''
            && rows.filter(r => /\d{1,2}[./]\d{1,2}|\d{4}-\d{2}-\d{2}/.test(r[c] || '')).length > rows.length / 2);
        if (dateCols[0] != null) map[dateCols[0]] = 'in';
        if (dateCols[1] != null) map[dateCols[1]] = 'out';
    }
    // «№» со значениями 1, 2, 3… подряд — это номер строки, не комната
    const rc = map.indexOf('room');
    if (rc >= 0 && rows.length > 2 && rows.every((r, i) => String(r[rc]).trim() === String(i + 1))) map[rc] = '';
    return map;
}

function parseList() {
    const table = splitTable($('gbPaste').value);
    if (!table.length) { S.rows = null; S.listPeople = []; return; }
    const cols = Math.max(...table.map(r => r.length));
    table.forEach(r => { while (r.length < cols) r.push(''); });
    const first = table[0];
    const hasHeader = first.some(c => ROLE_RE.some(([, re]) => re.test(c))) && !first.some(c => parseDates(c).length && /\d/.test(c) && !/[a-zа-яё]{4}/i.test(c));
    const header = hasHeader ? first : first.map((_, i) => `${tf('timeline_list_col', 'Столбец')} ${String.fromCharCode(65 + i)}`);
    const rows = hasHeader ? table.slice(1) : table;
    const sig = header.join('|') + cols;
    if (S.mapSig !== sig) { S.map = autoMap(hasHeader ? first : header.map(() => ''), rows); S.mapSig = sig; }
    S.header = header;
    S.rows = rows;
    buildListPeople();
}

function resolveRoom(text) {
    const raw = String(text || '').trim();
    if (!raw) return { key: '', text: '' };
    if (/сам|self|без ном/i.test(raw)) return { key: SELF, text: raw };
    const n = raw.toLowerCase().replace(/№|#|room|комн\w*|ном\w*/g, '').replace(/\s+/g, '');
    const same = S.rooms.filter(r => String(r.number).toLowerCase().replace(/\s+/g, '') === n);
    const order = id => S.buildings.findIndex(b => b.id === id);
    same.sort((a, b) => (S.picks[b.id] ? 1 : 0) - (S.picks[a.id] ? 1 : 0) || order(a.building_id) - order(b.building_id));
    return { key: same[0]?.id || '', text: raw, notFound: !same.length };
}

// Строки таблицы → люди: имена через запятую / «и» / «&», «+2» и «сколько человек» — спутники
function buildListPeople() {
    const col = role => S.map.indexOf(role);
    const get = (r, role) => col(role) >= 0 ? r[col(role)] : '';
    const base = $('gbIn').value || S.retreats.find(x => x.id === $('gbRetreat').value)?.start_date;
    const people = [];
    S.rows.forEach((r, ri) => {
        let cell = get(r, 'name').trim();
        let extra = 0;
        const plus = cell.match(/\+\s*(\d+)\s*$/);
        if (plus) { extra = +plus[1]; cell = cell.slice(0, plus.index).trim(); }
        const names = cell ? cell.split(/\s*(?:,|;|\/|&|\s(?:и|and)\s)\s*/i).filter(Boolean) : [];
        // «Ritu & Rajiv Bansal» — фамилия последнего у тех, кто записан одним словом
        const last = names.length > 1 && names[names.length - 1].split(/\s+/);
        if (last && last.length > 1) names.forEach((n, i) => { if (i < names.length - 1 && !/\s/.test(n)) names[i] = `${n} ${last[last.length - 1]}`; });
        const count = parseInt(get(r, 'count')) || 0;
        if (count > names.length + extra) extra = count - names.length;
        if (!names.length && !extra) return;
        const room = resolveRoom(get(r, 'room'));
        let din = parseDates(get(r, 'in'), base)[0] || '';
        let dout = parseDates(get(r, 'out'), base).slice(-1)[0] || '';
        const days = parseDates(get(r, 'days'), base);
        if (days.length) { din = din || days[0]; dout = dout || addDays(days[days.length - 1], 1); }
        const lead = names[0] || `${tf('timeline_list_row', 'Строка')} ${ri + 1}`;
        for (const nm of names) {
            const m = matchPerson(nm);
            people.push({ row: ri, name: nm, match: m.kind, cands: m.cands,
                vid: m.kind === 'exact' ? m.cands[0].id : '', key: room.key, roomText: room.text,
                notFound: room.notFound, in: din, out: dout });
        }
        for (let k = 1; k <= extra; k++)
            people.push({ row: ri, name: `${lead} +${k}`, match: 'plus', cands: [], vid: '', key: room.key,
                roomText: room.text, notFound: room.notFound, in: din, out: dout });
    });
    S.listPeople = people;
}

function roomOptions(sel) {
    const opt = (v, label) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${e(label)}</option>`;
    return opt('', tf('timeline_list_any_room', '— любое отмеченное место —'))
        + opt(SELF, tf('timeline_self_stay', 'Самостоятельное проживание'))
        + S.buildings.map(b => {
            const rooms = S.rooms.filter(r => r.building_id === b.id);
            return rooms.length ? `<optgroup label="${e(Layout.getName(b))}">${rooms.map(r => opt(r.id, '№' + r.number)).join('')}</optgroup>` : '';
        }).join('');
}

function renderList() {
    parseList();
    if (!S.rows) {
        $('gbMap').innerHTML = $('gbPreview').innerHTML = '';
        $('gbListCounter').textContent = '';
        return;
    }
    const sample = c => S.rows.slice(0, 3).map(r => r[c]).filter(Boolean).join(' · ');
    $('gbMap').innerHTML = `<div class="text-sm font-medium mb-1">${e(tf('timeline_list_columns', 'Что в каком столбце'))}</div>
        <div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(170px, 1fr))">
        ${S.header.map((h, c) => `<label class="p-2 rounded border border-base-300 text-xs">
            <div class="font-medium truncate" title="${e(h)}">${e(h)}</div>
            <div class="opacity-60 truncate mb-1" title="${e(sample(c))}">${e(sample(c)) || '—'}</div>
            <select class="select select-bordered select-xs w-full" data-map="${c}">
                ${ROLES.map(([v, l]) => `<option value="${v}" ${S.map[c] === v ? 'selected' : ''}>${e(l)}</option>`).join('')}
            </select></label>`).join('')}
        </div>`;
    const P = S.listPeople;
    if (!S.map.includes('name') && !S.map.includes('count')) {
        $('gbPreview').innerHTML = `<div class="text-warning text-sm">${e(tf('timeline_list_need_name', 'Выберите столбец с именами'))}</div>`;
        $('gbListCounter').textContent = '';
        return;
    }
    const matchCell = (p, i) => {
        if (p.match === 'plus') return `<span class="opacity-60">${e(tf('timeline_list_companion', 'спутник без имени'))}</span>`;
        if (p.match === 'new' && !p.cands.length) return `<span class="badge badge-ghost badge-sm">${e(tf('timeline_list_new', 'новый'))}</span>`;
        const cls = p.match === 'exact' ? 'select-success' : 'select-warning';
        return `<select class="select select-bordered select-xs ${cls}" data-lf="vid" data-i="${i}">
            ${p.cands.map(v => `<option value="${v.id}" ${p.vid === v.id ? 'selected' : ''}>${p.match === 'exact' ? '✓ ' : tf('timeline_list_same', 'тот же?') + ' '}${e(personName(v))}${v.phone ? ' · ' + e(v.phone) : ''}</option>`).join('')}
            <option value="" ${!p.vid ? 'selected' : ''}>${e(tf('timeline_list_other', 'другой человек — имя без карточки'))}</option>
        </select>`;
    };
    $('gbPreview').innerHTML = `<div class="overflow-x-auto"><table class="table table-xs">
        <thead><tr><th>${e(tf('timeline_list_name', 'Имя'))}</th><th>${e(tf('timeline_list_in_base', 'В базе'))}</th>
            <th>${e(tf('timeline_list_room_col', 'Номер комнаты'))}</th><th>${e(tf('check_in', 'Заезд'))}</th><th>${e(tf('check_out', 'Выезд'))}</th></tr></thead>
        <tbody>${P.map((p, i) => `<tr class="${i && P[i - 1].row !== p.row ? 'border-t-2' : ''}">
            <td class="whitespace-nowrap">${e(p.name)}</td>
            <td>${matchCell(p, i)}</td>
            <td><select class="select select-bordered select-xs ${p.notFound ? 'select-error' : ''}" data-lf="key" data-i="${i}">${roomOptions(p.key)}</select>
                ${p.notFound ? `<div class="text-error text-xs">«${e(p.roomText)}» ${e(tf('timeline_list_room_not_found', 'не найден'))}</div>` : ''}</td>
            <td><input type="date" class="input input-bordered input-xs" data-lf="in" data-i="${i}" value="${p.in}"></td>
            <td><input type="date" class="input input-bordered input-xs" data-lf="out" data-i="${i}" value="${p.out}"></td>
        </tr>`).join('')}</tbody></table></div>`;
    const similar = P.filter(p => p.match === 'similar').length;
    $('gbListCounter').innerHTML = `${e(tf('timeline_group_people', 'Людей'))}: <b>${P.length}</b>`
        + ` · ${e(tf('timeline_list_found', 'есть в базе'))}: ${P.filter(p => p.match === 'exact').length}`
        + (similar ? ` · <span class="text-warning font-medium">${e(tf('timeline_list_check', 'проверьте похожих'))}: ${similar}</span>` : '');
}

function onListEdit(ev) {
    const el = ev.target.closest('[data-lf]');
    if (el) {
        const p = S.listPeople[+el.dataset.i];
        if (!p) return;
        p[el.dataset.lf] = el.value;
        if (el.dataset.lf === 'key') { p.notFound = false; el.classList.remove('select-error'); }
        return;
    }
    const m = ev.target.closest('[data-map]');
    if (m) {
        const c = +m.dataset.map;
        // Одна роль — один столбец (кроме «не брать»)
        if (m.value) S.map = S.map.map((r, i) => i !== c && r === m.value ? '' : r);
        S.map[c] = m.value;
        S.mapSig = S.header.join('|') + S.header.length;
        renderListKeepMap();
    }
}

function renderListKeepMap() {
    const keep = S.map, sig = S.mapSig;
    renderList();
    S.map = keep; S.mapSig = sig;
}

// Имена из списка на карточке номера: с датами, если они не как у брони
function assignedNames(k) {
    const list = (S.assign || []).filter(p => p.key === k);
    if (!list.length) return '';
    const from = $('gbIn').value, to = $('gbOut').value;
    return `<div class="text-xs mt-1 leading-tight">${list.map(p => `<div class="truncate" title="${e(p.name)}">${p.vid ? '✓ ' : ''}${e(p.name)}${p.in !== from || p.out !== to ? ` <span class="opacity-60">${e(DateUtils.formatRange(p.in, p.out))}</span>` : ''}</div>`).join('')}</div>`;
}

const assigned = k => (S.assign || []).filter(p => p.key === k).length;
const minFor = k => (S.minSeats[k] || 0) + assigned(k);

// Уже стоит в этой брони (повторная вставка того же списка) — второй раз не ставим
function alreadySeated(p) {
    return S.seats.some(s => (p.vid && s.vaishnava_id === p.vid) || (!p.vid && s.guest_name && s.guest_name === p.name));
}

async function applyList() {
    if (!S.listPeople?.length) return showList(false);
    const P = S.listPeople.map(p => ({ ...p }));
    // Даты брони охватывают даты из списка
    let from = $('gbIn').value, to = $('gbOut').value;
    for (const p of P) {
        p.in = p.in || from; p.out = p.out || to;
        if (p.in && (!from || p.in < from)) from = p.in;
        if (p.out && (!to || p.out > to)) to = p.out;
    }
    if (from !== $('gbIn').value || to !== $('gbOut').value) {
        $('gbIn').value = from; $('gbOut').value = to;
        S.datesTouched = true;
        fillRetreats($('gbRetreat').value);
        retreatWarn();
        await loadOccupancy();
    }
    const manual = [];
    const place = [];
    const seen = new Set();
    for (const p of P) {
        if (p.in && p.out && p.out <= p.in) { manual.push({ name: p.name, why: tf('timeline_checkout_before_checkin', 'Выезд не может быть раньше заезда') }); continue; }
        if (p.vid && seen.has(p.vid)) { manual.push({ name: p.name, why: tf('timeline_list_twice', 'дважды в списке') }); continue; }
        if (p.vid) seen.add(p.vid);
        if (alreadySeated(p)) continue;
        place.push(p);
    }
    // Номер из списка: не больше свободных кроватей (за вычетом мест брони с именами)
    S.assign = [];
    const cap = k => k === SELF ? Infinity
        : Math.max(0, roomState(S.rooms.find(r => r.id === k)).free - (S.minSeats[k] || 0));
    for (const p of place.filter(p => p.key)) {
        const room = S.rooms.find(r => r.id === p.key);
        if (assigned(p.key) < cap(p.key)) S.assign.push(p);
        else manual.push({ name: p.name, why: `№${room?.number ?? ''}: ${tf('timeline_list_room_full', 'людей больше, чем мест (замена посреди срока?) — разберите вручную')}` });
    }
    // Без номера — на свободные отмеченные места, в порядке зданий
    const anyRooms = S.buildings.flatMap(b => S.rooms.filter(r => r.building_id === b.id && (S.picks[r.id] || 0) > 0));
    for (const p of place.filter(p => !p.key)) {
        const room = anyRooms.find(r => assigned(r.id) < Math.min(cap(r.id), (S.picks[r.id] || 0) - (S.minSeats[r.id] || 0)));
        if (room) S.assign.push({ ...p, key: room.id });
        else manual.push({ name: p.name, why: tf('timeline_list_no_room', 'нет номера — отметьте номера или укажите номер в списке') });
    }
    for (const k of new Set(S.assign.map(p => p.key))) S.picks[k] = Math.max(S.picks[k] || 0, minFor(k));
    $('gbSelf').value = S.picks[SELF] || 0;
    S.manual = manual;
    $('gbPeople').value = Math.max(parseInt($('gbPeople').value) || 0,
        S.assign.length + manual.length + S.seats.filter(s => !isRemovable(s)).length);
    showList(false);
    renderRooms();
}

function renderListSummary() {
    const box = $('gbListSummary');
    const a = S.assign || [], m = S.manual || [];
    box.classList.toggle('hidden', !a.length && !m.length);
    if (!a.length && !m.length) return;
    box.innerHTML = `<div class="flex flex-wrap items-center gap-2">
            <span>${e(tf('timeline_list_placed', 'Из списка расставлено'))}: <b>${a.length}</b></span>
            ${m.length ? `<span class="text-error font-medium">⚠ ${e(tf('timeline_list_manual', 'разберите вручную'))}: ${m.length}</span>` : ''}
            <button type="button" class="btn btn-ghost btn-xs ml-auto" data-gb="list">${e(tf('timeline_list_back_to', 'К списку'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-gb="list-clear">${e(tf('timeline_list_clear', 'Убрать список'))}</button>
        </div>
        ${m.length ? `<ul class="mt-1 text-xs list-disc pl-5">${m.map(x => `<li><b>${e(x.name)}</b> — ${e(x.why)}</li>`).join('')}</ul>` : ''}`;
}

// ---------- открыть ----------
async function open(opts = {}) {
    if (!canEdit()) return;
    ensureDialog();
    S = { picks: {}, origPicks: {}, minSeats: {}, occ: new Map(), booking: null, seats: [],
        onSaved: opts.onSaved, datesTouched: false };
    for (const id of ['gbName', 'gbContactName', 'gbContactPhone', 'gbContactTelegram', 'gbNotes', 'gbPeople']) {
        $(id).value = '';
        delete $(id).dataset.manual;
        delete $(id).dataset.auto;
    }
    $('gbBreakfast').checked = $('gbLunch').checked = true;
    $('gbPaste').value = '';
    S.assign = []; S.manual = []; S.listPeople = []; S.rows = null; S.mapSig = null;
    showList(false);
    $('gbTitle').textContent = opts.bookingId
        ? tf('timeline_group_edit', 'Расселение группы')
        : tf('timeline_group_title', 'Регистрация группы');
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

// Человек из списка на месте: карточка из справочника или имя без карточки, свои даты
const personFields = p => ({ vaishnava_id: p.vid || null, guest_name: p.vid ? null : p.name,
    check_in: p.in, check_out: p.out });
const listQueue = () => {
    const q = {};
    for (const p of S.assign || []) (q[p.key] = q[p.key] || []).push(p);
    return q;
};

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
    const queue = listQueue();
    for (const [k, n] of Object.entries(S.picks)) for (let i = 0; i < n; i++) {
        const p = queue[k]?.shift();
        rows.push({ ...seatRow(base, k), ...(p ? personFields(p) : {}) });
    }
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
        // Кто из списка уже встал — второй раз не ставим
        S.assign = (S.assign || []).filter(p => !alreadySeated(p));
        for (const k of new Set(S.assign.map(p => p.key))) S.picks[k] = Math.max(S.picks[k] || 0, minFor(k));
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
    const removed = new Set();
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
        ids.forEach(id => removed.add(id));
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

    // 3б) люди из списка — сначала на безымянные места брони в своём номере
    const queue = listQueue();
    for (const [k, list] of Object.entries(queue)) {
        const free = S.seats.filter(s => (s.room_id || SELF) === k && isRemovable(s) && !removed.has(s.id));
        while (list.length && free.length) {
            const p = list.shift(), seat = free.shift();
            r = await Layout.db.from('residents').update(personFields(p)).eq('id', seat.id);
            if (r.error) return fail(new Error(`${p.name}: ${r.error.message}`));
        }
    }

    // 4) добавить — как у имеющегося места брони; оставшиеся люди списка — на новые места
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
        for (const [k, n] of toAdd) for (let i = 0; i < n; i++) {
            const p = queue[k]?.shift();
            rows.push({ ...seatRow(base, k), ...(p ? personFields(p) : {}) });
        }
        r = await Layout.db.from('residents').insert(rows);
        if (r.error) return fail(r.error);
    }
    return true;
}

return { open };
})();
