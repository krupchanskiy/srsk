// ==================== RETREAT-CALENDAR.JS ====================
// «Расписание» (Управление → между «Ретриты» и «Праздники») — замена Google-таблицы
// «Расписание ретритов ШРСК». Горизонтально, как шахматка (ВГ 20.11.2026): дни слева направо.
// Строки:
//   Праздники        — holidays (без экадаши);
//   Ретриты          — retreats + подтверждённые записи, по которым ещё не заведён ретрит/бронь;
//   Брони групп      — брони из шахматки (без ретрита, от 5 мест или связанные с записью);
//   Предварительно   — записи «Бронь» (tentative), только с view_retreat_plans;
//   Махараджи        — строка на каждого Махараджа из справочника maharajas, у кого есть записи (мигр. 819),
//                      и «Махараджи» без имени; один Махарадж в двух местах одновременно — ⚠;
//   ГД 2-м / 4-м     — сколько номеров Гостевого дома свободно целиком в эту ночь;
//   Аренда           — по строке на арендный дом: свободные номера, когда дом взят.
// Путь записи: Бронь → Подтверждено → «Создать ретрит» (retreats.html?from_plan=) или
// «Забронировать места» (bookings.plan_id). Ответственный от ШРСК получает напоминание в Телеграм
// за 30 дней до «подтвердить до» (tg_retreat_plan_remind, мигр. 819).

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str ?? '');
const tf = (key, fallback) => { const v = Layout.t(key); return !v || v === key ? fallback : v; };

const GUEST_HOUSE_ID = '5fd72663-f118-4be4-80d7-155fb6264af7';   // «Гостевой дом» (как в house-guard.js)
const DW = 40;          // ширина дня, px (как --rc-dw)
const BAR_H = 34;       // высота дорожки
const DAY = 86400000;

const STYLE = {
    confirmed: { c: '#0ea5e9', bg: '#e0f2fe' },
    tentative: { c: '#d97706', bg: '#fde68a' },
    guru:      { c: '#0d9488', bg: '#ccfbf1' },
    note:      { c: '#6b7280', bg: '#f3f4f6' },
    booking:   { c: '#6366f1', bg: '#e0e7ff' },
    rent:      { c: '#78716c', bg: '#f5f5f4' },
    internal:  { c: '#475569', bg: '#cbd5e1' }   // внутренний проект ШРСК (мигр. 820) — один цвет вместо цвета ретрита
};
// DateUtils.monthNames — в родительном падеже («ноября»), для заголовка месяца нужен именительный
const MONTHS = {
    ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
};
const WEEKDAYS = { ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], en: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'], hi: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि'] };

// Окно просмотра — как в шахматке: с сегодняшнего дня (−2), прошлое — кнопкой «‹» или выбором месяца
const MONTHS_TO_SHOW = 12;
let start = null;             // первый показанный день (ISO)
let D = null;                 // загруженные данные окна
let perms = {};
let editing = null;           // открытая запись (или null — новая)
let maharajas = [];           // справочник почётных гостей
let staff = [];               // кого можно назначить ответственным: сотрудники и волонтёры с входом
let attnOpen = false;

// ---------- даты ----------
const iso = d => DateUtils.toISO(d);
const addDays = (s, n) => { const d = DateUtils.parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
const fmt = s => s ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : '';
const todayIso = () => iso(new Date());
const firstOfMonth = s => `${s.slice(0, 7)}-01`;
const addMonths = (s, n) => { const d = DateUtils.parseDate(firstOfMonth(s)); d.setMonth(d.getMonth() + n); return iso(d); };
const yearStart = () => start;
const yearEnd = () => addDays(addMonths(start, MONTHS_TO_SHOW), -1);
const dayIdx = s => Math.round((DateUtils.parseDate(s) - DateUtils.parseDate(start)) / DAY);
const daysInYear = () => dayIdx(yearEnd()) + 1;
const resetStart = () => { start = addDays(todayIso(), -2); };

function hexBg(hex, alpha = 0.22) {
    const c = Utils.isValidColor?.(hex) && /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#10b981';
    const n = parseInt(c.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const capName = c => ({ 1: 'Одноместных', 2: tf('rc_rooms_2', 'Двухместных'), 4: tf('rc_rooms_4', 'Четырёхместных') }[c] || `${c}-местных`);
// Трёхместных номеров нет: «два плюс один» (№3, 7, 8, 17) — двухместный с доп. кроватью (ВГ 20.11)
const typeOf = c => c === 3 ? 2 : c;

// Арендный дом взят на эту дату — только по периодам аренды (или «доступно с/по»).
// Без единого периода — НЕ взят (Utils.buildingAvailable в этом случае разрешает бронь,
// но для Расписания это давало «дом взят весь год», ВГ 20.11)
function rentedOn(b, date) {
    const periods = b.building_rental_periods?.length ? b.building_rental_periods
        : (b.available_from && b.available_until ? [{ date_from: b.available_from, date_to: b.available_until }] : []);
    return periods.some(p => p.date_from <= date && date <= p.date_to);
}

// ---------- загрузка ----------
async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await build().range(from, from + 999);
        if (error) throw error;
        out.push(...(data || []));
        if (!data || data.length < 1000) return out;
    }
}

async function load() {
    const ys = yearStart(), ye = yearEnd();
    const [hol, ret, plans, books, rooms, overlaps] = await Promise.all([
        Layout.db.from('holidays').select('date, name_ru, name_en, name_hi, type')
            .gte('date', ys).lte('date', ye).neq('type', 'ekadashi').order('date'),
        Layout.db.from('retreats').select('id, name_ru, name_en, name_hi, start_date, end_date, color, is_external, is_internal, occupies_guesthouse, rooms_2_needed, rooms_4_needed')
            .lte('start_date', ye).gte('end_date', ys).order('start_date'),
        Layout.db.from('retreat_plans').select('*').lte('start_date', ye).gte('end_date', ys).order('start_date'),
        Layout.db.from('bookings').select('id, name, contact_name, contact_phone, check_in, check_out, beds_count, retreat_id, plan_id, status, notes')
            .neq('status', 'cancelled').lte('check_in', ye).gte('check_out', ys),
        // Номера Гостевого дома и арендных домов (резерв — только аренда, решение ВГ 20.11)
        Layout.db.from('rooms').select('id, capacity, building_id, buildings!inner(id, name_ru, name_en, name_hi, is_temporary, is_active, available_from, available_until, building_rental_periods(date_from, date_to))')
            .eq('is_active', true).eq('buildings.is_active', true),
        // Брони Гостевого дома на ночах ретрита «весь ГД», ещё не решённые — та же проверка, что плашка шахматки
        window.HouseGuard ? HouseGuard.pending().catch(() => []) : []
    ]);
    for (const r of [hol, ret, plans, books, rooms]) if (r.error) throw r.error;

    const gdRooms = rooms.data.filter(r => r.building_id === GUEST_HOUSE_ID);
    const rentRooms = rooms.data.filter(r => r.buildings.is_temporary);
    const ids = [...gdRooms, ...rentRooms].map(r => r.id);
    const res = ids.length ? await fetchAll(() => Layout.db.from('residents').select('room_id, check_in, check_out, retreat_id')
        .in('room_id', ids).neq('status', 'cancelled')
        .lte('check_in', ye).or(`check_out.is.null,check_out.gt.${ys}`)) : [];

    // Номер занят в ночь d, если check_in <= d < check_out; свободный — без единого человека
    const n = daysInYear();
    const busy = Array.from({ length: n }, () => new Set());
    for (const r of res) {
        const a = Math.max(0, dayIdx(r.check_in));
        const b = r.check_out ? Math.min(n, dayIdx(r.check_out)) : n;
        for (let d = a; d < b; d++) busy[d].add(r.room_id);
    }
    // По ночам: свободные номера ГД по вместимости; аренда — только дома, взятые на эту дату
    const gd = [], rent = [];
    for (let d = 0; d < n; d++) {
        const date = addDays(ys, d);
        const g = {};
        for (const r of gdRooms) if (!busy[d].has(r.id)) g[typeOf(r.capacity)] = (g[typeOf(r.capacity)] || 0) + 1;
        gd.push(g);
        const byCap = {}, byBld = {};
        for (const r of rentRooms) {
            if (busy[d].has(r.id) || !rentedOn(r.buildings, date)) continue;
            byCap[typeOf(r.capacity)] = (byCap[typeOf(r.capacity)] || 0) + 1;
            const name = Layout.getName(r.buildings);
            byBld[name] = (byBld[name] || 0) + 1;
        }
        rent.push({ byCap, byBld });
    }
    const caps = {};
    for (const r of gdRooms) caps[typeOf(r.capacity)] = (caps[typeOf(r.capacity)] || 0) + 1;

    // Предварительно (ВГ 20.11, мигр. 821): ретрит не на весь ГД, но с числом нужных номеров —
    // в его ночи эти номера вычитаются из свободных. Номера ГД, где его люди уже стоят в шахматке,
    // не вычитаются второй раз. Не хватает — ⚠ в строке ГД и в «Требуют внимания».
    const gdType = new Map(gdRooms.map(r => [r.id, typeOf(r.capacity)]));
    const hold = Array.from({ length: n }, () => []);   // ночь → [{ retreat, c, k }]
    const short = [];                                     // { retreat, c, need, free, date }
    for (const rt of ret.data) {
        if (rt.occupies_guesthouse || !(rt.rooms_2_needed || rt.rooms_4_needed)) continue;
        const last = rt.end_date > rt.start_date ? addDays(rt.end_date, -1) : rt.start_date;
        const worst = {};
        for (let d = Math.max(0, dayIdx(rt.start_date)); d <= Math.min(n - 1, dayIdx(last)); d++) {
            const placed = {};
            for (const r of res) {
                if (r.retreat_id !== rt.id || !gdType.has(r.room_id)) continue;
                const a = dayIdx(r.check_in), b = r.check_out ? dayIdx(r.check_out) : n;
                if (a <= d && d < b) placed[gdType.get(r.room_id)] = (placed[gdType.get(r.room_id)] ||= new Set()).add(r.room_id);
            }
            // Лишний четырёхместный, уже занятый людьми ретрита, закрывает нужду в двухместном
            const extra4 = Math.max(0, (placed[4]?.size || 0) - (rt.rooms_4_needed || 0));
            for (const c of [2, 4]) {
                const need = rt[`rooms_${c}_needed`] || 0;
                const k = Math.max(0, need - (placed[c]?.size || 0) - (c === 2 ? extra4 : 0));
                if (!k) continue;
                const free = gd[d][c] || 0;
                hold[d].push({ retreat: rt, c, k });
                gd[d][c] = free - k;
                if (free < k && (!worst[c] || free < worst[c].free)) worst[c] = { retreat: rt, c, need: k, free, date: addDays(ys, d) };
            }
        }
        short.push(...Object.values(worst));
    }
    D = {
        holidays: hol.data, retreats: ret.data, plans: plans.data, bookings: books.data,
        gd, rent, gdCaps: caps,
        // Только дома, взятые хотя бы на одну ночь показанного года
        hold, short,
        rentRooms: rentRooms.reduce((m, r) => { const k = Layout.getName(r.buildings); m[k] = (m[k] || 0) + 1; return m; }, {}), free: gd.map(g => Object.values(g).reduce((a, b) => a + b, 0)),
        totalRooms: gdRooms.length, overlaps
    };
    // Ночи пересечения (для ⚠ в колонке «Гостевой дом») и брони с пересечением (для обводки)
    D.crossNights = new Map();
    D.crossBookings = new Set();
    for (const o of overlaps.filter(o => o.kind === 'cross')) {
        if (o.booking_id) D.crossBookings.add(o.booking_id);
        for (let d = o.from; d < o.to; d = addDays(d, 1)) {
            const i = dayIdx(d);
            if (i < 0 || i >= n) continue;
            if (!D.crossNights.has(i)) D.crossNights.set(i, []);
            D.crossNights.get(i).push(o);
        }
    }
}

// Запись расписания (группа/ретрит, не отменена, без своего ретрита) на днях ретрита «весь ГД»
function planHouseClash(p) {
    if (p.kind !== 'event' || p.status === 'cancelled') return null;
    return D.retreats.find(r => r.occupies_guesthouse && r.id !== p.retreat_id
        && r.start_date <= p.end_date && p.start_date <= r.end_date) || null;
}

// ⚠ сверху: сколько пересечений и каких; клик ведёт к исправлению (шахматка / окно записи)
function renderAlerts() {
    const box = document.getElementById('rcAlerts');
    const cross = D.overlaps.filter(o => o.kind === 'cross');
    const close = D.overlaps.filter(o => o.kind !== 'cross');
    const plans = D.plans.map(p => ({ p, r: planHouseClash(p) })).filter(x => x.r);
    const link = o => `<a class="link link-hover font-medium" href="../placement/timeline.html?resident=${encodeURIComponent(o.ids[0])}&date=${o.check_in}">${e(o.who || 'Без имени')}</a>`;
    const parts = [];
    if (cross.length) parts.push(`<div class="text-error"><b>⚠ Бронь на днях ретрита «весь Гостевой дом»: ${cross.length}</b> — ` +
        cross.map(o => `${link(o)} <span>(№${e(o.room)}, ${fmt(o.from)}→${fmt(o.to)}, «${e(Layout.getName(o.retreat))}», ${HouseGuard.ruNights(o.nights)})</span>`).join(' · ') + '</div>');
    if (plans.length) parts.push(`<div class="text-error"><b>⚠ Записи расписания на днях ретрита «весь Гостевой дом»: ${plans.length}</b> — ` +
        plans.map(({ p, r }) => `<a class="link link-hover font-medium" data-open-plan="${p.id}">${e(p.title)}</a> <span>(${fmt(p.start_date)}–${fmt(p.end_date)}, «${e(Layout.getName(r))}»)</span>`).join(' · ') + '</div>');
    if (close.length) parts.push(`<div><b>ℹ Впритык к ретриту: ${close.length}</b> — ` +
        close.map(o => `${link(o)} <span>(№${e(o.room)}: ${e(o.text)})</span>`).join(' · ') + '</div>');
    if (parts.length) parts.push(`<div class="text-xs">Если всё согласовано — в шахматке нажмите «Оставить как есть», и предупреждение уйдёт.</div>`);
    box.innerHTML = parts.join('');
    box.classList.toggle('hidden', !parts.length);
}

// ---------- записи и пересечения ----------
const personName = v => v ? (v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim()) : '';
const staffName = id => personName(staff.find(s => s.id === id)) || '';
const maharajaName = id => (id && maharajas.find(m => m.id === id)?.name) || tf('rc_maharajas', 'Махараджи');
const overlap = (a, b) => a.start_date <= b.end_date && b.start_date <= a.end_date;

// Один Махарадж в двух записях одновременно (кроме отменённых): id записи → другие записи
function maharajaClashes() {
    const out = new Map();
    const guru = D.plans.filter(p => p.kind === 'guru' && p.maharaja_id && p.status !== 'cancelled');
    for (let i = 0; i < guru.length; i++) for (let j = i + 1; j < guru.length; j++) {
        const a = guru[i], b = guru[j];
        if (a.maharaja_id !== b.maharaja_id || !overlap(a, b)) continue;
        (out.get(a.id) || out.set(a.id, []).get(a.id)).push(b);
        (out.get(b.id) || out.set(b.id, []).get(b.id)).push(a);
    }
    return out;
}

function planMeta(p) {
    const parts = [];
    if (p.status === 'tentative' && p.confirm_by) {
        const over = p.confirm_by < todayIso();
        parts.push(`<span class="${over ? 'overdue' : ''}">${over ? '⚠ ' : ''}до ${fmt(p.confirm_by)}</span>`);
    }
    const types = [2, 4].filter(c => p['rooms_' + c]).map(c => `${c}м×${p['rooms_' + c]}`).join(' ');
    const nums = [p.people_count ? `${p.people_count} чел.` : '', types || (p.rooms_count ? `${p.rooms_count} ном.` : '')].filter(Boolean).join(' · ');
    if (nums) parts.push(e(nums));
    const linked = D.bookings.filter(b => b.plan_id === p.id);
    if (linked.length) parts.push(e(`${tf('rc_booked_places', 'В шахматке')}: ${linked.reduce((s, b) => s + (b.beds_count || 0), 0)} мест`));
    if (p.kind === 'event' && p.status !== 'cancelled')
        parts.push(p.responsible_id ? e('отв. ' + staffName(p.responsible_id)) : `<span class="overdue">отв. —</span>`);
    return parts.join(' · ');
}

// Строки доски: { key, label, cls, items[] } — items: { key, src, id, s, e, title, meta, cls, c, bg, conflict, tip }
function buildRows() {
    const showCancelled = document.getElementById('rcShowCancelled').checked;
    const visiblePlans = D.plans.filter(p => showCancelled || p.status !== 'cancelled');
    const plansById = new Map(D.plans.map(p => [p.id, p]));
    const mClash = maharajaClashes();
    const rows = { retreats: [], bookings: [], tentative: [], notes: [] };
    const guruRows = new Map();   // maharaja_id ('' — без имени) → items

    for (const r of D.retreats) {
        const c = Utils.isValidColor?.(r.color) ? r.color : '#10b981';
        const look = r.is_internal ? STYLE.internal : { c, bg: hexBg(c) };
        // Не весь ГД — сколько номеров нужно (мигр. 821): «2м×24 4м×1»
        const need = r.occupies_guesthouse ? '' : [2, 4].filter(c => r[`rooms_${c}_needed`]).map(c => `${c}м×${r[`rooms_${c}_needed`]}`).join(' ');
        const meta = [r.is_internal ? e(tf('rc_internal', 'внутренний')) : '', r.occupies_guesthouse ? e(tf('rc_whole_house', 'весь ГД')) : '',
            need ? e('нужно ' + need) : ''].filter(Boolean).join(' · ');
        rows.retreats.push({ key: 'r' + r.id, src: 'retreat', id: r.id, s: r.start_date, e: r.end_date,
            title: Layout.getName(r), meta, cls: '', ...look,
            tip: `${Layout.getName(r)} · ${fmt(r.start_date)}–${fmt(r.end_date)}` + (need ? '\nНужно номеров ГД:' +
                [2, 4].filter(c => r[`rooms_${c}_needed`]).map(c => `\n  ${c}х — ${roomsWord(r[`rooms_${c}_needed`])}`).join('') : '') });
    }
    for (const p of visiblePlans) {
        // Подтверждённая запись стала ретритом или бронью группы — показывается то, во что превратилась
        if (p.status === 'confirmed' && p.kind === 'event') {
            if (p.retreat_id && D.retreats.some(r => r.id === p.retreat_id)) continue;
            if (D.bookings.some(b => b.plan_id === p.id)) continue;
        }
        const st = p.kind === 'guru' ? STYLE.guru : p.kind === 'note' ? STYLE.note : (STYLE[p.status] || STYLE.tentative);
        const clash = planHouseClash(p);
        const twice = mClash.get(p.id);
        const conflict = !!clash || !!twice || D.bookings.some(b => b.plan_id === p.id && D.crossBookings.has(b.id));
        const warn = clash ? `<span class="warn">⚠ весь ГД: «${e(Layout.getName(clash))}»</span>`
            : twice ? `<span class="warn">⚠ в это время: ${twice.map(x => e(x.title)).join(', ')}</span>` : '';
        const item = { key: 'p' + p.id, src: 'plan', id: p.id, s: p.start_date, e: p.end_date, title: p.title, conflict,
            meta: [warn, p.kind === 'note' ? '' : planMeta(p)].filter(Boolean).join(' · '),
            cls: p.status === 'confirmed' ? '' : p.status, c: st.c, bg: st.bg };
        if (p.kind === 'guru') {
            const k = p.maharaja_id || '';
            if (!guruRows.has(k)) guruRows.set(k, []);
            guruRows.get(k).push(item);
        } else if (p.kind === 'note') rows.notes.push(item);
        else if (p.status === 'confirmed') rows.retreats.push(item);
        else rows.tentative.push(item);
    }
    // Брони групп из шахматки: без ретрита (люди ретрита — под самим ретритом); связанные с записью «Бронь» —
    // внутри неё («В шахматке: N мест»), с подтверждённой — сами; прочие — от 5 мест
    for (const b of D.bookings) {
        if (b.retreat_id) continue;
        const pl = b.plan_id && plansById.get(b.plan_id);
        if (pl && pl.status !== 'confirmed') continue;
        if (!b.plan_id && (b.beds_count || 0) < 5) continue;
        const cross = D.crossBookings.has(b.id);
        rows.bookings.push({ key: 'b' + b.id, src: 'booking', id: b.id, s: b.check_in, e: b.check_out,
            title: b.name || b.contact_name || '—', conflict: cross,
            meta: (cross ? `<span class="warn">⚠ на днях ретрита «весь ГД»</span> · ` : '') + `${b.beds_count || 0} мест`,
            cls: '', ...STYLE.booking });
    }

    const out = [
        { key: 'retreats', label: tf('rc_row_retreats', 'Ретриты'), col: 'event', items: rows.retreats },
        { key: 'bookings', label: tf('rc_row_bookings', 'Брони групп'), col: 'tentative', items: rows.bookings }
    ];
    if (perms.seePlans) out.push({ key: 'tentative', label: tf('rc_row_tentative', 'Предварительно'), col: 'tentative', items: rows.tentative });
    // Махараджи: только у кого есть записи в окне; по порядку справочника, «без имени» — последним
    const order = id => id ? (maharajas.find(m => m.id === id)?.sort_order ?? 999) : 10000;
    const guruKeys = [...guruRows.keys()].sort((a, b) => order(a) - order(b) || maharajaName(a).localeCompare(maharajaName(b)));
    guruKeys.forEach((k, i) => out.push({ key: 'g' + k, label: k ? maharajaName(k) : tf('rc_maharajas', 'Махараджи') + ' (без имени)',
        cls: 'sub', col: 'guru', maharaja: k, items: guruRows.get(k), groupTop: i === 0 }));
    if (perms.edit && !guruKeys.length) out.push({ key: 'g', label: tf('rc_maharajas', 'Махараджи'), cls: 'sub', col: 'guru', maharaja: '', items: [], groupTop: false });
    if (rows.notes.length) out.push({ key: 'notes', label: tf('rc_row_notes', 'Заметки'), col: 'note', items: rows.notes });
    for (const r of out) assignLanes(r.items);
    return out;
}

// Дорожки: пересекающиеся полосы — друг под другом (как в шахматке); строка растёт по числу дорожек
function assignLanes(items) {
    const n = daysInYear();
    items.forEach(it => { it.a = Math.max(0, dayIdx(it.s)); it.b = Math.min(n - 1, dayIdx(it.e)); });
    items.sort((x, y) => x.a - y.a || y.b - x.b);
    const ends = [];
    for (const it of items) {
        let lane = ends.findIndex(end => end < it.a);
        if (lane === -1) { lane = ends.length; ends.push(it.b); } else ends[lane] = it.b;
        it.lane = lane;
    }
    items.lanes = Math.max(1, ends.length);
}

// ---------- «Требуют внимания» ----------
function attentionItems() {
    const today = todayIso();
    const list = [];
    const open = p => `<a class="link link-hover font-medium" data-open-plan="${p.id}">${e(p.title)}</a>`;
    const dates = p => `${fmt(p.start_date)}–${fmt(p.end_date)}`;
    const active = D.plans.filter(p => p.status !== 'cancelled' && p.end_date >= today);
    for (const p of active) {
        if (p.kind === 'event' && p.status === 'tentative' && p.confirm_by && p.confirm_by < today)
            list.push(`${open(p)} (${dates(p)}) — «подтвердить до» ${fmt(p.confirm_by)} прошло: подтвердите или отмените`);
        if (p.kind === 'event' && !p.responsible_id)
            list.push(`${open(p)} (${dates(p)}) — нет ответственного`);
        const clash = planHouseClash(p);
        if (clash) list.push(`${open(p)} (${dates(p)}) — на днях ретрита «${e(Layout.getName(clash))}» (весь Гостевой дом)`);
        if (p.kind === 'event' && p.status === 'confirmed' && !p.retreat_id && !D.bookings.some(b => b.plan_id === p.id))
            list.push(`${open(p)} (${dates(p)}) — подтверждено: создайте ретрит или забронируйте места`);
    }
    const mc = maharajaClashes();
    const seen = new Set();
    for (const [id, others] of mc) {
        const p = D.plans.find(x => x.id === id);
        if (!p || p.end_date < today) continue;
        for (const o of others) {
            const k = [id, o.id].sort().join();
            if (seen.has(k)) continue;
            seen.add(k);
            list.push(`${e(maharajaName(p.maharaja_id))} в двух местах одновременно: ${open(p)} (${dates(p)}) и ${open(o)} (${dates(o)})`);
        }
    }
    for (const x of D.short)
        list.push(`<a class="link link-hover font-medium" href="retreats.html?retreat=${encodeURIComponent(x.retreat.id)}">${e(Layout.getName(x.retreat))}</a> (${fmt(x.retreat.start_date)}–${fmt(x.retreat.end_date)}) — не хватает ${x.c === 2 ? 'двухместных' : 'четырёхместных'} номеров ГД: нужно ${x.need}, на ${fmt(x.date)} свободно ${x.free}`);
    for (const o of D.overlaps.filter(o => o.kind === 'cross'))
        list.push(`Бронь <a class="link link-hover font-medium" href="../placement/timeline.html?resident=${encodeURIComponent(o.ids[0])}&date=${o.check_in}">${e(o.who || 'Без имени')}</a> (№${e(o.room)}, ${fmt(o.from)}→${fmt(o.to)}) — на днях ретрита «${e(Layout.getName(o.retreat))}» (весь Гостевой дом)`);
    return list;
}

function renderAttention() {
    const list = attentionItems();
    const cnt = document.getElementById('rcAttnCount');
    cnt.textContent = list.length;
    cnt.className = 'badge badge-sm ' + (list.length ? 'badge-error' : '');
    const box = document.getElementById('rcAttn');
    box.innerHTML = list.length
        ? `<div class="font-semibold mb-1">⚠ ${e(tf('rc_attention', 'Требуют внимания'))}: ${list.length}</div>` + list.map(x => `<div>• ${x}</div>`).join('')
        : `<div class="opacity-80">Всё в порядке: сроки не просрочены, у всех записей есть ответственный, пересечений нет.</div>`;
    box.classList.toggle('hidden', !attnOpen);
}

// ---------- отрисовка ----------
function render() {
    renderMonthPicker();
    const rows = buildRows();
    const lang = Layout.currentLang || 'ru';
    const wd = WEEKDAYS[lang] || WEEKDAYS.ru;
    const monthNames = MONTHS[lang] || MONTHS.ru;
    const n = daysInYear();
    const W = n * DW;
    const today = todayIso();
    const px = i => i * DW;

    // Шапка: месяцы и дни
    let months = '', days = '', shade = '';
    for (let d = 0; d < n;) {
        const dt = DateUtils.parseDate(addDays(start, d));
        const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0);
        const len = Math.min(n - 1, dayIdx(iso(last))) - d + 1;
        months += `<div class="rc-mon" style="width:${len * DW}px"><span>${e(monthNames[dt.getMonth()] || '')} ${dt.getFullYear()}</span></div>`;
        d += len;
    }
    for (let d = 0; d < n; d++) {
        const date = addDays(start, d), dt = DateUtils.parseDate(date), dow = dt.getDay();
        const we = dow === 0 || dow === 6, isToday = date === today, m1 = dt.getDate() === 1 && d > 0;
        days += `<div class="rc-dd ${we ? 'we' : ''} ${isToday ? 'today' : ''} ${m1 ? 'm1' : ''}" ${isToday ? 'id="rcToday"' : ''}><b>${dt.getDate()}</b>${e(wd[dow])}</div>`;
        if (we || isToday || m1) shade += `<div class="rc-shade ${isToday ? 'today' : we ? 'we' : ''} ${m1 ? 'm1' : ''}" style="left:${px(d)}px;width:${DW}px"></div>`;
    }

    const bar = it => `<div class="rc-bar ${it.cls} ${it.conflict ? 'conflict' : ''}" data-open="${it.key}"
        style="--c:${it.c};--bg:${it.bg};left:${px(it.a) + 1}px;width:${(it.b - it.a + 1) * DW - 2}px;top:${it.lane * BAR_H + 3}px"
        title="${e(it.tip || `${it.title} · ${fmt(it.s)}–${fmt(it.e)}`)}"><span><b>${e(it.title)}</b>${it.meta ? ' · ' + it.meta : ''}</span></div>`;
    const line = (label, inner, h, opts = {}) => `<div class="rc-line" ${opts.attrs || ''}>
        <div class="rc-lab ${opts.cls || ''}" style="height:${h}px" title="${e(label)}">${opts.labelHtml || e(label)}</div>
        <div class="rc-track" style="width:${W}px;height:${h}px" ${opts.trackAttrs || ''}>${shade}${inner}</div></div>`;

    let html = `<div class="rc-inner" style="width:calc(var(--rc-lab) + ${W}px)">
        <div class="rc-head">
            <div class="rc-line rc-months"><div class="rc-lab"></div><div class="rc-track" style="width:${W}px">${months}</div></div>
            <div class="rc-line rc-days"><div class="rc-lab text-xs">${e(tf('rc_col_date', 'Дата'))}</div><div class="rc-track" style="width:${W}px">${days}</div></div>
        </div>`;

    // Праздники: подписи вправо от дня; близкие — на разные дорожки (по ширине текста)
    const hols = D.holidays.map(h => {
        const a = dayIdx(h.date), name = Layout.getName(h);
        return { a, b: a + Math.max(1, Math.ceil((name.length * 7.5 + 10) / DW)) - 1, name, major: h.type === 'major' };
    }).sort((x, y) => x.a - y.a);
    const hEnds = [];
    for (const h of hols) { let l = hEnds.findIndex(x => x < h.a); if (l === -1) { l = hEnds.length; hEnds.push(h.b); } else hEnds[l] = h.b; h.lane = l; }
    const holH = Math.max(1, hEnds.length) * 24 + 6;
    const holDays = new Map();
    for (const h of hols) holDays.set(h.a, holDays.get(h.a) || h.major);
    const holFill = [...holDays].map(([a, major]) => `<div class="rc-holday ${major ? 'major' : ''}" style="left:${px(a)}px"></div>`).join('');
    html += line(tf('rc_row_holidays', 'Праздники'), holFill + hols.map(h =>
        `<div class="rc-hol ${h.major ? 'major' : ''}" style="left:${px(h.a)}px;top:${h.lane * 24 + 3}px" title="${e(h.name)}">${e(h.name)}</div>`).join(''), holH, { cls: 'group' });

    const editable = perms.edit ? 'data-new' : '';
    for (const r of rows) {
        const h = r.items.lanes * BAR_H + 6;
        // Над первой строкой Махараджей — подпись группы
        const labelHtml = r.col === 'guru' && r.groupTop
            ? `<div><div class="text-[10px] uppercase tracking-wide opacity-70">${e(tf('rc_maharajas', 'Махараджи'))}</div>${e(r.label)}</div>` : '';
        html += line(r.label, r.items.map(bar).join(''), h, {
            labelHtml, cls: r.cls || 'group',
            trackAttrs: `${editable} data-col="${r.col}" data-maharaja="${r.maharaja ?? ''}"`
        });
    }

    // Гостевой дом: свободные номера целиком по типам; «весь ГД» — ретрит занимает дом; ⚠ — пересечение
    const wholeHouse = D.retreats.filter(r => r.occupies_guesthouse);
    for (const c of [2, 4]) {
        if (!D.gdCaps[c]) continue;
        let cells = '';
        for (let d = 0; d < n; d++) {
            const date = addDays(start, d);
            const whole = wholeHouse.find(r => r.start_date <= date && date <= r.end_date);
            const f = D.gd[d][c] || 0, all = D.gdCaps[c];
            const cross = D.crossNights.get(d);
            const held = D.hold[d].filter(h => h.c === c);
            const cls = whole ? 'whole' : f <= 0 ? 'no' : f / all < 0.3 ? 'lo' : 'ok';
            const tip = whole ? `Ретрит «${Layout.getName(whole)}» — весь Гостевой дом`
                : `${capName(c)} свободно целиком: ${Math.max(0, f)} из ${all}` + (held.length
                    ? `\nПредварительно под ретриты: ${held.map(h => `«${Layout.getName(h.retreat)}» — ${h.k}`).join(', ')}`
                      + (f < 0 ? `\n⚠ Не хватает: ${-f}` : '') : '');
            const crossTip = cross ? '\n⚠ ' + cross.map(o => `№${o.room} ${o.who || ''} — «${Layout.getName(o.retreat)}»`).join('; ') : '';
            cells += `<div class="rc-num ${cls} ${cross ? 'cross' : ''} ${held.length ? 'held' : ''}" style="left:${px(d)}px" title="${e(tip + crossTip)}">${whole ? (cross ? '⚠' : 'весь') : f < 0 ? `⚠${f}` : f}</div>`;
        }
        html += line(tf(c === 2 ? 'rc_row_gd2' : 'rc_row_gd4', c === 2 ? 'ГД двухместные' : 'ГД четырёхместные') + ` (${D.gdCaps[c]})`, cells, 34, { cls: 'sub' });
    }
    // Аренда: одна строка, полоса на каждый непрерывный срок, когда гостиница снята (ВГ 20.11);
    // пересекающиеся сроки разных гостиниц — друг под другом
    const rentBars = [];
    for (const name of Object.keys(D.rentRooms).sort()) {
        for (let d = 0; d < n; d++) {
            if (D.rent[d].byBld[name] === undefined) continue;
            let end = d;
            while (end + 1 < n && D.rent[end + 1].byBld[name] !== undefined) end++;
            const free = D.rent.slice(d, end + 1).map(x => x.byBld[name]);
            const lo = Math.min(...free), hi = Math.max(...free), all = D.rentRooms[name];
            const s0 = addDays(start, d), e0 = addDays(start, end);
            rentBars.push({ key: 'rent' + name + d, src: 'rent', s: s0, e: e0, title: name, cls: 'rent', ...STYLE.rent,
                meta: e(`${all} ном.`) + (lo < all ? ` · <span class="${lo ? '' : 'warn'}">свободно ${lo === hi ? lo : `${lo}–${hi}`}</span>` : ''),
                tip: `${name}: снята ${fmt(s0)}–${fmt(e0)}, номеров ${all}, свободно целиком ${lo === hi ? lo : `от ${lo} до ${hi}`}` });
            d = end;
        }
    }
    if (rentBars.length) {
        assignLanes(rentBars);
        html += line(tf('rc_row_rent', 'Аренда'), rentBars.map(bar).join(''), rentBars.lanes * BAR_H + 6, { cls: 'group' });
    }
    html += '</div>';
    const board = document.getElementById('rcBoard');
    board.innerHTML = html;
    if (!document.body.classList.contains('board-fullscreen')) board.style.maxHeight = 'calc(100vh - 260px)';
    D.items = Object.fromEntries(rows.flatMap(r => r.items).map(it => [it.key, it]));
}

function renderLegend() {
    const sw = (st, cls, label) => `<span><span class="sw ${cls}" style="--c:${st.c};--bg:${st.bg}"></span>${e(label)}</span>`;
    let html = sw({ c: '#10b981', bg: hexBg('#10b981') }, '', 'Ретрит') +
        sw(STYLE.internal, '', 'Внутренний проект ШРСК') +
        sw(STYLE.confirmed, '', tf('rc_status_confirmed', 'Подтверждено') + ' (ещё не ретрит)') +
        sw(STYLE.booking, '', 'Бронь группы в шахматке');
    if (perms.seePlans) html += sw(STYLE.tentative, 'tentative', tf('rc_status_tentative', 'Бронь') + ' (предварительно)');
    html += sw(STYLE.guru, '', tf('rc_maharajas', 'Махараджи'));
    html += `<span><span class="sw" style="--c:#dc2626;--bg:#fff;border-width:2px"></span>⚠ пересечение</span>`;
    html += `<span class="opacity-80 basis-full">Числа в строках ГД — сколько номеров этого типа свободно целиком в эту ночь (в скобках — всего; «два плюс один» — двухместные). Жёлтый — меньше трети, красный — ни одного. Подчёркнутое число — уже за вычетом номеров, нужных ретритам (предварительно, пока их люди не стоят в шахматке); «⚠−3» — трёх не хватает. Аренда — гостиницы, которые ШРСК снимает: полоса на срок аренды, при наведении — сколько номеров свободно.</span>`;
    document.getElementById('rcLegend').innerHTML = html;
}

const scrollTop = () => { const b = document.getElementById('rcBoard'); b.scrollTop = 0; b.scrollLeft = 0; };

function goTo(isoDate) {
    start = isoDate;
    reload(false).then(scrollTop);
}

// Быстрый переход к месяцу — как в шахматке: год назад … два вперёд
function renderMonthPicker() {
    const sel = document.getElementById('rcMonth');
    const lang = Layout.currentLang || 'ru';
    const cur = firstOfMonth(start);
    const keys = new Set();
    for (let i = -12; i <= 24; i++) keys.add(addMonths(todayIso(), i));
    keys.add(cur);
    sel.innerHTML = [...keys].sort().map(k =>
        `<option value="${k}" ${k === cur ? 'selected' : ''}>${e((MONTHS[lang] || MONTHS.ru)[+k.slice(5, 7) - 1])} ${k.slice(0, 4)}</option>`).join('');
}

// Поиск по названию во всём расписании (и в прошлом): ретриты, записи, брони групп → переход к дате
async function search(q) {
    const box = document.getElementById('rcSearchResults');
    q = q.trim();
    if (q.length < 2) { box.classList.add('hidden'); return; }
    const like = `%${q.replace(/[%_,()]/g, ' ')}%`;
    const [r, p, b] = await Promise.all([
        Layout.db.from('retreats').select('name_ru, name_en, name_hi, start_date, end_date')
            .or(`name_ru.ilike.${like},name_en.ilike.${like}`).order('start_date', { ascending: false }).limit(8),
        Layout.db.from('retreat_plans').select('title, start_date, end_date, status').ilike('title', like)
            .order('start_date', { ascending: false }).limit(8),
        Layout.db.from('bookings').select('name, check_in, check_out').neq('status', 'cancelled').ilike('name', like)
            .order('check_in', { ascending: false }).limit(8)
    ]);
    const rows = [
        ...(r.data || []).map(x => ({ name: Layout.getName(x), s: x.start_date, e: x.end_date, kind: 'Ретрит' })),
        ...(p.data || []).map(x => ({ name: x.title, s: x.start_date, e: x.end_date, kind: tf('rc_status_' + x.status, { plan: 'План', tentative: 'Предварительно', confirmed: 'Подтверждено', cancelled: 'Отменено' }[x.status]) })),
        ...(b.data || []).map(x => ({ name: x.name, s: x.check_in, e: x.check_out, kind: 'Бронь' }))
    ].sort((a, c) => c.s.localeCompare(a.s)).slice(0, 12);
    box.innerHTML = rows.length ? rows.map(x => `<button type="button" class="w-full text-left px-3 py-2 hover:bg-base-200 text-sm flex justify-between gap-3"
            data-action="search-pick" data-date="${x.s}">
            <span><b>${e(x.name)}</b> <span class="opacity-70">· ${e(x.kind)}</span></span>
            <span class="whitespace-nowrap opacity-80">${fmt(x.s)}.${x.s.slice(2, 4)} – ${fmt(x.e)}.${x.e.slice(2, 4)}</span></button>`).join('')
        : `<div class="px-3 py-2 text-sm opacity-70">Ничего не найдено</div>`;
    box.classList.remove('hidden');
}

async function reload(keepScroll = true) {
    const wrap = document.getElementById('rcBoard');
    const top = wrap.scrollTop, left = wrap.scrollLeft;
    try {
        await load();
    } catch (err) {
        Layout.handleError(err, 'Расписание');
        return;
    }
    render();
    renderLegend();
    renderAlerts();
    renderAttention();
    if (keepScroll) { wrap.scrollTop = top; wrap.scrollLeft = left; }
}

// ---------- окно записи ----------
const form = () => document.getElementById('planForm');

function toggleKindFields() {
    const kind = form().kind.value;
    document.querySelectorAll('#planForm [data-event-only]').forEach(el => el.classList.toggle('hidden', kind !== 'event'));
    document.querySelectorAll('#planForm [data-guru-only]').forEach(el => el.classList.toggle('hidden', kind !== 'guru'));
    checkLoad();
}

// Предупреждение при планировании: сколько номеров ГД свободно на эти ночи и нет ли ретрита «весь ГД»
function checkLoad() {
    const f = form(), box = document.getElementById('planLoadWarn');
    const s = f.start_date.value, en = f.end_date.value;
    const msgs = [];
    if (s && en && en >= s && f.kind.value === 'event') {
        const lastNight = en > s ? addDays(en, -1) : s;
        // По каждому типу — самая тесная ночь: сколько свободно в ГД и в аренде
        const need = { 2: +f.rooms_2.value || 0, 4: +f.rooms_4.value || 0 };
        const minGd = {}, minDate = {}, minRent = {};
        let spare2 = null, rentBld = null, nights = 0;
        for (let d = s; d <= lastNight; d = addDays(d, 1)) {
            if (d < yearStart() || d > yearEnd()) continue;
            const i = dayIdx(d);
            nights++;
            for (const c of [2, 4]) {
                const g = Math.max(0, D.gd[i][c] || 0), r = D.rent[i].byCap[c] || 0;
                if (minGd[c] === undefined || g < minGd[c]) { minGd[c] = g; minDate[c] = d; }
                if (minRent[c] === undefined || r < minRent[c]) minRent[c] = r;
            }
            const s2 = Math.max(0, D.gd[i][2] || 0) - need[2];
            if (spare2 === null || s2 < spare2) spare2 = s2;
            // Аренда, которая есть на ВСЕ ночи записи — с наименьшим числом свободных за срок
            const bld = D.rent[i].byBld;
            rentBld = rentBld === null ? { ...bld } : Object.fromEntries(Object.entries(rentBld)
                .filter(([b]) => bld[b]).map(([b, k]) => [b, Math.min(k, bld[b])]));
        }
        // Свои места этой записи уже стоят в шахматке — тогда их бы посчитали занятыми, сверка не нужна
        const own = editing ? D.bookings.filter(b => b.plan_id === editing.id).length : 0;
        const short = [2, 4].filter(c => need[c] && nights && minGd[c] < need[c]);
        if (short.length && !own) {
            for (const c of short) msgs.push(`${capName(c)}: нужно ${need[c]}, на ${fmt(minDate[c])} в Гостевом доме свободно ${minGd[c]} — не хватает ${need[c] - minGd[c]}.`);
            if (short.includes(4) && spare2 > 0) msgs.push(`Вместо четырёхместного можно два двухместных: лишних двухместных в Гостевом доме — ${spare2}.`);
            const rb = Object.entries(rentBld || {}).filter(([, k]) => k > 0);
            msgs.push(rb.length ? `Резерв в аренде на все ночи: ${rb.map(([b, k]) => `${b} — ${k} ном.`).join(', ')}.`
                : 'Резерва в аренде на эти ночи нет — нужно договориться об аренде.');
        }
        for (const r of D.retreats.filter(r => r.occupies_guesthouse && r.start_date <= en && s <= r.end_date && r.id !== editing?.retreat_id))
            msgs.push(`На эти даты ретрит «${Layout.getName(r)}» (${fmt(r.start_date)}–${fmt(r.end_date)}) занимает весь Гостевой дом.`);
    }
    box.innerHTML = msgs.map(e).join('<br>');
    box.classList.toggle('hidden', !msgs.length);
}

function renderLinks() {
    const box = document.getElementById('planLinks');
    const p = editing;
    if (!p || p.kind !== 'event') { box.classList.add('hidden'); return; }
    const parts = [];
    const retreat = p.retreat_id && D.retreats.find(r => r.id === p.retreat_id);
    if (p.retreat_id) parts.push(`<div>Ретрит: <b>${e(retreat ? Layout.getName(retreat) : '—')}</b>
        <a class="link link-primary ml-2" href="retreats.html?retreat=${encodeURIComponent(p.retreat_id)}">${e(tf('rc_open_retreat', 'Открыть ретрит'))}</a></div>`);
    else if (window.currentUser?.is_superuser && p.status !== 'cancelled')
        parts.push(`<button type="button" class="btn btn-sm btn-outline" data-action="create-retreat">${e(tf('rc_create_retreat', 'Создать ретрит'))}</button>
            <span class="opacity-80 ml-1">— заведёт настоящий ретрит (CRM, оплаты, кухня начнут его видеть)</span>`);
    const linked = D.bookings.filter(b => b.plan_id === p.id);
    if (linked.length) parts.push(`<div><b>${e(tf('rc_booked_places', 'В шахматке'))}:</b> ` + linked.map(b =>
        `${e(b.name || '—')} · ${b.beds_count || 0} мест · ${fmt(b.check_in)}–${fmt(b.check_out)}`).join('; ') +
        ` <a class="link link-primary ml-1" href="../placement/timeline.html?date=${p.start_date}">Шахматка</a></div>`);
    if (perms.book && p.status !== 'cancelled')
        parts.push(`<button type="button" class="btn btn-sm btn-outline" data-action="book-places">${e(tf('rc_book_places', 'Забронировать места в шахматке'))}</button>`);
    box.innerHTML = parts.join('');
    box.classList.toggle('hidden', !parts.length);
}

// Списки в окне записи: Махараджи из справочника (плюс неактивный, если он уже стоит в записи),
// ответственные — сотрудники и волонтёры с входом (плюс прежний, если его уже нет в списке)
function fillSelects(v) {
    const f = form();
    const ms = maharajas.filter(m => m.is_active || m.id === v.maharaja_id);
    f.maharaja_id.innerHTML = `<option value="">${e(tf('rc_maharajas', 'Махараджи'))} (без имени)</option>` +
        ms.map(m => `<option value="${m.id}">${e(m.name)}</option>`).join('');
    const list = [...staff];
    if (v.responsible_id && !list.some(s => s.id === v.responsible_id)) list.push({ id: v.responsible_id, spiritual_name: '(нет в списке сотрудников)' });
    f.responsible_id.innerHTML = `<option value="">— не назначен —</option>` +
        list.map(s => `<option value="${s.id}">${e(personName(s))}</option>`).join('');
}

function openPlan(p = null, defaults = {}) {
    editing = p;
    const f = form();
    f.reset();
    const v = p || { kind: 'event', status: 'tentative', ...defaults };
    fillSelects(v);
    for (const k of ['kind', 'status', 'title', 'start_date', 'end_date', 'confirm_by', 'contact_name', 'contact_phone',
        'people_count', 'rooms_2', 'rooms_4', 'prepayment', 'notes', 'maharaja_id', 'responsible_id']) f[k].value = v[k] ?? '';
    f.needs_cafe.checked = !!v.needs_cafe;
    f.needs_hall.checked = !!v.needs_hall;
    document.getElementById('planTitle').textContent = p ? p.title : tf('rc_add', 'Добавить');
    document.getElementById('planDelete').classList.toggle('hidden', !p || !perms.edit);
    f.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = !perms.edit; });
    document.getElementById('planSave').classList.toggle('hidden', !perms.edit);
    form().classList.remove('hidden');
    document.getElementById('planReadonly').classList.add('hidden');
    toggleKindFields();
    renderLinks();
    document.getElementById('planModal').showModal();
}

// «1 номер», «3 номера», «24 номера», «5 номеров»
function roomsWord(k) {
    const m10 = k % 10, m100 = k % 100;
    const w = m10 === 1 && m100 !== 11 ? 'номер' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'номера' : 'номеров';
    return `${k} ${w}`;
}

// Ретрит или бронь из шахматки — только посмотреть
function openInfo(it) {
    editing = null;
    let html = '';
    if (it.src === 'retreat') {
        const r = D.retreats.find(x => x.id === it.id);
        html = `<p>${fmt(r.start_date)}.${r.start_date.slice(0, 4)} – ${fmt(r.end_date)}.${r.end_date.slice(0, 4)}</p>
            ${r.occupies_guesthouse ? `<p>Занимает весь Гостевой дом</p>` : ''}
            ${r.is_external ? `<p>Стороннее мероприятие</p>` : ''}
            ${r.is_internal ? `<p>Внутренний проект ШРСК</p>` : ''}
            ${!r.occupies_guesthouse && (r.rooms_2_needed || r.rooms_4_needed) ? `<p class="mt-2">Нужно номеров ГД:</p>
                ${[2, 4].filter(c => r[`rooms_${c}_needed`]).map(c => `<p class="pl-4">${c}х — ${roomsWord(r[`rooms_${c}_needed`])}</p>`).join('')}` : ''}
            <div class="modal-action"><a class="btn btn-sm" href="../placement/timeline.html?date=${r.start_date}">Шахматка</a>
            ${window.currentUser?.is_superuser ? `<a class="btn btn-sm btn-primary" href="retreats.html?retreat=${encodeURIComponent(r.id)}">${e(tf('rc_open_retreat', 'Открыть ретрит'))}</a>` : ''}</div>`;
    } else {
        const b = D.bookings.find(x => x.id === it.id);
        html = `<p>Бронь группы в шахматке: ${b.beds_count || 0} мест, ${fmt(b.check_in)}–${fmt(b.check_out)}</p>
            ${b.contact_name ? `<p>${e(b.contact_name)} ${e(b.contact_phone || '')}</p>` : ''}
            ${b.notes ? `<p class="whitespace-pre-line text-sm mt-2">${e(b.notes)}</p>` : ''}
            <div class="modal-action"><a class="btn btn-sm btn-primary" href="../placement/timeline.html?date=${b.check_in}">Шахматка</a></div>`;
    }
    document.getElementById('planTitle').textContent = it.title;
    form().classList.add('hidden');
    const ro = document.getElementById('planReadonly');
    ro.innerHTML = html;
    ro.classList.remove('hidden');
    document.getElementById('planModal').showModal();
}

async function savePlan(ev) {
    ev.preventDefault();
    if (!perms.edit) return;
    const f = form();
    const num = v => v === '' ? null : parseInt(v);
    const row = {
        kind: f.kind.value, status: f.status.value, title: f.title.value.trim(),
        start_date: f.start_date.value, end_date: f.end_date.value,
        confirm_by: f.confirm_by.value || null,
        contact_name: f.contact_name.value.trim() || null, contact_phone: f.contact_phone.value.trim() || null,
        people_count: num(f.people_count.value),
        rooms_2: num(f.rooms_2.value), rooms_4: num(f.rooms_4.value),
        needs_cafe: f.needs_cafe.checked, needs_hall: f.needs_hall.checked,
        prepayment: f.prepayment.value.trim() || null, notes: f.notes.value.trim() || null,
        maharaja_id: f.kind.value === 'guru' ? (f.maharaja_id.value || null) : null,
        responsible_id: f.kind.value === 'event' ? (f.responsible_id.value || null) : null
    };
    if (!row.title) return Layout.showNotification('Впишите название', 'error');
    // Общее число номеров — сумма типов (его видит шахматка в подсказке плашки)
    const sum = (row.rooms_2 || 0) + (row.rooms_4 || 0);
    row.rooms_count = sum || (editing?.rooms_count ?? null);
    if (!row.start_date || !row.end_date || row.end_date < row.start_date)
        return Layout.showNotification('Проверьте даты: «по» не раньше «с»', 'error');

    const linked = editing ? D.bookings.filter(b => b.plan_id === editing.id) : [];
    const cancelPlaces = editing && row.status === 'cancelled' && editing.status !== 'cancelled' && linked.length &&
        confirm(`Запись отменена. Снять в шахматке забронированные места (${linked.reduce((s, b) => s + (b.beds_count || 0), 0)})? Кто уже заехал — останется.`);

    const btn = document.getElementById('planSave');
    btn.disabled = true;
    try {
        const q = editing
            ? Layout.db.from('retreat_plans').update(row).eq('id', editing.id)
            : Layout.db.from('retreat_plans').insert(row);
        const { error } = await q;
        if (error) throw error;
        if (cancelPlaces) {
            for (const b of linked) {
                const { error: e1 } = await Layout.db.from('residents').update({ status: 'cancelled' })
                    .eq('booking_id', b.id).is('arrived_at', null).neq('status', 'cancelled');
                if (e1) throw e1;
                const { count, error: e2 } = await Layout.db.from('residents').select('id', { count: 'exact', head: true })
                    .eq('booking_id', b.id).neq('status', 'cancelled');
                if (e2) throw e2;
                if (!count) {
                    const { error: e3 } = await Layout.db.from('bookings').update({ status: 'cancelled' }).eq('id', b.id);
                    if (e3) throw e3;
                }
            }
        }
        if (editing && linked.length && row.status !== 'cancelled' &&
            (row.start_date !== editing.start_date || row.end_date !== editing.end_date))
            Layout.showNotification('Даты изменены. Бронь мест в шахматке осталась на прежних датах — передвиньте её в шахматке.', 'warning');
        else Layout.showNotification(tf('saved', 'Сохранено'), 'success');
        document.getElementById('planModal').close();
        await reload();
    } catch (err) {
        Layout.handleError(err, 'Расписание');
    } finally {
        btn.disabled = false;
    }
}

async function deletePlan() {
    if (!editing || !perms.edit) return;
    const linked = D.bookings.filter(b => b.plan_id === editing.id);
    const msg = linked.length
        ? `Удалить «${editing.title}»? Бронь мест в шахматке останется (отменить запись — статус «Отменено»).`
        : `Удалить «${editing.title}»?`;
    if (!confirm(msg)) return;
    const { error } = await Layout.db.from('retreat_plans').delete().eq('id', editing.id);
    if (error) return Layout.handleError(error, 'Расписание');
    document.getElementById('planModal').close();
    await reload();
}

function bookPlaces() {
    const p = editing;
    if (!p) return;
    document.getElementById('planModal').close();
    GroupBooking.open({
        planId: p.id, name: p.title, checkIn: p.start_date, checkOut: p.end_date,
        contact: { name: p.contact_name, phone: p.contact_phone }, notes: p.notes, people: p.people_count,
        retreatId: p.retreat_id || '',
        onSaved: () => reload()
    });
}

// ---------- события ----------
function bindEvents() {
    document.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (btn) {
            switch (btn.dataset.action) {
                case 'month': goTo(addMonths(start, +btn.dataset.delta)); return;
                case 'today': resetStart(); reload(false).then(scrollTop); return;
                case 'search-pick': document.getElementById('rcSearchResults').classList.add('hidden'); goTo(addDays(btn.dataset.date, -2)); return;
                case 'add': openPlan(null, { start_date: todayIso(), end_date: todayIso() }); return;
                case 'close-plan': document.getElementById('planModal').close(); return;
                case 'delete-plan': deletePlan(); return;
                case 'book-places': bookPlaces(); return;
                case 'create-retreat': location.href = `retreats.html?from_plan=${encodeURIComponent(editing.id)}`; return;
                case 'attention': attnOpen = !attnOpen; renderAttention(); return;
                case 'fullscreen': toggleFullscreen(btn); return;
                case 'maharajas': openMaharajas(); return;
                case 'close-maharajas': document.getElementById('maharajasModal').close(); return;
                case 'maharaja-del': deleteMaharaja(btn.dataset.id); return;
            }
        }
        const pl = ev.target.closest('[data-open-plan]');
        if (pl) { openPlan(D.plans.find(p => p.id === pl.dataset.openPlan)); return; }
        const seg = ev.target.closest('[data-open]');
        if (seg) {
            const it = D.items[seg.dataset.open];
            if (!it) return;
            if (it.src === 'plan') openPlan(D.plans.find(p => p.id === it.id));
            else openInfo(it);
            return;
        }
        // Пустая клетка — новая запись с этого дня (у кого есть право править)
        const empty = ev.target.closest('[data-new]');
        if (empty) {
            const d = Math.floor((ev.clientX - empty.getBoundingClientRect().left) / DW);
            if (d < 0 || d >= daysInYear()) return;
            const date = addDays(start, d);
            const col = empty.dataset.col;
            openPlan(null, {
                start_date: date, end_date: date,
                kind: col === 'guru' ? 'guru' : col === 'note' ? 'note' : 'event',
                status: col === 'event' ? 'confirmed' : 'tentative',
                maharaja_id: col === 'guru' ? (empty.dataset.maharaja || '') : ''
            });
        }
    });
    document.getElementById('rcShowCancelled').addEventListener('change', () => { render(); });
    document.getElementById('rcMonth').addEventListener('change', ev => goTo(ev.target.value));
    document.getElementById('rcSearch').addEventListener('input', Layout.debounce
        ? Layout.debounce(ev => search(ev.target.value), 300) : ev => search(ev.target.value));
    document.addEventListener('click', ev => {
        if (!ev.target.closest('#rcSearchBox')) document.getElementById('rcSearchResults').classList.add('hidden');
    });
    document.getElementById('maharajaAdd').addEventListener('submit', addMaharaja);
    document.getElementById('maharajasList').addEventListener('change', ev => {
        const row = ev.target.closest('[data-mid]');
        if (row) updateMaharaja(row.dataset.mid, ev.target);
    });
    const f = form();
    f.addEventListener('submit', savePlan);
    f.kind.addEventListener('change', toggleKindFields);
    for (const k of ['start_date', 'end_date', 'rooms_2', 'rooms_4']) f[k].addEventListener('input', checkLoad);
    f.start_date.addEventListener('change', () => { if (!f.end_date.value || f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; checkLoad(); });
}

// ---------- «На весь экран» (как в шахматке) ----------
function toggleFullscreen(btn) {
    const on = document.body.classList.toggle('board-fullscreen');
    btn.classList.toggle('btn-active', on);
    btn.title = on ? 'Обычный вид' : 'На весь экран';
    document.getElementById('rcBoard').style.maxHeight = on ? '' : 'calc(100vh - 260px)';
}

// ---------- справочник Махараджей ----------
async function loadMaharajas() {
    const { data, error } = await Layout.db.from('maharajas').select('id, name, sort_order, is_active').order('sort_order').order('name');
    if (error) { Layout.handleError(error, 'Махараджи'); return; }
    maharajas = data || [];
}

async function loadStaff() {
    const { data, error } = await Layout.db.from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name')
        .not('user_id', 'is', null).in('user_type', ['staff', 'volunteer'])
        .not('is_deleted', 'is', true).or('is_active.is.null,is_active.eq.true');
    if (error) { Layout.handleError(error, 'Сотрудники'); return; }
    staff = (data || []).sort((a, b) => personName(a).localeCompare(personName(b), 'ru'));
}

function renderMaharajas() {
    const used = id => D?.plans?.filter(p => p.maharaja_id === id).length || 0;
    document.getElementById('maharajasList').innerHTML = maharajas.map(m => `<div class="flex items-center gap-2" data-mid="${m.id}">
        <input type="number" name="sort_order" class="input input-bordered input-sm w-16" value="${m.sort_order}" title="Порядок" aria-label="Порядок">
        <input type="text" name="name" class="input input-bordered input-sm flex-1" value="${e(m.name)}" aria-label="Имя">
        <label class="label cursor-pointer gap-1 py-0" title="Снятые с галочки не предлагаются в новых записях"><input type="checkbox" name="is_active" class="checkbox checkbox-xs" ${m.is_active ? 'checked' : ''}><span class="label-text text-xs">в списке</span></label>
        <button type="button" class="btn btn-ghost btn-xs btn-square text-error" data-action="maharaja-del" data-id="${m.id}" title="Удалить" aria-label="Удалить">✕</button>
    </div>`).join('') || '<div class="text-sm opacity-80">Пока пусто</div>';
}

function openMaharajas() {
    renderMaharajas();
    document.getElementById('maharajasModal').showModal();
}

async function addMaharaja(ev) {
    ev.preventDefault();
    const name = ev.target.name.value.trim();
    if (!name) return;
    const sort = Math.max(0, ...maharajas.map(m => m.sort_order || 0)) + 10;
    const { error } = await Layout.db.from('maharajas').insert({ name, sort_order: sort });
    if (error) return Layout.handleError(error, 'Махараджи');
    ev.target.reset();
    await loadMaharajas();
    renderMaharajas();
}

async function updateMaharaja(id, input) {
    const val = input.type === 'checkbox' ? input.checked : input.type === 'number' ? (parseInt(input.value) || 0) : input.value.trim();
    if (input.name === 'name' && !val) { renderMaharajas(); return; }
    const { error } = await Layout.db.from('maharajas').update({ [input.name]: val }).eq('id', id);
    if (error) return Layout.handleError(error, 'Махараджи');
    await loadMaharajas();
    render();
}

async function deleteMaharaja(id) {
    const m = maharajas.find(x => x.id === id);
    if (!m) return;
    const { count } = await Layout.db.from('retreat_plans').select('id', { count: 'exact', head: true }).eq('maharaja_id', id);
    if (!confirm(count ? `У «${m.name}» записей: ${count}. Удалить из справочника? Записи останутся как «Махараджи (без имени)». Можно вместо этого снять галочку «в списке».`
        : `Удалить «${m.name}» из справочника?`)) return;
    const { error } = await Layout.db.from('maharajas').delete().eq('id', id);
    if (error) return Layout.handleError(error, 'Махараджи');
    await loadMaharajas();
    renderMaharajas();
    await reload();
}

async function init() {
    await Layout.init({ module: 'admin', menuId: 'ashram', itemId: 'retreat_calendar' });
    const has = c => !!window.hasPermission?.(c);
    perms = {
        edit: has('edit_retreat_plans'),
        seePlans: has('view_retreat_plans') || has('edit_retreat_plans'),
        book: has('edit_timeline') || has('create_booking')
    };
    document.getElementById('rcAddBtn').classList.toggle('hidden', !perms.edit);
    document.getElementById('rcCancelledToggle').classList.toggle('hidden', !perms.seePlans);
    document.getElementById('rcMaharajasBtn').classList.toggle('hidden', !perms.edit);
    bindEvents();
    resetStart();
    Layout.showLoader?.();
    await Promise.all([loadMaharajas(), loadStaff()]);
    await reload(false);
    Layout.hideLoader?.();
}

init();
