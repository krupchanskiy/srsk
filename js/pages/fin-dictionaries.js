// ==================== ФИНАНСЫ: СПРАВОЧНИКИ ====================
// Табы: статьи / cost centers / контрагенты / департаменты / курсы валют
//
// Департаменты добавлены 26.07.2026 по просьбе ВГ: раньше их список и привязка
// чата жили только в базе. Подотчётный счёт департаменту здесь не заводится —
// он создаётся сам при первой выдаче; при переименовании имя счёта тянется
// следом на сервере.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let currentTab = 'categories';
let rows = [];
let editingId = null;

const editIcon = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z"/></svg>`;

// ==================== ЗАГРУЗКА ====================
async function loadTab() {
    const body = document.getElementById('dictBody');
    body.innerHTML = `<tr><td colspan="6" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;

    const sources = {
        categories: () => Layout.db.from('fin_v_categories').select('*').order('name'),
        cost_centers: () => Layout.db.from('fin_v_cost_centers').select('*').order('name'),
        contractors: () => Layout.db.from('fin_v_contractors').select('*').order('name'),
        departments: () => Layout.db.from('fin_v_departments').select('*').order('name'),
        rates: () => Layout.db.from('fin_v_exchange_rates').select('*').order('effective_date', { ascending: false }).limit(1000)
    };
    const { data, error } = await sources[currentTab]();
    if (error) { Layout.handleError(error, 'Справочники'); return; }
    rows = data || [];
    if (currentTab === 'rates') await loadNoRateRetreats();
    if (currentTab === 'departments') {
        if (!knownChats) await loadKnownChats();
        await loadDeptCategories();
        await loadDeptViewers();
        await loadDeptIncome();
    }
    renderTab();
}

// Чаты, которые бот уже видел: сам чат регистрируется, когда бота туда
// добавляют, поэтому chat_id руками вводить не нужно — только выбрать.
let knownChats = null;
async function loadKnownChats() {
    const { data } = await Layout.db.from('fin_v_known_chats').select('*').order('title');
    knownChats = data || [];
}

// Свои наборы статей по департаментам: { department_id: [category_id, …] }.
// Пустой массив означает «общий набор» — это же правило и на сервере.
let deptCategories = {};
async function loadDeptCategories() {
    const { data } = await Layout.db.from('fin_v_department_categories').select('department_id, category_id');
    deptCategories = {};
    for (const r of data || []) (deptCategories[r.department_id] = deptCategories[r.department_id] || []).push(r.category_id);
}

// «Кто ещё видит департамент» (мигр. 704): { department_id: [{ id, name }, …] }.
// Глава видит свой департамент сам, сюда он не входит.
let deptViewers = {};
async function loadDeptViewers() {
    const { data } = await Layout.db.from('fin_department_viewers')
        .select('department_id, vaishnava_id, vaishnavas(spiritual_name, first_name, last_name)');
    deptViewers = {};
    for (const r of data || []) {
        const v = r.vaishnavas || {};
        const name = v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim();
        (deptViewers[r.department_id] = deptViewers[r.department_id] || []).push({ id: r.vaishnava_id, name });
    }
}

// Статьи выручки департамента (мигр. 706): приходы по ним с любого счёта — блок «Выручка» на его странице
let deptIncome = {};
async function loadDeptIncome() {
    const { data } = await Layout.db.from('fin_department_income_categories').select('department_id, category_id');
    deptIncome = {};
    for (const r of data || []) (deptIncome[r.department_id] = deptIncome[r.department_id] || []).push(r.category_id);
}

function activeBadge(row) {
    return row.is_active ? '' : ` <span class="badge badge-ghost badge-xs">${t('fin_archived')}</span>`;
}

let dictQuery = '';
let dictDir = '';   // '' | 'in' | 'out' (только для статей)

// Отфильтрованный по поиску/направлению срез rows
function filteredRows() {
    const q = dictQuery.trim().toLowerCase();
    return rows.filter(r => {
        if (currentTab === 'categories' && dictDir && r.direction !== dictDir) return false;
        if (!q) return true;
        const hay = [r.name, r.code, r.from_currency, r.object_name, r.contact_info,
                     r.responsible_name, r.chat_title].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
    });
}

function renderTab() {
    // У курсов своя раскладка (вкладки, график, архив) — таблица справочника скрыта
    const isRates = currentTab === 'rates';
    document.getElementById('dictToolbar').classList.toggle('hidden', isRates);
    document.getElementById('dictCard').classList.toggle('hidden', isRates);
    document.getElementById('ratesView').classList.toggle('hidden', !isRates);
    if (isRates) { renderRates(); return; }

    const head = document.getElementById('dictHead');
    const body = document.getElementById('dictBody');
    const view = filteredRows();
    const countEl = document.getElementById('dictCount');
    if (countEl) countEl.textContent = rows.length ? `${view.length} / ${rows.length}` : '';
    document.getElementById('dirFilter').style.display = currentTab === 'categories' ? '' : 'none';

    if (currentTab === 'categories') {
        head.innerHTML = `<tr><th>${t('col_code') || 'Код'}</th><th>${t('col_name') || 'Название'}</th><th>${t('fin_direction')}</th><th>${t('fin_visible_departments')}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td class="font-mono">${e(r.code)}</td>
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td><span class="badge badge-sm ${r.direction === 'in' ? 'badge-success' : 'badge-error'}">${t('fin_dir_' + r.direction)}</span></td>
                <td>${r.visible_to_departments ? FinUtils.ICONS.check : ''}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else if (currentTab === 'cost_centers') {
        head.innerHTML = `<tr><th>${t('col_code') || 'Код'}</th><th>${t('col_name') || 'Название'}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td class="font-mono">${e(r.code)}</td>
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else if (currentTab === 'contractors') {
        head.innerHTML = `<tr><th>${t('col_name') || 'Название'}</th><th>${t('fin_person_org')}</th><th>${t('fin_comment')}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr class="${r.is_active ? '' : 'opacity-60'}">
                <td>${e(r.name)}${activeBadge(r)}</td>
                <td>${t(r.type === 'person' ? 'fin_person' : 'fin_organization')}</td>
                <td class="opacity-70">${e([r.contact_info, r.note].filter(Boolean).join(' · '))}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    } else if (currentTab === 'departments') {
        head.innerHTML = `<tr><th>${t('col_name') || 'Название'}</th><th>${t('fin_responsible')}</th><th>${t('fin_dept_chat')}</th><th>${t('fin_dept_on_hand')}</th><th class="text-right">${t('fin_dept_people')}</th><th></th></tr>`;
        body.innerHTML = view.map(r => `
            <tr>
                <td>${Utils.isValidColor(r.color) ? `<span class="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style="background:${r.color}"></span>` : ''}${e(r.name)}${
                    r.for_people ? '' : ` <span class="badge badge-ghost badge-sm">${t('fin_dept_personal')}</span>`}</td>
                <td>${e(r.responsible_name || '')}${(deptViewers[r.id] || []).length
                    ? `<div class="text-xs opacity-60">${t('fin_dept_viewers_also')}: ${e(deptViewers[r.id].map(v => v.name).join(', '))}</div>` : ''}</td>
                <td>${r.chat_title
                        ? e(r.chat_title)
                        : `<span class="badge badge-warning badge-sm">${t('fin_dept_no_chat')}</span>`}
                    ${r.chat_title && r.bot_knows_responsible === false
                        ? `<div class="text-xs text-warning mt-0.5" title="${t('fin_dept_bot_blind_hint')}">⚠️ ${t('fin_dept_bot_blind')}</div>`
                        : ''}</td>
                <td class="font-mono">${
                    (r.balances || []).map(b => FinUtils.fmtMoney(b.amount, b.currency)).join(' · ') || '—'}</td>
                <td class="text-right">${r.people_count || ''}</td>
                <td class="text-right"><button class="btn btn-ghost btn-sm" data-edit="${r.id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button></td>
            </tr>`).join('');
    }
    if (!view.length) {
        const msg = rows.length ? t('fin_nothing_found') : t('fin_dict_empty');
        body.innerHTML = `<tr><td colspan="6" class="text-center py-10 opacity-60">
            <div class="mb-2">${msg}</div>
            ${!rows.length ? `<button class="btn btn-primary btn-sm" onclick="FinDicts.openAdd()">${t('fin_add')}</button>` : ''}
        </td></tr>`;
    }
}

// ==================== КУРСЫ ВАЛЮТ ====================
// Три вкладки (ВГ 24.10): Текущие / График / Архив. Раньше все курсы шли одним
// списком, и прошлые тонули в портянке. Общий курс уходит в архив, когда есть
// свежее; курс ретрита — когда ретрит закончился по факту (retreat_fact_end).
// Курс ретрита не «действует», а зафиксирован: fin_private_retreat_rate берёт его
// при любой дате, и он один на валюту (мигр. 750).
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const RATE_COLORS = { general: '#2563eb', retreats: '#8b5cf6' };
let ratesTab = 'current';     // current | chart | archive
let chartCur = null;
let chartMode = 'both';       // general | retreats | both
let chartMonths = 12;         // 3 | 6 | 12 | 0 (всё)
let ratesChart = null;
let chartLib = null;
let noRateRetreats = [];

async function loadNoRateRetreats() {
    const { data } = await Layout.db.rpc('fin_get_retreats_without_rate');
    noRateRetreats = data?.ok ? (data.result || []) : [];
}

function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLib) chartLib = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = CHART_JS; sc.onload = () => res(window.Chart); sc.onerror = () => { chartLib = null; rej(); };
        document.head.appendChild(sc);
    });
    return chartLib;
}

// Ретрит закончился по факту (последний выезд), объект без ретрита — закрыт
function objectArchived(o) {
    if (!o) return false;
    if (o.retreat_id) return !!o.fact_end && o.fact_end < FinUtils.todayISO();
    return !!o.is_closed;
}

// Даты курса ретрита: даты самого ретрита, у объекта без ретрита — дата курса
function retreatSpan(o, r) {
    const start = o?.retreat?.start_date || r.effective_date;
    return { start, end: o?.fact_end || o?.retreat?.end_date || start };
}

function splitRates() {
    const today = FinUtils.todayISO();
    const objects = new Map(FinUtils.refs.objects.map(o => [o.id, o]));
    const res = { general: [], prev: {}, retreats: [], archGeneral: [], archRetreats: [] };

    // Общий: будущие и действующий — в «Текущие», всё старше действующего — в архив
    const byCur = {};
    for (const r of rows.filter(r => !r.object_id)) (byCur[r.from_currency] = byCur[r.from_currency] || []).push(r);
    for (const list of Object.values(byCur)) {
        const idx = list.findIndex(r => r.effective_date <= today);   // rows отсортированы desc
        const cut = idx === -1 ? list.length : idx + 1;
        res.general.push(...list.slice(0, cut));
        res.archGeneral.push(...list.slice(cut));
        // «изменился 11 окт, было 108»: курс часто вносят тем же числом — ищем прошлое другое значение
        if (idx === -1) continue;
        let j = idx;
        while (list[j + 1] && Number(list[j + 1].rate) === Number(list[idx].rate)) j++;
        if (list[j + 1]) res.prev[list[idx].id] = { rate: list[j + 1].rate, since: list[j].effective_date };
    }
    const order = c => { const i = ['USD', 'EUR', 'RUB'].indexOf(c); return i === -1 ? 9 : i; };
    res.general.sort((a, b) => order(a.from_currency) - order(b.from_currency) || b.effective_date.localeCompare(a.effective_date));

    // Ретриты: по объекту, внутри — по курсу на валюту
    const byObj = new Map();
    for (const r of rows.filter(r => r.object_id)) {
        if (!byObj.has(r.object_id)) {
            const o = objects.get(r.object_id);
            byObj.set(r.object_id, { obj: o, name: r.object_name || o?.display_name || '—', ...retreatSpan(o, r), rates: [] });
        }
        byObj.get(r.object_id).rates.push(r);
    }
    for (const g of byObj.values()) {
        g.rates.sort((a, b) => order(a.from_currency) - order(b.from_currency));
        (objectArchived(g.obj) ? res.archRetreats : res.retreats).push(g);
    }
    res.retreats.sort((a, b) => a.start.localeCompare(b.start));
    res.archRetreats.sort((a, b) => b.start.localeCompare(a.start));
    return res;
}

const fmtDate = iso => DateUtils.formatShort(DateUtils.parseDate(iso));
const editBtn = id => `<button class="btn btn-ghost btn-sm" data-edit="${id}" aria-label="${t('edit')}" title="${t('edit')}">${editIcon}</button>`;
const fixedBadge = () => `<span class="badge badge-info badge-sm" title="${e(tr('fin_rate_fixed_hint', 'Курс зафиксирован на весь ретрит'))}">${e(tr('fin_rate_fixed', 'зафиксирован'))}</span>`;

// Курсы ретрита одной строкой: «USD 95 · EUR 109», клик по курсу — правка
function rateChips(g) {
    return g.rates.map(r => `<button class="btn btn-ghost btn-xs font-mono gap-1" data-edit="${r.id}" title="${t('edit')}">
        <span class="font-bold">${e(r.from_currency)}</span> ${e(String(r.rate))}</button>`).join('');
}

function retreatRow(g, withBadge) {
    return `<tr>
        <td>${e(g.name)}</td>
        <td class="whitespace-nowrap">${e(DateUtils.formatRange(g.start, g.end))}</td>
        <td>${withBadge ? fixedBadge() : ''}</td>
        <td><div class="flex flex-wrap gap-1">${rateChips(g)}</div></td>
    </tr>`;
}

function sectionCard(title, inner) {
    return `<div class="card bg-base-100 shadow-sm mb-4"><div class="card-body p-4">
        <h2 class="font-semibold mb-2">${e(title)}</h2><div class="overflow-x-auto">${inner}</div></div></div>`;
}

function renderRates() {
    const box = document.getElementById('ratesView');
    const tabs = [['current', tr('fin_rates_current', 'Текущие')], ['chart', tr('fin_rates_chart', 'График')], ['archive', tr('fin_rates_archive', 'Архив')]];
    const s = splitRates();
    box.innerHTML = `<div role="tablist" class="tabs tabs-bordered w-fit mb-4">${tabs.map(([k, label]) =>
        `<a role="tab" class="tab ${ratesTab === k ? 'tab-active' : ''}" data-rates-tab="${k}">${e(label)}</a>`).join('')}</div>
        <div id="ratesBody">${ratesTab === 'current' ? ratesCurrentHtml(s) : ratesTab === 'archive' ? ratesArchiveHtml(s) : ratesChartHtml()}</div>`;
    if (ratesTab === 'chart') drawRatesChart();
}

function ratesCurrentHtml(s) {
    const today = FinUtils.todayISO();
    // ⚠ сверху: ретрит без своего курса считается по общему на дату — курс плавает
    const warn = noRateRetreats.length ? `<div class="alert alert-warning mb-4 items-start">
        <div class="w-full"><div class="font-semibold mb-1">⚠ ${e(tr('fin_rates_retreats', 'Курсы ретритов'))}: ${noRateRetreats.length} — ${e(tr('fin_rates_no_own', 'нет своего курса — считается по общему на дату операции'))}</div>
        <ul class="text-sm space-y-0.5">${noRateRetreats.map(x => {
            const obj = FinUtils.refs.objects.find(o => o.retreat_id === x.retreat_id);
            return `<li>${obj && window.hasPermission?.('fin_admin')
                ? `<a class="link" data-add-rate-for="${obj.id}">${e(x.title)}</a>` : e(x.title)}
                <span class="opacity-70">· ${e(DateUtils.formatRange(x.start_date, x.end_date))}${x.waiting ? ` · ${e(x.waiting)}` : ''}</span></li>`;
        }).join('')}</ul></div></div>` : '';

    const general = `<table class="table table-sm"><thead><tr><th>${t('fin_currency')}</th><th>${t('fin_effective_date')}</th><th>${t('fin_rate')}</th><th></th></tr></thead><tbody>${
        s.general.map(r => {
            const future = r.effective_date > today;
            const prev = s.prev[r.id];
            return `<tr class="${future ? 'opacity-70' : 'font-medium'}">
                <td class="font-mono font-bold">${e(r.from_currency)}</td>
                <td>${fmtDate(r.effective_date)} ${future
                    ? `<span class="badge badge-ghost badge-xs">${e(tr('fin_rate_upcoming', 'с этой даты'))}</span>`
                    : `<span class="badge badge-success badge-xs">${t('fin_rate_current')}</span>`}</td>
                <td class="font-mono">${e(String(r.rate))}${prev
                    ? ` <span class="text-xs opacity-60 font-sans">${e(tr('fin_rate_changed', 'изменился {date}, было {rate}')
                        .replace('{date}', fmtDate(prev.since)).replace('{rate}', String(prev.rate)))}</span>` : ''}</td>
                <td class="text-right">${editBtn(r.id)}</td>
            </tr>`;
        }).join('')}</tbody></table>`;

    const retreats = s.retreats.length
        ? `<table class="table table-sm"><tbody>${s.retreats.map(g => retreatRow(g, true)).join('')}</tbody></table>`
        : `<div class="text-sm opacity-60">${e(tr('fin_rates_no_retreats', 'Нет предстоящих и идущих ретритов со своим курсом'))}</div>`;

    return warn + sectionCard(t('fin_general_rate'), general) + sectionCard(tr('fin_rates_retreats', 'Курсы ретритов'), retreats);
}

// Архив: по годам (свежий год раскрыт), внутри общего курса — по месяцам
function ratesArchiveHtml(s) {
    if (!s.archGeneral.length && !s.archRetreats.length) {
        return `<div class="card bg-base-100 shadow-sm"><div class="card-body text-center opacity-60">${e(tr('fin_rates_archive_empty', 'В архиве пока пусто'))}</div></div>`;
    }
    const locale = { ru: 'ru-RU', en: 'en-US', hi: 'hi-IN' }[DateUtils.getLang()] || 'ru-RU';
    const monthName = ym => { const m = DateUtils.parseDate(ym + '-01').toLocaleDateString(locale, { month: 'long' }); return m[0].toUpperCase() + m.slice(1); };
    const byYear = (list, dateOf) => {
        const map = new Map();
        for (const x of list) { const y = dateOf(x).slice(0, 4); if (!map.has(y)) map.set(y, []); map.get(y).push(x); }
        return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    };
    const yearBlock = (y, i, n, inner) => `<details class="mb-2" ${i === 0 ? 'open' : ''}>
        <summary class="cursor-pointer font-semibold py-1">${e(y)} <span class="opacity-60 font-normal">· ${n}</span></summary>${inner}</details>`;

    // Курсы вносят разом по всем валютам — одна строка на дату: «22 окт · USD 96 · EUR 106 · RUB 1.08»
    const byDate = new Map();
    for (const r of [...s.archGeneral].sort((a, b) => b.effective_date.localeCompare(a.effective_date))) {
        if (!byDate.has(r.effective_date)) byDate.set(r.effective_date, { date: r.effective_date, rates: [] });
        byDate.get(r.effective_date).rates.push(r);
    }
    const order = c => { const i = ['USD', 'EUR', 'RUB'].indexOf(c); return i === -1 ? 9 : i; };
    const general = byDate.size ? byYear([...byDate.values()], d => d.date).map(([y, list], i) => {
        let month = '';
        const body = list.map(d => {
            const ym = d.date.slice(0, 7);
            const head = ym !== month ? `<tr class="bg-base-200"><td colspan="2" class="text-xs font-semibold uppercase opacity-70">${e(monthName(ym))}</td></tr>` : '';
            month = ym;
            d.rates.sort((a, b) => order(a.from_currency) - order(b.from_currency));
            return head + `<tr>
                <td class="whitespace-nowrap w-40">${fmtDate(d.date)}</td>
                <td><div class="flex flex-wrap gap-1">${rateChips(d)}</div></td></tr>`;
        }).join('');
        return yearBlock(y, i, list.length, `<table class="table table-sm"><tbody>${body}</tbody></table>`);
    }).join('') : `<div class="text-sm opacity-60">${e(tr('fin_rates_archive_empty', 'В архиве пока пусто'))}</div>`;

    const retreats = s.archRetreats.length ? byYear(s.archRetreats, g => g.start).map(([y, list], i) =>
        yearBlock(y, i, list.length, `<table class="table table-sm"><tbody>${list.map(g => retreatRow(g, false)).join('')}</tbody></table>`)
    ).join('') : `<div class="text-sm opacity-60">${e(tr('fin_rates_archive_empty', 'В архиве пока пусто'))}</div>`;

    return sectionCard(t('fin_general_rate'), general) + sectionCard(tr('fin_rates_retreats', 'Курсы ретритов'), retreats);
}

function ratesChartHtml() {
    const currencies = [...new Set(rows.map(r => r.from_currency))].sort((a, b) =>
        ['USD', 'EUR', 'RUB'].indexOf(a) - ['USD', 'EUR', 'RUB'].indexOf(b));
    if (!currencies.includes(chartCur)) chartCur = currencies[0] || null;
    const join = (attr, items, active) => `<div class="join">${items.map(([v, label]) =>
        `<button class="join-item btn btn-sm ${String(v) === String(active) ? 'btn-active' : ''}" ${attr}="${v}">${e(label)}</button>`).join('')}</div>`;
    return `<div class="card bg-base-100 shadow-sm"><div class="card-body p-4">
        <div class="flex flex-wrap gap-2 mb-3">
            ${join('data-chart-cur', currencies.map(c => [c, c]), chartCur)}
            ${join('data-chart-mode', [['general', t('fin_general_rate')], ['retreats', tr('fin_rates_retreats', 'Курсы ретритов')], ['both', tr('fin_rates_both', 'Оба')]], chartMode)}
            ${join('data-chart-months', [[3, tr('fin_rates_p3', '3 мес')], [6, tr('fin_rates_p6', '6 мес')], [12, tr('fin_rates_p12', 'Год')], [0, tr('fin_rates_all', 'Всё')]], chartMonths)}
        </div>
        <div class="relative h-80"><canvas id="ratesChart"></canvas></div>
        <div id="ratesChartEmpty" class="hidden text-center text-sm opacity-60 py-6">${e(tr('fin_rates_chart_empty', 'За этот период курсов нет'))}</div>
    </div></div>`;
}

async function drawRatesChart() {
    let Chart;
    try { Chart = await loadChartLib(); } catch {
        document.getElementById('ratesChart')?.replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') }));
        return;
    }
    const canvas = document.getElementById('ratesChart');
    if (!canvas) return;
    if (ratesChart) { ratesChart.destroy(); ratesChart = null; }

    const ts = iso => DateUtils.parseDate(iso).getTime();
    const s = splitRates();
    const general = [...s.general, ...s.archGeneral].filter(r => r.from_currency === chartCur)
        .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    const retreats = [...s.retreats, ...s.archRetreats]
        .map(g => ({ ...g, rate: g.rates.find(r => r.from_currency === chartCur) })).filter(g => g.rate);

    // Ось — от начала периода до сегодня (или до последней будущей даты)
    const today = FinUtils.todayISO();
    const lastIso = [today, ...general.map(r => r.effective_date), ...retreats.map(g => g.end)].sort().pop();
    const firstIso = [...general.map(r => r.effective_date), ...retreats.map(g => g.start)].sort()[0] || today;
    const max = ts(lastIso);
    let min = ts(firstIso);
    if (chartMonths) {
        const d = DateUtils.parseDate(today); d.setMonth(d.getMonth() - chartMonths);
        min = Math.max(min, d.getTime());
    }

    const datasets = [];
    if (chartMode !== 'retreats') {
        // Общий курс держится до следующей записи — ступенькой
        // точки — только там, где курс сменился: тот же курс вносят каждую неделю
        const before = general.filter(r => ts(r.effective_date) <= min).pop();
        const pts = [];
        if (before) pts.push({ x: min, y: Number(before.rate) });
        for (const r of general.filter(r => ts(r.effective_date) > min)) {
            if (!pts.length || pts[pts.length - 1].y !== Number(r.rate)) pts.push({ x: ts(r.effective_date), y: Number(r.rate) });
        }
        if (pts.length) pts.push({ x: max, y: pts[pts.length - 1].y, edge: true });
        // 'before' в Chart.js: значение держится до следующей точки, потом ступенька
        if (pts.length) datasets.push({ label: t('fin_general_rate'), data: pts, stepped: 'before', borderColor: RATE_COLORS.general,
            backgroundColor: RATE_COLORS.general, borderWidth: 2, pointRadius: pts.map(p => p.edge || p.x === min ? 0 : 3) });
    }
    if (chartMode !== 'general') {
        // Курс ретрита — отрезок на даты ретрита, разрыв между ретритами
        const pts = [];
        for (const g of retreats.sort((a, b) => a.start.localeCompare(b.start))) {
            const a = ts(g.start), b = ts(g.end);
            if (b < min || a > max) continue;
            const y = Number(g.rate.rate);
            pts.push({ x: Math.max(a, min), y, name: g.name }, { x: Math.min(b, max), y, name: g.name }, { x: Math.min(b, max), y: null });
        }
        if (pts.length) datasets.push({ label: tr('fin_rates_retreats', 'Курсы ретритов'), data: pts, spanGaps: false,
            borderColor: RATE_COLORS.retreats, backgroundColor: RATE_COLORS.retreats, borderWidth: 4, pointRadius: 3 });
    }

    document.getElementById('ratesChartEmpty').classList.toggle('hidden', datasets.length > 0);
    canvas.parentElement.classList.toggle('hidden', !datasets.length);
    if (!datasets.length) return;

    const day = v => DateUtils.formatShort(new Date(v));
    ratesChart = new Chart(canvas, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false, parsing: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 12 } },
                tooltip: { callbacks: {
                    title: items => day(items[0].raw.x),
                    label: c => `${c.raw.name || c.dataset.label}: ${c.raw.y} ₹`
                } }
            },
            scales: {
                x: { type: 'linear', min, max, ticks: { maxTicksLimit: 8, callback: day } },
                y: { ticks: { callback: v => Number(v).toLocaleString('ru-RU') } }
            }
        }
    });
}

function wireRatesView() {
    document.getElementById('ratesView').addEventListener('click', ev => {
        const tab = ev.target.closest('[data-rates-tab]');
        const edit = ev.target.closest('[data-edit]');
        const add = ev.target.closest('[data-add-rate-for]');
        const cur = ev.target.closest('[data-chart-cur]');
        const mode = ev.target.closest('[data-chart-mode]');
        const months = ev.target.closest('[data-chart-months]');
        if (tab) { ratesTab = tab.dataset.ratesTab; renderRates(); }
        else if (edit) openForm(rows.find(r => r.id === edit.dataset.edit));
        else if (add) {
            openForm(null);
            const sel = document.getElementById('f_obj');
            if (sel) sel.value = add.dataset.addRateFor;
        }
        else if (cur) { chartCur = cur.dataset.chartCur; renderRates(); }
        else if (mode) { chartMode = mode.dataset.chartMode; renderRates(); }
        else if (months) { chartMonths = Number(months.dataset.chartMonths); renderRates(); }
    });
}

// ==================== СЧЕТА ДЕПАРТАМЕНТА ====================
// Подотчётные счета раньше рождались только сами — при первой передаче денег.
// Из-за этого счёт, заведённый руками на странице «Счета», оказывался ничьим
// и не появлялся в списке получателей (случай ВГ со «Стройкой», 05.08.2026).
// box = true — «Касса ДДС у департамента»: деньги ДДС, которые лишь хранятся
// у департамента (Касса ДДС у ГХ, мигр. 711) — за ним не числятся, поэтому
// отдельным блоком и своей функцией заведения (мигр. 748, ВГ 24.10).
function deptAccountsHtml(deptId, box = false) {
    const own = FinUtils.refs.accounts
        .filter(a => a.is_active && (box
            ? a.cashbox_department_id === deptId
            : a.department_id === deptId && a.kind === 'custodial'));
    const have = new Set(own.map(a => a.currency_code));
    const canAdd = FinUtils.refs.currencies.filter(c => !have.has(c.code));

    // кассу ДДС можно передать другому департаменту: привязать любую наличную
    // кассу ДДС в недостающей валюте, ✕ — открепить (мигр. 749, ВГ 24.10)
    const deptName = id => rows.find(d => d.id === id)?.name || '';
    const canAttach = box ? FinUtils.refs.accounts.filter(a => a.is_active && a.kind === 'real'
        && a.reconciliation_mode === 'cash_count' && !have.has(a.currency_code)) : [];

    const list = own.length
        ? own.map(a => `<div class="flex justify-between items-center gap-2 text-sm py-0.5">
               <span>${e(a.name)}</span>
               <span class="flex items-center gap-1">
                   <span class="font-mono opacity-70">${FinUtils.fmtMoney(a.balance, a.currency_code)}</span>
                   ${box ? `<button type="button" class="btn btn-ghost btn-xs px-1"
                       onclick="FinDicts.moveCashbox('${deptId}', '${a.account_id}', null)">✕</button>` : ''}
               </span>
           </div>`).join('')
        : `<div class="text-sm opacity-60">${t(box ? 'fin_dept_no_cashbox' : 'fin_dept_no_accounts')}</div>`;

    return `<div class="form-control mb-2" id="${box ? 'deptCashboxBlock' : 'deptAccountsBlock'}">
        <label class="label py-0"><span class="label-text">${t(box ? 'fin_dept_cashbox' : 'fin_dept_accounts')}</span></label>
        <div class="border border-base-300 rounded-lg p-2">
            ${list}
            ${canAdd.length ? `<div class="flex gap-2 mt-2">
                <select id="${box ? 'f_box_currency' : 'f_acc_currency'}" class="select select-bordered select-xs">
                    ${canAdd.map(c => `<option value="${c.code}">${e(c.code)}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-outline btn-xs"
                        onclick="FinDicts.addAccount('${deptId}', ${box})">${t(box ? 'fin_dept_add_cashbox' : 'fin_dept_add_account')}</button>
            </div>` : ''}
            ${canAttach.length ? `<div class="flex gap-2 mt-2">
                <select id="f_box_attach" class="select select-bordered select-xs min-w-0 flex-1">
                    ${canAttach.map(a => `<option value="${a.account_id}">${e(a.name)}${a.cashbox_department_id
                        ? ` — ${t('fin_dept_cashbox_now_at')} ${e(deptName(a.cashbox_department_id))}` : ''}</option>`).join('')}
                </select>
                <button type="button" class="btn btn-outline btn-xs"
                        onclick="FinDicts.moveCashbox('${deptId}', document.getElementById('f_box_attach').value, '${deptId}')">${t('fin_dept_attach_cashbox')}</button>
            </div>` : ''}
        </div>
    </div>`;
}

// ==================== СОТРУДНИКИ ДЕПАРТАМЕНТА (зарплата) ====================
// Позиция ≠ сам вайшнава: один человек может побывать в нескольких
// департаментах, у каждой позиции своя история оклада (438_fin_payroll.sql).
// Список грузится по требованию (при открытии формы департамента), а не
// вместе со справочниками — сотрудники не нужны почти никому, кроме этой формы.
let deptEmployees = {};   // { department_id: [позиция, …] }
let editingEmployeeId = null;

async function loadDeptEmployees(deptId) {
    const { data } = await Layout.db.from('fin_v_payroll_positions')
        .select('*').eq('department_id', deptId).order('employee_name');
    deptEmployees[deptId] = data || [];
    return deptEmployees[deptId];
}

function resetEmployeeForm() {
    editingEmployeeId = null;
    const search = document.getElementById('f_emp_search');
    if (search) { search.value = ''; search.disabled = false; }
    const vais = document.getElementById('f_emp_vaishnava');
    if (vais) vais.value = '';
    const title = document.getElementById('f_emp_title');
    if (title) title.value = '';
    const salary = document.getElementById('f_emp_salary');
    if (salary) salary.value = '';
    const from = document.getElementById('f_emp_from');
    if (from) from.value = FinUtils.todayISO();
    const btn = document.querySelector('[data-add-employee]');
    if (btn) btn.textContent = t('fin_add');
    const cancel = document.getElementById('f_emp_cancel');
    if (cancel) cancel.classList.add('hidden');
}

function fillEmployeeForm(p) {
    editingEmployeeId = p.id;
    const search = document.getElementById('f_emp_search');
    if (search) { search.value = p.employee_name; search.disabled = true; }
    document.getElementById('f_emp_vaishnava').value = p.vaishnava_id;
    document.getElementById('f_emp_title').value = p.position_title || '';
    document.getElementById('f_emp_salary').value = p.salary_amount ?? '';
    document.getElementById('f_emp_from').value = p.effective_from;
    const btn = document.querySelector('[data-add-employee]');
    if (btn) btn.textContent = t('save');
    const cancel = document.getElementById('f_emp_cancel');
    if (cancel) cancel.classList.remove('hidden');
}

// Кэш переводов в браузере может не знать новых ключей — подставляем запасной текст
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

// Завершённые периоды тех, кто сейчас в департаменте не числится: по одному
// (последнему) на человека — иначе список зарастёт историей переходов
function endedPeriods(deptId) {
    const all = deptEmployees[deptId] || [];
    const active = new Set(all.filter(p => p.is_current).map(p => p.vaishnava_id));
    const latest = new Map();
    for (const p of all.filter(x => !x.is_current && !active.has(x.vaishnava_id))) {
        const prev = latest.get(p.vaishnava_id);
        if (!prev || (p.effective_to || '') > (prev.effective_to || '')) latest.set(p.vaishnava_id, p);
    }
    return [...latest.values()];
}

// «Вернуть» — та же операция «добавить сотрудника», только форма уже заполнена
// прошлой должностью и окладом; создаётся новый период, старый остаётся историей
function fillReturnForm(deptId, positionId) {
    const p = (deptEmployees[deptId] || []).find(x => x.id === positionId);
    if (!p) return;
    editingEmployeeId = null;
    const search = document.getElementById('f_emp_search');
    search.value = p.employee_name;
    search.disabled = false;
    document.getElementById('f_emp_vaishnava').value = p.vaishnava_id;
    document.getElementById('f_emp_title').value = p.position_title || '';
    document.getElementById('f_emp_salary').value = p.salary_amount ?? '';
    const from = document.getElementById('f_emp_from');
    from.value = FinUtils.todayISO();
    const btn = document.querySelector('[data-add-employee]');
    if (btn) btn.textContent = t('fin_add');
    document.getElementById('f_emp_cancel')?.classList.remove('hidden');
    from.focus();
}

function deptEmployeesHtml(deptId) {
    const current = (deptEmployees[deptId] || []).filter(p => p.is_current);
    const ended = endedPeriods(deptId);
    const endedRows = ended.map(p => `<div class="flex justify-between items-center gap-2 text-sm py-1 border-b border-base-200 last:border-0 opacity-60">
            <div class="truncate">
                <div>${e(p.employee_name)} <span class="opacity-70">— ${e(p.position_title)}</span></div>
                <div class="text-xs">${tr('fin_payroll_ended_on', 'период до')} ${DateUtils.formatShort(DateUtils.parseDate(p.effective_to))}</div>
            </div>
            <button type="button" class="btn btn-outline btn-xs shrink-0" data-return-employee="${p.id}">${tr('fin_payroll_return', 'Вернуть')}</button>
        </div>`).join('');
    const activeRows = current.map(p => `<div class="flex justify-between items-center gap-2 text-sm py-1 border-b border-base-200 last:border-0">
            <div class="truncate">
                <div>${e(p.employee_name)} <span class="opacity-60">— ${e(p.position_title)}</span></div>
                <div class="opacity-60 text-xs">${p.salary_amount != null
                    ? `${FinUtils.fmtMoney(p.salary_amount, p.currency_code)} / ${t('fin_payroll_month')}`
                    : t('fin_payroll_no_salary')}</div>
            </div>
            <div class="flex gap-1 shrink-0">
                <button type="button" class="btn btn-ghost btn-xs" data-edit-employee="${p.id}" title="${t('edit')}">${editIcon}</button>
                <button type="button" class="btn btn-ghost btn-xs text-error" data-end-employee="${p.id}" title="${t('fin_payroll_terminate')}">${FinUtils.ICONS.x}</button>
            </div>
        </div>`).join('');
    const rows = (activeRows || endedRows)
        ? activeRows + endedRows
        : `<div class="text-sm opacity-60">${t('fin_payroll_no_employees')}</div>`;

    return `<div class="form-control mb-2">
        <label class="label py-0"><span class="label-text">${t('fin_payroll_employees_section')}</span></label>
        <div class="border border-base-300 rounded-lg p-2" id="f_emp_list">
            ${rows}
        </div>
        <div class="mt-2 space-y-1">
            <input type="text" id="f_emp_search" class="input input-bordered input-xs w-full" autocomplete="off" placeholder="${t('fin_payroll_find_person')}">
            <input type="hidden" id="f_emp_vaishnava">
            <button type="button" class="link link-primary text-xs" data-create-person>${t('fin_payroll_create_person')}</button>
            <div class="flex gap-1">
                <input type="text" id="f_emp_title" class="input input-bordered input-xs flex-1" placeholder="${t('fin_payroll_position_placeholder')}">
                <input type="number" id="f_emp_salary" class="input input-bordered input-xs w-28" min="0.01" step="0.01" placeholder="${t('fin_payroll_salary_placeholder')}">
            </div>
            <div class="flex gap-1 items-center">
                <label class="text-xs opacity-60 shrink-0" for="f_emp_from">${t('fin_payroll_effective_from')}</label>
                <input type="date" id="f_emp_from" class="input input-bordered input-xs" value="${FinUtils.todayISO()}">
                <button type="button" class="btn btn-outline btn-xs ml-auto" data-add-employee="${deptId}">${t('fin_add')}</button>
                <button type="button" id="f_emp_cancel" class="btn btn-ghost btn-xs hidden" data-cancel-employee>${t('fin_payroll_cancel_edit')}</button>
            </div>
            <div class="text-xs opacity-50">${t('fin_payroll_backdate_hint')}</div>
        </div>
    </div>`;
}

function wireEmployeeSection(deptId) {
    const search = document.getElementById('f_emp_search');
    const hidden = document.getElementById('f_emp_vaishnava');
    if (search && hidden) FinUtils.attachPersonSearch(search, hidden);
}

async function refreshEmployeesBlock(deptId) {
    await loadDeptEmployees(deptId);
    const box = document.getElementById('dictFields');
    const fresh = document.createElement('div');
    fresh.innerHTML = deptEmployeesHtml(deptId);
    const old = [...box.querySelectorAll('.form-control')]
        .find(el => el.textContent.includes(t('fin_payroll_employees_section')));
    if (old) old.replaceWith(fresh.firstElementChild);
    resetEmployeeForm();
    wireEmployeeSection(deptId);
}

async function saveEmployee(deptId) {
    const vaishnavaId = document.getElementById('f_emp_vaishnava').value;
    const title = document.getElementById('f_emp_title').value.trim();
    const salary = document.getElementById('f_emp_salary').value;
    if (!editingEmployeeId && !vaishnavaId) {
        Layout.showNotification(t('fin_payroll_find_person'), 'error');
        return;
    }
    if (!title) {
        Layout.showNotification(t('fin_payroll_position'), 'error');
        return;
    }
    const current = editingEmployeeId
        ? (deptEmployees[deptId] || []).find(p => p.id === editingEmployeeId)
        : null;
    const res = await FinUtils.rpc('fin_save_payroll_position', {
        id: editingEmployeeId || null,
        vaishnava_id: current ? current.vaishnava_id : vaishnavaId,
        department_id: deptId,
        position_title: title,
        salary_amount: salary || null,
        currency_code: current?.currency_code || 'INR',
        effective_from: document.getElementById('f_emp_from').value || FinUtils.todayISO()
    });
    if (FinUtils.handleResult(res)) await refreshEmployeesBlock(deptId);
}

// Местные сотрудники без компьютера и интернета не зарегистрируются, но им
// платят зарплату — заводим техническую запись прямо отсюда и сразу выбираем её
async function createTechnicalPerson() {
    const name = prompt(t('fin_payroll_create_person_prompt'));
    if (!name || !name.trim()) return;
    const res = await FinUtils.rpc('fin_create_technical_person', { name });
    if (!FinUtils.handleResult(res)) return;
    document.getElementById('f_emp_search').value = res.result.name;
    document.getElementById('f_emp_vaishnava').value = res.result.id;
}

async function endEmployee(deptId, positionId) {
    if (!confirm(t('fin_payroll_terminate_confirm'))) return;
    const res = await FinUtils.rpc('fin_end_payroll_position', { id: positionId, effective_to: null });
    if (FinUtils.handleResult(res)) await refreshEmployeesBlock(deptId);
}

async function addDeptAccount(deptId, box = false) {
    const currency = document.getElementById(box ? 'f_box_currency' : 'f_acc_currency')?.value;
    if (!currency) return;
    const res = await FinUtils.rpc(box ? 'fin_add_department_cashbox' : 'fin_add_department_account', {
        p_department: deptId, p_currency: currency
    });
    if (!FinUtils.handleResult(res)) return;
    Layout.showNotification(t(box ? 'fin_dept_cashbox_added' : 'fin_dept_account_added'), 'success');
    // счёт создан — обновляем справочник и перерисовываем блок
    await FinUtils.reloadAccounts();
    const fresh = document.createElement('div');
    fresh.innerHTML = deptAccountsHtml(deptId, box);
    document.getElementById(box ? 'deptCashboxBlock' : 'deptAccountsBlock')?.replaceWith(fresh.firstElementChild);
}

async function moveCashbox(deptId, accountId, targetDept) {
    if (!accountId) return;
    if (!targetDept) {
        const name = FinUtils.refs.accounts.find(a => a.account_id === accountId)?.name || '';
        if (!confirm(t('fin_dept_detach_cashbox_confirm').replace('{name}', name))) return;
    }
    const res = await FinUtils.rpc('fin_set_account_cashbox_department', {
        p_account: accountId, p_department: targetDept
    });
    if (!FinUtils.handleResult(res)) return;
    Layout.showNotification(t(targetDept ? 'fin_dept_cashbox_moved' : 'fin_dept_cashbox_detached'), 'success');
    await FinUtils.reloadAccounts();
    const fresh = document.createElement('div');
    fresh.innerHTML = deptAccountsHtml(deptId, true);
    document.getElementById('deptCashboxBlock')?.replaceWith(fresh.firstElementChild);
}

// ==================== ФОРМЫ ====================
function fieldHtml(id, labelKey, inputHtml) {
    return `<div class="form-control mb-2">
        <label class="label py-0"><span class="label-text">${t(labelKey)}</span></label>
        ${inputHtml}
    </div>`;
}

function openForm(row) {
    editingId = row?.id || null;
    const fields = document.getElementById('dictFields');
    const title = document.getElementById('dictModalTitle');
    title.textContent = t(row ? 'edit' : 'fin_add');

    if (currentTab === 'categories') {
        fields.innerHTML =
            fieldHtml('f_code', 'col_code', `<input type="text" id="f_code" class="input input-bordered input-sm" value="${e(row?.code || '')}" required>`) +
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            fieldHtml('f_dir', 'fin_direction', `<select id="f_dir" class="select select-bordered select-sm" ${row ? 'disabled' : ''}>
                <option value="in" ${row?.direction === 'in' ? 'selected' : ''}>${t('fin_dir_in')}</option>
                <option value="out" ${row?.direction === 'out' ? 'selected' : ''}>${t('fin_dir_out')}</option></select>`) +
            `<div class="form-control mb-2"><label class="label cursor-pointer justify-start gap-3 py-1">
                <input type="checkbox" id="f_visible" class="checkbox checkbox-sm" ${row?.visible_to_departments ? 'checked' : ''}>
                <span class="label-text">${t('fin_visible_departments')}</span></label></div>` +
            activeCheckbox(row);
    } else if (currentTab === 'cost_centers') {
        fields.innerHTML =
            fieldHtml('f_code', 'col_code', `<input type="text" id="f_code" class="input input-bordered input-sm" value="${e(row?.code || '')}" required>`) +
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            activeCheckbox(row);
    } else if (currentTab === 'contractors') {
        fields.innerHTML =
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            fieldHtml('f_type', 'fin_person_org', `<select id="f_type" class="select select-bordered select-sm">
                <option value="person" ${row?.type === 'person' ? 'selected' : ''}>${t('fin_person')}</option>
                <option value="organization" ${row?.type === 'organization' ? 'selected' : ''}>${t('fin_organization')}</option></select>`) +
            fieldHtml('f_info', 'fin_comment', `<input type="text" id="f_info" class="input input-bordered input-sm" value="${e(row?.contact_info || '')}">`) +
            activeCheckbox(row);
    } else if (currentTab === 'departments') {
        const deptCats = deptCategories[row?.id] || [];
        // Чат выбираем из тех, где бот уже побывал. Занятые другим департаментом
        // показываем с подписью: выбрать можно, но видно, что он переедет.
        const chatOpts = (knownChats || []).map(c => {
            const busy = c.linked_department_id && c.linked_department_id !== row?.id;
            return `<option value="${c.chat_id}" ${String(c.chat_id) === String(row?.chat_id || '') ? 'selected' : ''}>${
                e(c.title || c.chat_id)}${busy ? ` — ${t('fin_dept_chat_busy')}: ${e(c.linked_department)}` : ''}</option>`;
        }).join('');
        fields.innerHTML =
            fieldHtml('f_name', 'col_name', `<input type="text" id="f_name" class="input input-bordered input-sm" value="${e(row?.name || '')}" required>`) +
            // Один список департаментов на всё приложение (691): цвет и «у людей» —
            // для карточки человека, шахматки и Себестоимости
            fieldHtml('f_color', 'fin_dept_color', `<input type="color" id="f_color" class="input input-bordered input-sm w-20 p-1" value="${Utils.isValidColor(row?.color) ? row.color : '#6b7280'}">`) +
            `<div class="form-control mb-2"><label class="label cursor-pointer justify-start gap-3 py-1">
                <input type="checkbox" id="f_for_people" class="checkbox checkbox-sm" ${!row || row.for_people ? 'checked' : ''}>
                <span class="label-text">${t('fin_dept_for_people')}</span></label>
                <span class="text-xs opacity-60">${t('fin_dept_for_people_hint')}</span></div>` +
            `<div class="form-control mb-2">
                <label class="label py-0"><span class="label-text">${t('fin_responsible')}</span></label>
                <input type="text" id="f_resp_search" class="input input-bordered input-sm" autocomplete="off" value="${e(row?.responsible_name || '')}">
                <input type="hidden" id="f_resp" value="${e(row?.responsible_person_id || '')}">
            </div>` +
            // Кто ещё видит департамент — видят всё, что глава (ВГ 18.10); только люди со входом
            `<div class="form-control mb-2">
                <label class="label py-0"><span class="label-text">${t('fin_dept_viewers')}</span></label>
                <div id="f_viewers" class="flex flex-wrap gap-1 mb-1"></div>
                <input type="text" id="f_viewer_search" class="input input-bordered input-sm" autocomplete="off" placeholder="${t('fin_dept_viewers_add')}">
                <input type="hidden" id="f_viewer_pick" value="">
                <span class="text-xs opacity-60 mt-1">${t('fin_dept_viewers_hint')}</span>
            </div>` +
            fieldHtml('f_chat', 'fin_dept_chat', `<select id="f_chat" class="select select-bordered select-sm">
                <option value="">${t('fin_dept_no_chat')}</option>${chatOpts}</select>`) +
            // Свой набор статей: пусто = общий набор. Так добавление новой общей
            // статьи не требует обходить все департаменты (просьба ВГ, 26.07).
            `<div class="form-control mb-2">
                <label class="label py-0"><span class="label-text">${t('fin_dept_categories')}</span></label>
                <div class="max-h-40 overflow-y-auto border border-base-300 rounded-lg p-2" id="f_cats">
                    ${FinUtils.refs.categories.filter(c => c.is_active && c.direction === 'out').map(c => `
                        <label class="label cursor-pointer justify-start gap-2 py-0.5">
                            <input type="checkbox" class="checkbox checkbox-xs dept-cat" value="${c.id}"
                                   ${deptCats.includes(c.id) ? 'checked' : ''}>
                            <span class="label-text text-sm">${e(c.name)}${
                                // Отмеченная здесь статья попадёт к департаменту даже без
                                // общего флага — набор сильнее. Подписываем, чтобы такую
                                // не отметить случайно (просьба ВГ 05.08.2026).
                                c.visible_to_departments ? ''
                                  : ` <span class="opacity-50 text-xs">— ${t('fin_cat_hidden_from_depts')}</span>`
                            }</span>
                        </label>`).join('')}
                </div>
                <span class="text-xs opacity-60 mt-1">${t('fin_dept_categories_hint')}</span>
            </div>` +
            // Статьи выручки: выручка магазина ложится на Кассу/Гест-хаус, а не на счёт департамента (ВГ 18.10)
            `<div class="form-control mb-2">
                <label class="label py-0"><span class="label-text">${t('fin_dept_income_categories')}</span></label>
                <div class="max-h-40 overflow-y-auto border border-base-300 rounded-lg p-2">
                    ${FinUtils.refs.categories.filter(c => c.direction === 'in' && (c.is_active || (deptIncome[row?.id] || []).includes(c.id))).map(c => `
                        <label class="label cursor-pointer justify-start gap-2 py-0.5">
                            <input type="checkbox" class="checkbox checkbox-xs dept-income-cat" value="${c.id}"
                                   ${(deptIncome[row?.id] || []).includes(c.id) ? 'checked' : ''}>
                            <span class="label-text text-sm">${e(c.name)}</span>
                        </label>`).join('')}
                </div>
                <span class="text-xs opacity-60 mt-1">${t('fin_dept_income_categories_hint')}</span>
            </div>` +
            // Счета департамента — здесь, а не на странице «Счета»: там нельзя
            // указать департамент, и счёт оказывался ничьим (случай ВГ со
            // «Стройкой», 05.08.2026). У нового департамента блока нет: сначала
            // сохраняем его, потом заводим счета.
            (row?.id ? deptAccountsHtml(row.id) + deptAccountsHtml(row.id, true) : '') +
            // Сотрудники — тоже только у уже сохранённого департамента (позиция
            // ссылается на department_id, у нового департамента его пока нет)
            (row?.id ? deptEmployeesHtml(row.id) : '') +
            `<p class="text-xs opacity-60 mt-1">${t('fin_dept_hint')}</p>`;
    } else {
        // Курс правится и удаляется (вопрос ВГ: «ни удалить, ни изменить?»).
        // Валюта, дата и объект — это ключ записи: меняя их, вы правите уже
        // другой курс, поэтому при правке они заперты. Прошлые операции курс
        // не трогает вовсе: проводка хранит собственный rate_used.
        const lock = row ? 'disabled' : '';
        fields.innerHTML =
            fieldHtml('f_cur', 'fin_currency', `<select id="f_cur" class="select select-bordered select-sm" ${lock}>${
                FinUtils.refs.currencies.filter(c => c.is_active && c.code !== 'INR')
                    .map(c => `<option value="${c.code}" ${row?.from_currency === c.code ? 'selected' : ''}>${e(c.symbol)} ${c.code}</option>`).join('')}</select>`) +
            fieldHtml('f_date', 'fin_effective_date', `<input type="date" id="f_date" class="input input-bordered input-sm" value="${e(row?.effective_date || FinUtils.todayISO())}" ${lock} required>`) +
            fieldHtml('f_rate', 'fin_rate', `<input type="number" id="f_rate" class="input input-bordered input-sm" min="0.000001" step="0.000001" value="${e(row?.rate ?? '')}" required>`) +
            fieldHtml('f_obj', 'fin_retreat_object', `<select id="f_obj" class="select select-bordered select-sm" ${lock}>
                <option value="">${t('fin_general_rate')}</option>${
                FinUtils.refs.objects.map(o => `<option value="${o.id}" ${row?.object_id === o.id ? 'selected' : ''}>${e(o.display_name)}</option>`).join('')}</select>`) +
            (row ? `<p class="text-xs opacity-60 mt-2">${t('fin_rate_history_note')}</p>
                    <button type="button" class="btn btn-outline btn-error btn-sm mt-2" id="f_rate_delete">${t('delete')}</button>` : '');
    }
    // Поля формы пересоздаются каждый раз, поэтому подсказку по людям вешаем здесь,
    // а не в init — иначе она указывала бы на удалённый input.
    if (currentTab === 'departments') {
        FinUtils.attachPersonSearch(document.getElementById('f_resp_search'), document.getElementById('f_resp'));
        wireViewers(row?.id);
        if (row?.id) {
            resetEmployeeForm();
            wireEmployeeSection(row.id);
            refreshEmployeesBlock(row.id);   // список сотрудников грузится асинхронно, по требованию
        }
    }
    const delBtn = document.getElementById('f_rate_delete');
    if (delBtn) delBtn.addEventListener('click', () => deleteRate(editingId));
    document.getElementById('dictModal').showModal();
}

// Список «Кто ещё видит» в форме: плашки с крестиком + поиск человека со входом
let formViewers = [];
function wireViewers(deptId) {
    formViewers = (deptViewers[deptId] || []).map(v => ({ ...v }));
    const box = document.getElementById('f_viewers');
    const input = document.getElementById('f_viewer_search');
    const pick = document.getElementById('f_viewer_pick');
    const draw = () => {
        box.innerHTML = formViewers.map(v => `<span class="badge badge-outline gap-1 py-3">${e(v.name)}
            <button type="button" class="opacity-60 hover:opacity-100" data-viewer-remove="${v.id}" aria-label="${t('delete')}"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg></button></span>`).join('');
    };
    box.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-viewer-remove]');
        if (!btn) return;
        formViewers = formViewers.filter(v => v.id !== btn.dataset.viewerRemove);
        draw();
    });
    pick.addEventListener('change', () => {
        if (pick.value && !formViewers.some(v => v.id === pick.value)) formViewers.push({ id: pick.value, name: input.value });
        pick.value = ''; input.value = '';
        draw();
    });
    FinUtils.attachPersonSearch(input, pick, true);
    draw();
}

function activeCheckbox(row) {
    return `<div class="form-control mb-2"><label class="label cursor-pointer justify-start gap-3 py-1">
        <input type="checkbox" id="f_active" class="checkbox checkbox-sm" ${!row || row.is_active ? 'checked' : ''}>
        <span class="label-text">${t('fin_active')}</span></label></div>`;
}

async function deleteRate(id) {
    // Курс удаляют, когда завели по ошибке, — но если это последний общий курс
    // валюты, приход в ней перестанет проводиться вовсе. Предупреждаем отдельно
    // и жёстче: ошибку ввода легко перепутать с последней опорой (решение ВГ, 30.07.2026).
    const rate = rows.find(r => r.id === id);
    const isLastCommon = rate && !rate.object_id
        && rows.filter(r => r.from_currency === rate.from_currency && !r.object_id).length === 1;
    if (isLastCommon) {
        // Правило ВГ (30.07.2026): кнопка удаления — только для ошибочно созданных
        // курсов, а опорный удалять не нужно. Поэтому спрашиваем дважды и разными
        // словами: случайный клик так не проходит, а осознанное удаление возможно.
        if (!confirm(t('fin_rate_delete_last').replace('{cur}', rate.from_currency))) return;
        if (!confirm(t('fin_rate_delete_last2').replace('{cur}', rate.from_currency))) return;
    } else if (!confirm(t('fin_rate_delete_confirm'))) {
        return;
    }
    const res = await FinUtils.rpc('fin_delete_exchange_rate', { id });
    if (FinUtils.handleResult(res)) {
        document.getElementById('dictModal').close();
        await loadTab();
        // Валюта осталась без опоры — сразу открываем форму нового курса, чтобы
        // не разойтись с реальностью: «если удалить, то нужно сразу создать новый».
        if (isLastCommon) {
            Layout.showNotification(t('fin_rate_create_now').replace('{cur}', rate.from_currency), 'warning');
            openForm(null);
        }
    }
}

async function submitForm(ev) {
    ev.preventDefault();
    const val = id => document.getElementById(id)?.value;
    const checked = id => !!document.getElementById(id)?.checked;
    let res;

    if (currentTab === 'categories') {
        res = await FinUtils.rpc('fin_save_category', {
            id: editingId, code: val('f_code'), name: val('f_name'),
            direction: val('f_dir'), visible_to_departments: checked('f_visible'), is_active: checked('f_active')
        });
    } else if (currentTab === 'cost_centers') {
        res = await FinUtils.rpc('fin_save_cost_center', {
            id: editingId, code: val('f_code'), name: val('f_name'), is_active: checked('f_active')
        });
    } else if (currentTab === 'contractors') {
        res = await FinUtils.rpc('fin_save_contractor', {
            id: editingId, name: val('f_name'), type: val('f_type'),
            contact_info: val('f_info') || null, is_active: checked('f_active')
        });
    } else if (currentTab === 'departments') {
        // Ключи передаём всегда — форма показывает оба поля, значит пустое
        // значение это осознанное «нет», а не «не трогай».
        res = await FinUtils.rpc('fin_save_department', {
            id: editingId, name: val('f_name'),
            responsible_person_id: val('f_resp') || null,
            chat_id: val('f_chat') || null,
            color: val('f_color') || null,
            for_people: checked('f_for_people'),
            category_ids: [...document.querySelectorAll('.dept-cat:checked')].map(i => i.value),
            viewer_ids: formViewers.map(v => v.id)
        });
        if (res?.ok) {
            knownChats = null;   // привязки изменились — перечитаем список чатов
            const { data, error } = await Layout.db.rpc('fin_save_department_income', {
                p_department: res.result?.id || editingId,
                p_category_ids: [...document.querySelectorAll('.dept-income-cat:checked')].map(i => i.value)
            });
            res = error ? { ok: false, error: { code: error.code, message: error.message } } : data;
        }
    } else {
        res = await FinUtils.rpc('fin_save_exchange_rate', {
            object_id: val('f_obj') || null, effective_date: val('f_date'),
            from_currency: val('f_cur'), rate: val('f_rate')
        });
    }

    if (FinUtils.handleResult(res)) {
        document.getElementById('dictModal').close();
        // Справочник поправили — обновляем общий кэш, иначе новая статья не
        // появится в наборе департамента, пока не перезагрузишь страницу
        await FinUtils.refreshRefs();
        await loadTab();
    }
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_dictionaries', itemId: 'fin_dictionaries' });
    await FinUtils.loadRefs();

    document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('[role="tab"]').forEach(x => x.classList.remove('tab-active'));
        tab.classList.add('tab-active');
        currentTab = tab.dataset.tab;
        loadTab();
    }));

    document.getElementById('dictSearch').addEventListener('input', Layout.debounce(ev => {
        dictQuery = ev.target.value; renderTab();
    }, 200));
    document.querySelectorAll('#dirFilter [data-dir]').forEach(btn => btn.addEventListener('click', () => {
        dictDir = btn.dataset.dir;
        document.querySelectorAll('#dirFilter [data-dir]').forEach(b => b.classList.toggle('btn-active', b === btn));
        renderTab();
    }));

    document.getElementById('dictBody').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-edit]');
        if (btn) openForm(rows.find(r => r.id === btn.dataset.edit));
    });

    document.getElementById('dictForm').addEventListener('submit', submitForm);
    wireRatesView();

    // Кнопки сотрудников живут внутри dictFields, который каждый openForm
    // пересобирает целиком — вешаем один делегированный слушатель на форму
    document.getElementById('dictForm').addEventListener('click', ev => {
        const add = ev.target.closest('[data-add-employee]');
        const edit = ev.target.closest('[data-edit-employee]');
        const end = ev.target.closest('[data-end-employee]');
        const cancel = ev.target.closest('[data-cancel-employee]');
        const createPerson = ev.target.closest('[data-create-person]');
        const ret = ev.target.closest('[data-return-employee]');
        if (add) saveEmployee(add.dataset.addEmployee);
        else if (edit) fillEmployeeForm((deptEmployees[editingId] || []).find(p => p.id === edit.dataset.editEmployee));
        else if (end) endEmployee(editingId, end.dataset.endEmployee);
        else if (cancel) resetEmployeeForm();
        else if (createPerson) createTechnicalPerson();
        else if (ret) fillReturnForm(editingId, ret.dataset.returnEmployee);
    });

    // ?tab=rates — прямая ссылка из оповещения «общий курс устарел»
    const вкладка = new URLSearchParams(window.location.search).get('tab');
    const таб = вкладка && document.querySelector(`[role="tab"][data-tab="${CSS.escape(вкладка)}"]`);
    if (таб) {
        document.querySelectorAll('[role="tab"]').forEach(x => x.classList.remove('tab-active'));
        таб.classList.add('tab-active');
        currentTab = вкладка;
    }
    await loadTab();
}

window.FinDicts = { openAdd: () => openForm(null), addAccount: addDeptAccount, moveCashbox };
init();
})();
