// ==================== ПИТАНИЕ ПО ДЕПАРТАМЕНТАМ ====================
// Стоимость питания команды и волонтёров — расход их департамента (ВГ 04.11, «Департаменты 5»).
// Расчёт — KitchenCost.byDepartment: точная цена каждого приёма пищи, департамент места в шахматке →
// история служения на дату → «без департамента». Кухня и финансисты считают вживую (им видны цены и
// зарплаты), остальные главы — итоги по месяцам из базы (fin_dept_prasad, пересчёт раз в час, мигр. 779).
// Показ: вкладка «Питание» на странице департамента (Сводка / По месяцам / Графики),
// у Кухни и в Финансах → По департаментам — по всем департаментам.
// В «Аналитике»: у департамента — расчётная строка «Питание (прасад)», у Кухни — «Отнесено на департаменты −X».
window.DeptPrasad = (function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };
const inr = v => FinUtils.fmtMoney(Math.round(v), 'INR');
const num = v => (Math.round(v * 10) / 10).toLocaleString('ru-RU');
const fmtDay = iso => DateUtils.formatShort(DateUtils.parseDate(iso));
const START = '2026-08-01';   // реальные цены и меню — с августа 2026 (как prasad-dept-recalc)
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const { DEPT_NONE, DEPT_SHRSK, DEPT_UNMARKED } = typeof KitchenCost !== 'undefined' ? KitchenCost : {};

let departments = null;        // fin_departments: id, name, code, color
let liveAllowed = null;        // Кухня и финансисты — живой расчёт
const cache = new Map();       // `${department}|${from}|${to}` → Promise<строки deptPeriod>

async function loadDepartments() {
    if (!departments) {
        const { data } = await Layout.db.from('fin_departments').select('id, name, code, color');
        departments = data || [];
    }
    return departments;
}
const deptById = id => (departments || []).find(d => d.id === id);
const findDept = key => (departments || []).find(d => d.id === key || d.code === key || d.name === key);

function rowName(key) {
    if (key === DEPT_NONE) return tr('cost_no_department', 'Без департамента');
    if (key === DEPT_SHRSK) return tr('cost_shrsk_volunteers', 'Волонтёры ШРСК (общий расход)');
    if (key === DEPT_UNMARKED) return tr('cost_unmarked_row', 'Волонтёры ретрита — ретриты не отмечены');
    return deptById(key)?.name || '—';
}
const isRealDept = key => key !== DEPT_NONE && key !== DEPT_SHRSK && key !== DEPT_UNMARKED;

async function canLive() {
    if (liveAllowed === null) {
        const { data } = await Layout.db.rpc('fin_kitchen_can_view');
        liveAllowed = data === true;
    }
    return liveAllowed;
}

// Строки за период. department — код/id/название (свой департамент) или null (все — Кухня, Финансы).
// Пустой from/to — с начала учёта / по сегодня.
function load(department, from, to) {
    const today = DateUtils.toISO(new Date());
    const f = !from || from < START ? START : from;
    const tt = !to || to > today ? today : to;
    const key = `${department || ''}|${f}|${tt}`;
    if (!cache.has(key)) cache.set(key, (async () => {
        await loadDepartments();
        if (f > tt) return [];
        if (await canLive()) {
            const locationId = (Layout.locations || []).find(l => l.slug === 'main')?.id;
            const res = await KitchenCost.calculate(Layout.db, locationId, f, tt);
            const detail = await KitchenCost.loadDetail(Layout.db, f, tt);
            const src = await KitchenCost.loadDeptSources(Layout.db, detail);
            const dep = KitchenCost.byDepartment(res, detail, src);
            const names = await KitchenCost.loadDeptNames(Layout.db, dep);
            const all = KitchenCost.deptPeriod([KitchenCost.deptSummary(dep, names)], f, tt);
            const own = department && findDept(department);
            return department ? all.filter(g => g.key === own?.id) : all;
        }
        const { data, error } = await Layout.db.rpc('fin_dept_prasad', { p_department: department, p_from: f, p_to: tt });
        if (error) { console.error('fin_dept_prasad:', error); return []; }
        const byMonth = new Map();
        (data || []).forEach(r => (byMonth.get(r.month) || byMonth.set(r.month, []).get(r.month)).push(r.data));
        const list = KitchenCost.deptPeriod([...byMonth.values()], f, tt);
        list.computedAt = (data || []).reduce((m, r) => (!m || r.computed_at > m ? r.computed_at : m), null);
        return list;
    })());
    return cache.get(key);
}

// ---------- для «Аналитики» департамента ----------
// Расчётные строки (без проводок) по месяцам: у департамента — «Питание (прасад)»,
// у Кухни — «Отнесено на департаменты» с минусом (питание людей других департаментов
// уже не её расход, иначе по ашраму задвоится). «Без департамента» и волонтёры ШРСК остаются на Кухне.
function analyticsRows(list, department, from, to) {
    const own = findDept(department);
    const isKitchen = own?.code === 'kitchen';
    const label = isKitchen ? tr('dprasad_moved', 'Отнесено на департаменты') : tr('dprasad_line', 'Питание (прасад)');
    const byMonth = new Map();
    for (const g of list) {
        if (isKitchen ? !(isRealDept(g.key) && g.key !== own.id) : g.key !== own?.id) continue;
        for (const [d, x] of Object.entries(g.byDay)) {
            const m = byMonth.get(d.slice(0, 7)) || byMonth.set(d.slice(0, 7), { cost: 0, pm: 0, from: d }).get(d.slice(0, 7));
            m.cost += x.cost; m.pm += x.pm;
            if (d < m.from) m.from = d;
        }
    }
    return [...byMonth.values()].filter(m => m.cost).map(m => ({
        kind: 'cost', calc: true, category_id: 'prasad', category_name: label,
        occurred_on: from && m.from < from ? from : m.from, currency_code: 'INR', account_name: tr('dprasad_calc', 'расчёт'),
        comment: `${num(m.pm)} ${tr('dprasad_meals_short', 'приёмов пищи')}`,
        // в ленте знак у signed_amount: расход департамента — минус, «отнесено» у Кухни — плюс (уменьшает расходы)
        signed_amount: isKitchen ? m.cost : -m.cost, amount_base: m.cost
    }));
}

// ---------- вкладка «Питание» ----------
let section = 'summary';
try { section = localStorage.getItem('dept_prasad_section') || 'summary'; } catch { /* нет хранилища */ }
const opened = new Set();
let chart = null;

const bucketLabel = b => { const [y, m] = b.split('-'); return `${new Date(Number(y), Number(m) - 1, 1).toLocaleString('ru-RU', { month: 'short' }).replace('.', '')} ${y.slice(2)}`; };
const BUCKET_RU = { team: () => tr('status_team', 'Команда'), volunteers: () => tr('category_volunteer', 'Волонтёр'),
                    guests: () => tr('dprasad_guest', 'Гость за счёт департамента'), vips: () => tr('dprasad_guest', 'Гость за счёт департамента'),
                    expected: () => tr('dprasad_expected', 'Бронь, заезд не отмечен'), groups: () => tr('nav_groups', 'Группа') };
const personLabel = p => p.name || (p.kind === 'group' ? tr('nav_groups', 'Группа') : tr('cost_unnamed_booking', 'Бронь без имени'));

// Сводные цифры строки (департамента или всех): люди, человеко-дни, приёмы пищи, цена порции, на человека
function totalsOf(groups) {
    const s = { people: 0, days: 0, bf: 0, ln: 0, pm: 0, cost: 0 };
    for (const g of groups) { s.people += g.people_n; s.days += g.days; s.bf += g.bf; s.ln += g.ln; s.pm += g.pm; s.cost += g.cost; }
    s.portion = s.pm ? s.cost / s.pm : 0;
    s.perPerson = s.people ? s.cost / s.people : 0;
    return s;
}

const kpi = (label, value, sub) => `<div class="bg-base-100 rounded-xl shadow-sm p-4">
    <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
    <div class="text-xl font-bold mt-1">${value}</div>${sub ? `<div class="text-xs opacity-60 mt-0.5">${sub}</div>` : ''}</div>`;

// ⚠ команда и волонтёры без департамента — поимённо, клик ведёт в карточку (там ставится департамент)
function noDeptWarning(list) {
    const g = list.find(x => x.key === DEPT_NONE);
    if (!g) return '';
    const ppl = g.people.slice().sort((a, b) => b.cost - a.cost);
    return `<div class="alert alert-warning mb-3 text-sm items-start">
        <svg class="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
        <div><div class="font-semibold">${e(tr('dprasad_no_dept', 'Не вся команда разнесена по департаментам'))}: ${ppl.length} ${e(tr('cost_people_short', 'чел.'))} · ${inr(g.cost)}</div>
        <div class="mt-1">${ppl.map(p => p.id
            ? `<a class="link" href="../vaishnavas/person.html?id=${e(p.id)}">${e(personLabel(p))}</a>`
            : e(personLabel(p))).join(', ')}</div>
        <div class="text-xs opacity-70 mt-1">${e(tr('dprasad_no_dept_hint', 'Их питание остаётся на Кухне. Департамент ставится в карточке человека или у места в шахматке'))}</div></div></div>`;
}

function peopleTable(people) {
    const ppl = people.slice().sort((a, b) => b.cost - a.cost || personLabel(a).localeCompare(personLabel(b), 'ru'));
    return `<table class="table table-xs w-full">
        <thead><tr><th>${e(tr('name', 'Имя'))}</th>
            <th class="text-right">${e(tr('cost_days', 'Дней'))}</th>
            <th class="text-right">${e(tr('breakfast', 'Завтраков'))}</th>
            <th class="text-right">${e(tr('lunch', 'Обедов'))}</th>
            <th class="text-right">${e(tr('dprasad_portion', 'Цена порции'))}</th>
            <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr></thead>
        <tbody>${ppl.map(p => `<tr>
            <td>${p.id ? `<a class="link link-hover" href="../vaishnavas/person.html?id=${e(p.id)}">${e(personLabel(p))}</a>` : e(personLabel(p))}
                <span class="text-xs opacity-60">${e(BUCKET_RU[p.bucket]?.() || '')}${p.n > 1 ? ` · ${p.n} ${e(tr('cost_people_short', 'чел.'))}` : ''}</span></td>
            <td class="text-right">${p.days}</td><td class="text-right">${num(p.bf)}</td><td class="text-right">${num(p.ln)}</td>
            <td class="text-right font-mono">${p.pm ? inr(p.cost / p.pm) : '—'}</td>
            <td class="text-right font-mono font-semibold">${inr(p.cost)}</td></tr>`).join('')}</tbody></table>`;
}

// По месяцам: строки — месяцы (один департамент) или департаменты × месяцы (все)
function monthsOf(groups) {
    const ms = new Set();
    groups.forEach(g => Object.keys(g.byDay).forEach(d => ms.add(d.slice(0, 7))));
    return [...ms].sort();
}
function monthStats(g, m) {
    const s = { people: new Set(), days: 0, pm: 0, cost: 0 };
    for (const p of g.people) {
        const ds = p.dates.filter(d => d.startsWith(m));
        if (!ds.length) continue;
        s.people.add(p.id || p.ref);
        s.days += ds.length;
    }
    for (const [d, x] of Object.entries(g.byDay)) if (d.startsWith(m)) { s.pm += x.pm; s.cost += x.cost; }
    return s;
}

function tableHtml(groups, all) {
    const months = monthsOf(groups);
    if (all) {
        return `<div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto"><table class="table table-sm w-full">
            <thead><tr><th class="sticky left-0 bg-base-100">${e(tr('cost_department', 'Департамент'))}</th>
                ${months.map(m => `<th class="text-right whitespace-nowrap">${e(bucketLabel(m))}</th>`).join('')}
                <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr></thead>
            <tbody>${groups.map(g => `<tr class="${isRealDept(g.key) ? '' : 'text-warning'}">
                <td class="sticky left-0 bg-base-100">${e(rowName(g.key))}</td>
                ${months.map(m => { const s = monthStats(g, m); return `<td class="text-right font-mono whitespace-nowrap">${s.cost ? inr(s.cost) : '<span class="opacity-30">—</span>'}</td>`; }).join('')}
                <td class="text-right font-mono font-semibold whitespace-nowrap">${inr(g.cost)}</td></tr>`).join('')}
                <tr class="font-semibold border-t-2 border-base-300"><td class="sticky left-0 bg-base-100">${e(tr('cost_total', 'Всего'))}</td>
                ${months.map(m => `<td class="text-right font-mono whitespace-nowrap">${inr(groups.reduce((a, g) => a + monthStats(g, m).cost, 0))}</td>`).join('')}
                <td class="text-right font-mono whitespace-nowrap">${inr(groups.reduce((a, g) => a + g.cost, 0))}</td></tr></tbody></table></div>`;
    }
    const g = groups[0];
    return `<div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto"><table class="table table-sm w-full">
        <thead><tr><th>${e(tr('dprasad_month', 'Месяц'))}</th>
            <th class="text-right">${e(tr('dprasad_people', 'Людей'))}</th>
            <th class="text-right">${e(tr('dprasad_days', 'Дней питания'))}</th>
            <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
            <th class="text-right">${e(tr('dprasad_portion', 'Цена порции'))}</th>
            <th class="text-right">${e(tr('dprasad_per_person', 'На человека'))}</th>
            <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr></thead>
        <tbody>${months.map(m => { const s = monthStats(g, m); return `<tr>
            <td>${e(bucketLabel(m))}</td><td class="text-right">${s.people.size}</td><td class="text-right">${s.days}</td>
            <td class="text-right">${num(s.pm)}</td>
            <td class="text-right font-mono">${s.pm ? inr(s.cost / s.pm) : '—'}</td>
            <td class="text-right font-mono">${s.people.size ? inr(s.cost / s.people.size) : '—'}</td>
            <td class="text-right font-mono font-semibold">${inr(s.cost)}</td></tr>`; }).join('')}</tbody></table></div>`;
}

let chartLib = null;
function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLib) chartLib = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = CHART_JS; sc.onload = () => res(window.Chart); sc.onerror = () => { chartLib = null; rej(); };
        document.head.appendChild(sc);
    });
    return chartLib;
}

// График по дням: сколько людей ело (линия) и во что обошлось (столбики)
async function drawChart(groups) {
    const el = document.getElementById('dprasadChart');
    if (!el) return;
    let Chart;
    try { Chart = await loadChartLib(); } catch { el.replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') })); return; }
    const days = {};
    groups.forEach(g => Object.entries(g.byDay).forEach(([d, x]) => {
        const s = days[d] || (days[d] = { people: 0, cost: 0 });
        s.people += x.people; s.cost += x.cost;
    }));
    const dates = Object.keys(days).sort();
    if (chart) chart.destroy();
    chart = new Chart(el, {
        type: 'bar',
        data: { labels: dates.map(fmtDay), datasets: [
            { label: tr('dprasad_cost_day', '₹ за день'), data: dates.map(d => Math.round(days[d].cost)), backgroundColor: '#ef4444', yAxisID: 'y', order: 2 },
            { type: 'line', label: tr('dprasad_people_day', 'Людей ело'), data: dates.map(d => days[d].people), borderColor: '#3b82f6', backgroundColor: '#3b82f6',
              borderWidth: 2, pointRadius: 0, yAxisID: 'y1', order: 1, stepped: true }] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => Number(v).toLocaleString('ru-RU') } },
                      y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { precision: 0 } } } }
    });
}

// el — контейнер; list — строки deptPeriod; all — по всем департаментам (Кухня, Финансы), иначе один
function render(el, list, { all = false, from, to } = {}) {
    const groups = list.slice().sort((a, b) => !isRealDept(a.key) - !isRealDept(b.key) || b.cost - a.cost);
    if (!groups.length) {
        el.innerHTML = `<div class="bg-base-100 rounded-xl shadow-sm p-6 text-center opacity-60">${e(tr('dprasad_empty', 'За период питание на департамент не относилось'))}</div>`;
        return;
    }
    const s = totalsOf(groups);
    // своя команда Кухни — её же расход: «отнесено» — только другие департаменты
    const moved = all ? groups.filter(g => isRealDept(g.key) && deptById(g.key)?.code !== 'kitchen').reduce((a, g) => a + g.cost, 0) : 0;
    const sections = [['summary', tr('dacc_an_sec_summary', 'Сводка')], ['table', tr('dacc_an_sec_table', 'По месяцам')], ['charts', tr('cost_section_charts', 'Графики')]];
    let body;
    if (section === 'table') body = tableHtml(groups, all);
    else if (section === 'charts') body = `<div class="bg-base-100 rounded-xl shadow-sm p-3">
        <div class="text-xs uppercase tracking-wide opacity-60 mb-2">${e(tr('dprasad_by_day', 'По дням: люди и стоимость'))}</div>
        <div style="height:320px"><canvas id="dprasadChart"></canvas></div></div>`;
    else if (all) body = `<div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto"><table class="table table-sm w-full">
        <thead><tr><th>${e(tr('cost_department', 'Департамент'))}</th>
            <th class="text-right">${e(tr('dprasad_people', 'Людей'))}</th>
            <th class="text-right">${e(tr('dprasad_days', 'Дней питания'))}</th>
            <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
            <th class="text-right">${e(tr('dprasad_portion', 'Цена порции'))}</th>
            <th class="text-right">${e(tr('dprasad_per_person', 'На человека'))}</th>
            <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr></thead>
        <tbody>${groups.map(g => {
            const open = opened.has(g.key);
            return `<tr class="cursor-pointer hover:bg-base-200/50 ${isRealDept(g.key) ? '' : 'text-warning'}" data-dprasad-open="${e(g.key)}">
                <td><span class="opacity-50">${open ? '▾' : '▸'}</span> ${e(rowName(g.key))}</td>
                <td class="text-right">${g.people_n}</td><td class="text-right">${g.days}</td><td class="text-right">${num(g.pm)}</td>
                <td class="text-right font-mono">${g.pm ? inr(g.cost / g.pm) : '—'}</td>
                <td class="text-right font-mono">${g.people_n ? inr(g.cost / g.people_n) : '—'}</td>
                <td class="text-right font-mono font-semibold">${inr(g.cost)}</td></tr>
                ${open ? `<tr><td colspan="7" class="bg-base-200/30">${peopleTable(g.people)}</td></tr>` : ''}`;
        }).join('')}</tbody></table></div>`;
    else body = `<div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto p-2">${peopleTable(groups[0].people)}</div>`;

    el.innerHTML = `
        ${all ? noDeptWarning(groups) : ''}
        <div class="bg-base-100 rounded-xl shadow-sm p-5 mb-3 border-l-4 border-red-500">
            <div class="text-xs uppercase tracking-wide opacity-60">${e(all ? tr('dprasad_total_all', 'Питание команды и волонтёров вне ретритов') : tr('dprasad_total', 'Питание (прасад) — расход департамента'))}</div>
            <div class="text-3xl font-bold mt-1 text-red-600">${inr(s.cost)}</div>
            ${all ? `<div class="text-sm opacity-70 mt-1">${e(tr('dprasad_moved', 'Отнесено на департаменты'))}: ${inr(moved)} · ${e(tr('dprasad_stays', 'остаётся на Кухне'))}: ${inr(s.cost - moved)}</div>` : ''}
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
            ${kpi(tr('dprasad_people', 'Людей'), s.people)}
            ${kpi(tr('dprasad_days', 'Дней питания'), s.days, e(tr('dprasad_days_hint', 'человеко-дней')))}
            ${kpi(tr('cost_person_meals', 'Приёмов пищи'), num(s.pm), `${e(tr('breakfast', 'Завтраков'))} ${num(s.bf)} · ${e(tr('lunch', 'Обедов'))} ${num(s.ln)}`)}
            ${kpi(tr('dprasad_portion', 'Цена порции'), inr(s.portion))}
            ${kpi(tr('dprasad_per_person', 'На человека'), inr(s.perPerson), e(tr('dprasad_per_person_hint', 'за период')))}
        </div>
        <div class="text-xs opacity-60 mb-3">${e(fmtDay(!from || from < START ? START : from))} — ${e(fmtDay(!to || to > DateUtils.toISO(new Date()) ? DateUtils.toISO(new Date()) : to))} · ${e(tr('dprasad_note', 'Расчёт, не деньги: каждый приём пищи — по его настоящей цене (продукты этого приёма ÷ евшие + посуда + накладные дня). Дни ретритов — в себестоимости ретритов, сюда не входят'))}${list.computedAt ? ` · ${e(tr('dprasad_computed', 'пересчитано'))} ${e(new Date(list.computedAt).toLocaleString('ru-RU'))}` : ''}</div>
        <div role="tablist" class="tabs tabs-boxed w-fit mb-3">${sections.map(([id, label]) =>
            `<a role="tab" class="tab ${id === section ? 'tab-active' : ''}" data-dprasad-sec="${id}">${e(label)}</a>`).join('')}</div>
        ${body}`;
    if (!el._delegated) {
        el._delegated = true;
        el.addEventListener('click', ev => {
            const sec = ev.target.closest('[data-dprasad-sec]');
            const op = ev.target.closest('[data-dprasad-open]');
            if (sec) { section = sec.dataset.dprasadSec; try { localStorage.setItem('dept_prasad_section', section); } catch { /* нет хранилища */ } }
            else if (op) { const k = op.dataset.dprasadOpen; if (opened.has(k)) opened.delete(k); else opened.add(k); }
            else return;
            render(el, el._list, el._opts);
        });
    }
    el._list = list; el._opts = { all, from, to };
    if (section === 'charts') drawChart(groups);
}

return { load, render, analyticsRows, rowName, isRealDept, findDept, loadDepartments };
})();
