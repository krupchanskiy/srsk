/**
 * Retreat Report Page Logic
 * finance/retreat-report.html
 *
 * Сводный отчёт по ретриту: финансы (fin_get_retreat_report), воронка продаж (view_crm),
 * гости, размещение, трансферы.
 */

// ==================== STATE ====================
let retreatId = null;
let retreat = null;
let allRetreats = [];
let registrations = [];
let residents = [];
let transfers = [];
let deals = [];
let specialNeeds = [];
let finData = null;

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

// Цвета статусов регистрации — совпадают с STATUS_CATEGORY_MAP шахматки (см. CLAUDE.md)
const REG_STATUS_COLORS = { guest: '#8b5cf6', team: '#10b981', volunteer: '#f59e0b', vip: '#f76a3b', cancelled: '#ef4444' };
const REG_STATUS_KEYS = { guest: 'retreat_report_status_guest', team: 'retreat_report_status_team', volunteer: 'retreat_report_status_volunteer', vip: 'retreat_report_status_vip', cancelled: 'retreat_report_cancelled' };
const MEAL_COLORS = { prasad: '#10b981', self: '#3b82f6', child: '#f59e0b', none: '#9ca3af' };
const MEAL_KEYS = { prasad: 'meal_prasad', self: 'meal_self', child: 'meal_child', none: 'meal_none' };
const DIR_KEYS = { arrival: 'retreat_report_dir_arrival', arrival_retreat: 'retreat_report_dir_arrival_retreat', departure_retreat: 'retreat_report_dir_departure_retreat', departure: 'retreat_report_dir_departure' };
const TAXI_ICON = '<svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4 shrink-0" viewBox="0 0 103.07 59.75" fill="currentColor"><path d="M5.75,53.47c-1.68-1.71-2.63-4.23-2.68-6.64,2.97-10.49,6.26-20.89,9.36-31.35,1.71-5.78,1.81-10.95,9.24-12.11h58.86c3.74.23,7.15,2.76,8.35,6.35.33,1,.31,1.98.58,2.89,3.38,11.42,6.9,22.8,10.18,34.25-.11,4.72-3.5,8.64-8.16,9.3H11.55c-2.09-.16-4.35-1.22-5.8-2.7ZM21.72,9.78c-2.2.69-1.86,2.64-2.36,4.28-3.3,10.95-6.61,21.9-9.85,32.87-.47,2.23,1.92,3.11,3.77,3.19h76.19c1.99-.17,3.63-.69,3.83-2.97-3.25-10.64-6.4-21.3-9.61-31.95-.48-1.59-.56-4.58-2.24-5.26l-59.73-.16Z"/><polygon points="60.75 20.68 63.64 26.16 67.25 20.68 72.58 20.68 66.57 29.82 72.29 38.86 66.96 38.86 63.64 33.67 61.04 38.86 55.27 38.86 60.98 29.81 55.27 20.68 60.75 20.68"/><path d="M37.96,38.86l6.09-18.15,4.45-.05,6.48,18.2h-4.76l-1.27-3.29-4.91-.14-.89,3.43h-5.19ZM48.06,31.93c-.5-1.5-.78-3.12-1.3-4.61-.1-.28-.03-.66-.42-.58l-1.45,5.19h3.17Z"/><polygon points="39.12 20.68 39.12 25.01 33.92 25.01 33.92 38.86 28.73 38.86 28.73 25.01 23.54 25.01 23.54 20.68 39.12 20.68"/><rect x="74.03" y="20.68" width="5.19" height="18.18"/></svg>';
const WARNING_ICON = '<svg class="w-4 h-4 inline -mt-0.5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.007v.008H12v-.008ZM10.29 3.86 1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0Z"/></svg>';

// Иконки для KPI-карточек (fin-icon-chip) — те же, что в fin-analytics.js, для единого стиля модуля
const ICON_USERS = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>';
const ICON_UP = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/></svg>';
const ICON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181"/></svg>';
const ICON_NET = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l2.25 2.25L15 9.75M9 8.25V6a3 3 0 013-3v0a3 3 0 013 3v2.25"/></svg>';
const ICON_HOME = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"/></svg>';
const ICON_FUNNEL = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 01-.659 1.591l-5.432 5.432a2.25 2.25 0 00-.659 1.591v2.927a2.25 2.25 0 01-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 00-.659-1.591L3.659 7.409A2.25 2.25 0 013 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0112 3z"/></svg>';

// ==================== ЗАГРУЗКА СПИСКА РЕТРИТОВ (переключатель) ====================
async function loadRetreatsList() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date')
        .order('start_date', { ascending: false });

    if (error) { console.error('Error loading retreats:', error); return; }
    allRetreats = data || [];

    const select = document.getElementById('retreatSelect');
    select.innerHTML = `<option value="">${t('select_retreat')}</option>` +
        allRetreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('');
    if (retreatId) select.value = retreatId;
}

function onRetreatChange(id) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('id', id); else url.searchParams.delete('id');
    window.history.replaceState({}, '', url);
    retreatId = id || null;
    loadReport();
}

// ==================== ЗАГРУЗКА ДАННЫХ ====================
async function loadRetreat() {
    const { data, error } = await Layout.db.from('retreats').select('*').eq('id', retreatId).single();
    if (error) { console.error('Error loading retreat:', error); return null; }
    return data;
}

async function loadRegistrations() {
    const { data, error } = await Layout.db.from('retreat_registrations')
        .select('id, status, meal_type, vaishnava:vaishnavas(id, spiritual_name, first_name, last_name, gender, country)')
        .eq('retreat_id', retreatId)
        .eq('is_deleted', false);
    if (error) { console.error('Error loading registrations:', error); return []; }
    return data || [];
}

async function loadResidents() {
    const { data, error } = await Layout.db.from('residents')
        .select('id, room_id, check_in, check_out, status, guest_name, vaishnava:vaishnavas(spiritual_name, first_name, last_name), room:rooms(id, number, building_id, building:buildings(name_ru, name_en, name_hi))')
        .eq('retreat_id', retreatId);
    if (error) { console.error('Error loading residents:', error); return []; }
    return data || [];
}

// Духовное имя, если есть; иначе имя + фамилия (CLAUDE.md: «Имена вайшнавов»).
// Layout.getPersonName() фамилию не подставляет — здесь дополняем сами.
function guestDisplayName(v) {
    if (!v) return '—';
    const lang = Layout.currentLang;
    const tr = s => (lang === 'ru' || !s) ? s : Layout.transliterate(s);
    if (v.spiritual_name) return tr(v.spiritual_name);
    const civil = [v.first_name, v.last_name].filter(Boolean).join(' ').trim();
    return civil ? tr(civil) : '—';
}

function residentGuestName(r) {
    if (r.vaishnava) return guestDisplayName(r.vaishnava);
    return r.guest_name || '—';
}

async function loadTransfers() {
    const { data: regs, error: regErr } = await Layout.db.from('retreat_registrations').select('id').eq('retreat_id', retreatId);
    if (regErr || !regs?.length) return [];
    const regIds = regs.map(r => r.id);
    const { data, error } = await Layout.db.from('guest_transfers')
        .select('id, registration_id, direction, needs_transfer, taxi_status, flight_datetime')
        .in('registration_id', regIds);
    if (error) { console.error('Error loading transfers:', error); return []; }
    return data || [];
}

async function loadDeals() {
    const { data, error } = await Layout.db.from('crm_deals')
        .select('id, status, total_charged, total_paid, vaishnava:vaishnavas!crm_deals_vaishnava_id_fkey(spiritual_name, first_name, last_name)')
        .eq('retreat_id', retreatId);
    if (error) { console.error('Error loading deals:', error); return []; }
    return data || [];
}

async function loadSpecialNeeds() {
    const { data, error } = await Layout.db.from('crm_deals')
        .select('vaishnava_id, special_needs, vaishnava:vaishnavas!crm_deals_vaishnava_id_fkey(spiritual_name, first_name, last_name)')
        .eq('retreat_id', retreatId)
        .neq('status', 'cancelled')
        .not('special_needs', 'is', null);
    if (error) { console.error('Error loading special needs:', error); return []; }
    return (data || []).filter(d => d.special_needs?.trim());
}

// Финансовый отчёт живёт в модуле «Финансы» (fin_get_retreat_report) — не пересчитываем
// деньги самостоятельно, а читаем готовый RPC. Нет доступа/данных — секция просто скрыта.
async function loadFinance() {
    try {
        const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: retreatId });
        if (error || !data?.ok) return null;
        return data.result;
    } catch (err) {
        console.error('Error loading finance report:', err);
        return null;
    }
}

async function loadReport() {
    document.getElementById('reportEmpty').classList.toggle('hidden', Boolean(retreatId));
    document.getElementById('reportContent').classList.toggle('hidden', !retreatId);
    document.getElementById('backLink').href = retreatId ? `analytics.html?retreat=${retreatId}` : 'analytics.html';
    if (!retreatId) return;

    Layout.showLoader();
    try {
        const [retreatData, regsData, residentsData, transfersData] = await Promise.all([
            loadRetreat(), loadRegistrations(), loadResidents(), loadTransfers()
        ]);
        retreat = retreatData;
        registrations = regsData;
        residents = residentsData;
        transfers = transfersData;

        if (window.hasPermission?.('view_crm')) {
            [deals, specialNeeds] = await Promise.all([loadDeals(), loadSpecialNeeds()]);
        } else {
            deals = [];
            specialNeeds = [];
        }

        finData = await loadFinance();

        render();
    } finally {
        Layout.hideLoader();
    }
}

// ==================== РАСЧЁТЫ ====================
// Пиковая одновременная занятость + ряд по дням (sweep line, та же логика что в preliminary.js)
function calcOccupancy() {
    const placed = residents.filter(r => r.room_id && r.status !== 'cancelled');
    if (!placed.length) return { peak: 0, days: [] };

    let from = retreat.start_date, to = retreat.end_date;
    placed.forEach(r => {
        if (r.check_in < from) from = r.check_in;
        if (r.check_out > to) to = r.check_out;
    });

    const days = [];
    let d = DateUtils.parseDate(from);
    const end = DateUtils.parseDate(to);
    let peak = 0;
    while (d <= end) {
        const iso = DateUtils.toISO(d);
        const count = placed.filter(r => r.check_in <= iso && r.check_out > iso).length;
        peak = Math.max(peak, count);
        days.push({ date: iso, count });
        d = DateUtils.addDays(d, 1);
    }
    return { peak, days };
}

function groupList(list, field) {
    const map = {};
    list.forEach(item => {
        const key = item[field] || 'none';
        (map[key] ||= []).push(item);
    });
    return map;
}

// ==================== РЕНДЕР: ХЕЛПЕРЫ ====================
function kpi(icon, chip, label, value, sub) {
    return `<div class="card bg-base-100 fin-kpi"><div class="card-body">
        <div class="flex items-start gap-3">
            <div class="fin-icon-chip ${chip}">${icon}</div>
            <div class="min-w-0">
                <div class="fin-kpi-label">${label}</div>
                <div class="fin-kpi-value mt-0.5">${value}</div>
                ${sub ? `<div class="text-xs opacity-70 mt-0.5">${sub}</div>` : ''}
            </div>
        </div>
    </div></div>`;
}

function dailyChart(days) {
    if (!days.length) return `<div class="text-sm opacity-50 py-4 text-center">${t('retreat_report_no_data')}</div>`;
    const max = Math.max(1, ...days.map(d => d.count));
    const step = Math.max(1, Math.ceil(days.length / 16));
    return `<div class="rr-daily-chart">
        ${days.map((d, i) => `
            <div class="rr-daily-col" title="${d.date}: ${d.count}">
                <div class="rr-daily-bar" style="height:${Math.max(2, Math.round(d.count / max * 100))}%"></div>
                <div class="rr-daily-date">${i % step === 0 ? d.date.slice(8, 10) + '.' + d.date.slice(5, 7) : ''}</div>
            </div>
        `).join('')}
    </div>`;
}

// ==================== РЕНДЕР: РАЗДЕЛЫ ====================
function renderHeader() {
    const box = document.getElementById('rrHeader');
    const lang = Layout.currentLang;
    const today = DateUtils.toISO(new Date());
    let statusKey = 'retreat_report_status_upcoming', statusCls = 'badge-info';
    if (retreat.start_date <= today && retreat.end_date >= today) { statusKey = 'retreat_report_status_active'; statusCls = 'badge-success'; }
    else if (retreat.end_date < today) { statusKey = 'retreat_report_status_past'; statusCls = 'badge-ghost'; }

    const desc = retreat[`description_${lang}`] || retreat.description_ru || '';

    box.innerHTML = `
        <div class="flex items-start gap-3 flex-wrap">
            <div class="w-2 self-stretch rounded-full" style="background:${retreat.color || '#8b5cf6'}"></div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <h1 class="text-2xl font-bold">${e(Layout.getName(retreat))}</h1>
                    <span class="badge ${statusCls}">${t(statusKey)}</span>
                </div>
                <div class="text-sm opacity-70 mt-1">${DateUtils.formatRange(retreat.start_date, retreat.end_date)}</div>
                ${desc ? `<p class="text-sm opacity-60 mt-2 max-w-2xl">${e(desc)}</p>` : ''}
            </div>
        </div>`;
}

function renderKpis(occupancy) {
    const box = document.getElementById('rrKpis');
    const active = registrations.filter(r => r.status !== 'cancelled');
    const cancelled = registrations.length - active.length;

    const placed = residents.filter(r => r.room_id && r.status !== 'cancelled');
    const selfPlaced = residents.filter(r => !r.room_id && r.status !== 'cancelled').length;

    const pending = transfers.filter(x => x.needs_transfer === 'yes' && !x.taxi_status);

    const cards = [
        kpi(ICON_USERS, '', t('retreat_report_registrations'), active.length, cancelled ? `${cancelled} ${t('retreat_report_cancelled')}` : ''),
        kpi(ICON_HOME, '', t('retreat_report_residents'), placed.length, selfPlaced ? `${selfPlaced} ${t('retreat_report_self_placed')}` : ''),
        kpi(ICON_HOME, '', t('retreat_report_peak_occupancy'), occupancy.peak, ''),
        kpi(TAXI_ICON, pending.length ? 'is-warning' : '', t('retreat_report_taxi_pending'), pending.length, '')
    ];

    if (window.hasPermission?.('view_crm')) {
        const inPipeline = deals.filter(d => !['completed', 'cancelled'].includes(d.status)).length;
        cards.push(kpi(ICON_FUNNEL, '', t('retreat_report_in_pipeline'), inPipeline, ''));
    }
    if (finData?.exists) {
        const net = Number(finData.report.totals.net_base) || 0;
        cards.push(kpi(net < 0 ? ICON_DOWN : ICON_NET, net < 0 ? 'is-error' : '', t('fin_net'), `<span class="${net < 0 ? 'text-error' : 'text-success'}">${CrmUtils.formatMoney(net, 'INR')}</span>`, ''));
    }

    box.innerHTML = cards.join('');
}

// Список людей внутри раскрывающейся строки — отсортирован по имени
function nameListRow(label, list, max, color) {
    const sorted = [...list].sort((a, b) => guestDisplayName(a.vaishnava).localeCompare(guestDisplayName(b.vaishnava)));
    const items = sorted.map(r => `<div>${e(guestDisplayName(r.vaishnava))}</div>`).join('');
    return expandableRow(label, list.length, max, color, items);
}

function renderGuests() {
    const box = document.getElementById('rrGuests');
    const active = registrations.filter(r => r.status !== 'cancelled');

    const byStatus = groupList(active, 'status');
    const maxStatus = Math.max(1, ...Object.values(byStatus).map(l => l.length));
    const statusRows = Object.keys(REG_STATUS_KEYS).filter(k => k !== 'cancelled' && byStatus[k]?.length)
        .map(k => nameListRow(t(REG_STATUS_KEYS[k]), byStatus[k], maxStatus, REG_STATUS_COLORS[k])).join('');

    const byMeal = groupList(active, 'meal_type');
    const maxMeal = Math.max(1, ...Object.values(byMeal).map(l => l.length));
    const mealRows = ['prasad', 'self', 'child', 'none'].filter(k => byMeal[k]?.length)
        .map(k => nameListRow(t(MEAL_KEYS[k]), byMeal[k], maxMeal, MEAL_COLORS[k])).join('');

    const countries = {};
    active.forEach(r => { const c = r.vaishnava?.country?.trim(); if (c) (countries[c] ||= []).push(r); });
    const topCountries = Object.entries(countries).sort((a, b) => b[1].length - a[1].length).slice(0, 6);
    const maxCountry = Math.max(1, ...topCountries.map(([, l]) => l.length));
    const countryRows = topCountries.map(([name, list]) => nameListRow(name, list, maxCountry, '#6366f1')).join('');

    box.innerHTML = !active.length ? `<div class="text-center py-6 opacity-50">${t('retreat_report_nobody')}</div>` : `
        <div class="grid md:grid-cols-3 gap-4">
            <div><div class="rr-subtitle">${t('retreat_report_by_status')}</div>${statusRows || '—'}</div>
            <div><div class="rr-subtitle">${t('retreat_report_by_meals')}</div>${mealRows || '—'}</div>
            <div><div class="rr-subtitle">${t('retreat_report_top_countries')}</div>${countryRows || '—'}</div>
        </div>`;
}

// Раскрывающаяся строка-бар: клик показывает, кто именно стоит за цифрой
// (здание → кто в нём жил, статус воронки → кто в этом статусе)
function expandableRow(label, count, max, color, itemsHtml) {
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return `<details class="rr-expand-row">
        <summary class="rr-bar-row">
            <div class="rr-bar-label" title="${e(label)}">${e(label)}</div>
            <div class="rr-bar-track"><div class="rr-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <div class="rr-bar-value">${count}</div>
        </summary>
        <div class="rr-expand-list">${itemsHtml}</div>
    </details>`;
}

function buildingRow(name, list, max, color) {
    const sorted = [...list].sort((a, b) => (a.room?.number || '').localeCompare(b.room?.number || '', undefined, { numeric: true }));
    const items = sorted.map(r => `<div class="flex justify-between gap-2">
        <span>№${e(r.room?.number || '—')} · ${e(residentGuestName(r))}</span>
        <span class="opacity-60">${DateUtils.formatShort(r.check_in)} – ${DateUtils.formatShort(r.check_out)}</span>
    </div>`).join('');
    return expandableRow(name, list.length, max, color, items);
}

function renderOccupancy(occupancy) {
    const box = document.getElementById('rrOccupancy');
    const { days } = occupancy;

    const byBuilding = {};
    residents.filter(r => r.room_id && r.status !== 'cancelled').forEach(r => {
        const name = Layout.getName(r.room?.building) || '—';
        (byBuilding[name] ||= []).push(r);
    });
    const buildingEntries = Object.entries(byBuilding).sort((a, b) => b[1].length - a[1].length);
    const maxBuilding = Math.max(1, ...buildingEntries.map(x => x[1].length));
    const buildingRows = buildingEntries.map(([name, list]) => buildingRow(name, list, maxBuilding, '#8b5cf6')).join('');

    box.innerHTML = `
        <div class="mb-4">
            <div class="rr-subtitle">${t('retreat_report_daily_occupancy')}</div>
            <div class="overflow-x-auto">${dailyChart(days)}</div>
        </div>
        ${buildingEntries.length ? `<div><div class="rr-subtitle">${t('retreat_report_by_building')}</div>${buildingRows}</div>` : ''}
    `;
}

function transferGuestName(regId) {
    const reg = registrations.find(r => r.id === regId);
    return guestDisplayName(reg?.vaishnava);
}

// Раскрывающаяся строка для трансферов: имя + дата рейса
function transferRow(label, list, max, color) {
    const sorted = [...list].sort((a, b) => (a.flight_datetime || '').localeCompare(b.flight_datetime || ''));
    const items = sorted.map(x => `<div class="flex justify-between gap-2">
        <span>${e(transferGuestName(x.registration_id))}</span>
        <span class="opacity-60">${x.flight_datetime ? DateUtils.formatDateTime(DateUtils.parseTimestamp(x.flight_datetime)) : '—'}</span>
    </div>`).join('');
    return expandableRow(label, list.length, max, color, items);
}

function renderLogistics() {
    const box = document.getElementById('rrLogistics');

    const byDir = groupList(transfers, 'direction');
    const maxDir = Math.max(1, ...Object.values(byDir).map(l => l.length));
    const dirRows = Object.keys(DIR_KEYS).filter(k => byDir[k]?.length)
        .map(k => transferRow(t(DIR_KEYS[k]), byDir[k], maxDir, '#f49800')).join('');

    const needLists = groupList(transfers, 'needs_transfer');
    const maxNeed = Math.max(1, transfers.length);
    const pending = transfers.filter(x => x.needs_transfer === 'yes' && !x.taxi_status)
        .sort((a, b) => (a.flight_datetime || '').localeCompare(b.flight_datetime || ''));

    const pendingList = pending.length ? `
        <details class="mt-3">
            <summary class="cursor-pointer text-sm font-medium flex items-center gap-1">
                ${TAXI_ICON} ${t('retreat_report_pending_list')} <span class="badge badge-warning badge-sm">${pending.length}</span>
            </summary>
            <div class="mt-2 overflow-x-auto">
                <table class="table table-sm">
                    <tbody>
                        ${pending.map(x => `<tr>
                            <td>${e(transferGuestName(x.registration_id))}</td>
                            <td class="opacity-70">${t(DIR_KEYS[x.direction] || x.direction)}</td>
                            <td class="text-right opacity-70">${x.flight_datetime ? DateUtils.formatDateTime(DateUtils.parseTimestamp(x.flight_datetime)) : '—'}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </details>` : '';

    box.innerHTML = `
        <div class="grid md:grid-cols-2 gap-4">
            <div><div class="rr-subtitle">${t('retreat_report_by_status')}</div>${dirRows || '—'}</div>
            <div>
                <div class="rr-subtitle">${t('retreat_report_needs_transfer')} / ${t('retreat_report_no_transfer')}</div>
                ${transferRow(t('retreat_report_needs_transfer'), needLists.yes || [], maxNeed, '#f97316')}
                ${transferRow(t('retreat_report_no_transfer'), needLists.no || [], maxNeed, '#9ca3af')}
            </div>
        </div>
        ${pendingList}
    `;
}

function dealStatusRow(status, list, max) {
    const sorted = [...list].sort((a, b) => guestDisplayName(a.vaishnava).localeCompare(guestDisplayName(b.vaishnava)));
    const items = sorted.map(d => `<div>${e(guestDisplayName(d.vaishnava))}</div>`).join('');
    return expandableRow(CrmUtils.getStatusLabel(status), list.length, max, CrmUtils.STATUS_COLORS[status], items);
}

function renderCrm() {
    const section = document.getElementById('rrCrmSection');
    if (!window.hasPermission?.('view_crm') || !deals.length) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    const box = document.getElementById('rrCrm');

    const byStatus = groupList(deals, 'status');
    const maxStatus = Math.max(1, ...CrmUtils.STATUSES.map(s => byStatus[s]?.length || 0));
    const bars = CrmUtils.STATUSES.map(s => byStatus[s]?.length
        ? dealStatusRow(s, byStatus[s], maxStatus) : '').join('');

    const needsList = specialNeeds.length ? `
        <details class="mt-3">
            <summary class="cursor-pointer text-sm font-medium flex items-center gap-1">
                ${WARNING_ICON} ${t('special_needs_summary')} <span class="badge badge-warning badge-sm">${specialNeeds.length}</span>
            </summary>
            <div class="mt-2 space-y-0.5 text-sm">
                ${specialNeeds.map(d => `<div><b>${e(guestDisplayName(d.vaishnava))}:</b> ${e(d.special_needs)}</div>`).join('')}
            </div>
        </details>` : '';

    box.innerHTML = `${bars}${needsList}`;
}

function renderFinance() {
    const section = document.getElementById('rrFinanceSection');
    if (!finData) { section.classList.add('hidden'); return; }
    section.classList.remove('hidden');
    const box = document.getElementById('rrFinance');

    if (!finData.exists) {
        box.innerHTML = `<div class="text-sm opacity-50 py-2">${t('retreat_report_finance_no_data')}</div>`;
        return;
    }

    const r = finData.report;
    const p = r.participants;
    const tot = r.totals;
    const net = Number(tot.net_base) || 0;
    const cafe = r.cafe?.totals;
    const prasad = r.prasad?.totals;

    // Прасад и кафе — самостоятельные единицы внутри ретрита (ВГ, сен 2026):
    // в приходах/расходах самого ретрита их не показываем построчно, а
    // вычитаем из общего (totals по-прежнему считает всё, как и раньше).
    // Прасад при этом — часть ретрита (в отличие от кафе): «Ретрит» здесь —
    // сумма собственно ретрита и прасада, и складывается с кафе только в
    // самом низу, в «Итого».
    const hasCafeActivity = cafe && (Number(cafe.income_base) || Number(cafe.expense_base));
    const hasPrasadActivity = prasad && (Number(prasad.income_base) || Number(prasad.expense_base));
    const retreatCombined = hasCafeActivity ? {
        income_base: Number(tot.income_base) - Number(cafe.income_base),
        expense_base: Number(tot.expense_base) - Number(cafe.expense_base),
        net_base: net - Number(cafe.net_base)
    } : tot;
    const retreatOnly = hasPrasadActivity ? {
        income_base: Number(retreatCombined.income_base) - Number(prasad.income_base),
        expense_base: Number(retreatCombined.expense_base) - Number(prasad.expense_base),
        net_base: Number(retreatCombined.net_base) - Number(prasad.net_base)
    } : retreatCombined;

    const moneyCell = (n, cls) => `<td class="text-right font-mono ${cls}">${CrmUtils.formatMoney(n, 'INR')}</td>`;
    const netCls = n => Number(n) < 0 ? 'text-error' : 'text-success';
    const splitRow = (label, block, opts = {}) => `<tr class="${opts.bold ? 'font-semibold border-t-2 border-base-300' : ''}">
        <td class="${opts.indent ? 'pl-6 text-sm opacity-70' : ''}">${label}</td>
        ${moneyCell(block.income_base, 'text-success')}
        ${moneyCell(block.expense_base, 'text-error')}
        ${moneyCell(block.net_base, netCls(block.net_base))}
    </tr>`;

    const splitTable = (hasCafeActivity || hasPrasadActivity) ? `
        <div class="overflow-x-auto mt-3">
            <table class="table table-sm">
                <thead><tr>
                    <th></th>
                    <th class="text-right">${t('fin_income')}</th>
                    <th class="text-right">${t('fin_expense')}</th>
                    <th class="text-right">${t('fin_net')}</th>
                </tr></thead>
                <tbody>
                    ${splitRow(t('retreat_report_finance_retreat_only'), retreatCombined, { bold: hasPrasadActivity })}
                    ${hasPrasadActivity ? splitRow(t('retreat_report_finance_retreat_only'), retreatOnly, { indent: true }) : ''}
                    ${hasPrasadActivity ? splitRow(t('retreat_report_finance_prasad'), prasad, { indent: true }) : ''}
                    ${hasCafeActivity ? splitRow(t('retreat_report_finance_cafe'), cafe) : ''}
                    ${splitRow(t('retreat_report_finance_total'), tot, { bold: true })}
                </tbody>
            </table>
        </div>` : '';

    box.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${kpi(ICON_USERS, '', t('fin_participants_count'), p.count, `${t('fin_charged')}: ${CrmUtils.formatMoney(p.charged, 'INR')} · ${t('fin_paid')}: ${CrmUtils.formatMoney(p.paid, 'INR')}`)}
            ${kpi(ICON_UP, '', t('fin_income'), `<span class="text-success">${CrmUtils.formatMoney(tot.income_base, 'INR')}</span>`, '')}
            ${kpi(ICON_DOWN, 'is-error', t('fin_expense'), `<span class="text-error">${CrmUtils.formatMoney(tot.expense_base, 'INR')}</span>`, '')}
            ${kpi(ICON_NET, net < 0 ? 'is-error' : '', t('fin_net'), `<span class="${netCls(net)}">${CrmUtils.formatMoney(net, 'INR')}</span>`, '')}
        </div>
        ${splitTable}
        ${p.debtors?.length ? `<div class="mt-3 text-sm"><span class="badge badge-error badge-sm">${p.debtors.length}</span> ${t('fin_debtors')}: <span class="font-mono text-error">${CrmUtils.formatMoney(p.debt_total, 'INR')}</span></div>` : ''}
        <a href="analytics.html?retreat=${retreat.id}" class="link link-primary text-sm inline-flex items-center gap-1 mt-3">
            ${t('retreat_report_finance_more')}
            <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
        </a>
    `;
}

function render() {
    if (!retreat) return;
    const occupancy = calcOccupancy();
    renderHeader();
    renderKpis(occupancy);
    renderGuests();
    renderOccupancy(occupancy);
    renderLogistics();
    renderCrm();
    renderFinance();
    Layout.updateAllTranslations();
}

window.onLanguageChange = () => { if (retreat) render(); };

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_analytics', itemId: 'fin_analytics' });

    const params = new URLSearchParams(window.location.search);
    retreatId = params.get('id') || null;

    await loadRetreatsList();
    document.getElementById('retreatSelect').addEventListener('change', ev => onRetreatChange(ev.target.value));

    document.getElementById('printBtn').addEventListener('click', () => window.print());

    await loadReport();
}

init();
