// ==================== СЧЁТ ДЕПАРТАМЕНТА ====================
// Движение денег по счетам департамента — только просмотр (решение ВГ 25.09.2026).
// Глава департамента видит свой счёт: приходы, расходы, переводы к другим счетам и от них;
// фильтры и сортировка как в ДДС, ничего менять нельзя. Данные — та же лента ДДС
// (fin_v_account_ledger), какие счета чьи — fin_department_accounts.
// ВГ 18.10: вкладки — по валютам, в ленте все счета департамента и его выручка, сданная на другие
// счета (fin_department_income); итоги «На руках / Заработал / Получил на расходы / Потратил».
// Пилот — Кухня (kitchen/account.html); другой департамент — такая же страница со своим названием.
window.DeptAccount = (function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов не обновился — русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

let cfg = null;
let accounts = [];
let currentCur = null;    // вкладка — валюта: все счета департамента в ней + выручка, сданная на другие счета
let rows = [];            // все проводки выбранного счёта, по дате (внутри дня — приходы раньше), .bal — остаток после
const opened = new Set(); // раскрытые строки (posting_id)
let sort = { key: 'date', dir: 'desc' };
// Выручка, сданная на ЧУЖИЕ счета (Касса, Гест-хаус) по статьям департамента (мигр. 706/708):
// выручку магазина сдают туда, а не на его счёт. ВГ 18.10: все приходы и расходы — в одной ленте.
// Такие строки (r.ext) входят в «Заработал» и в сводку, но не в «На руках у департамента».
let incomeRows = [];

const money = (v, cur) => FinUtils.fmtMoney(v, cur);
const signed = (v, cur) => `${Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : ''}${money(Math.abs(Number(v)), cur)}`;
const fmtDay = iso => DateUtils.formatShort(DateUtils.parseDate(iso));
const $ = id => document.getElementById(id);

// ---------- период ----------
function presetRange(p) {
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth();
    const iso = d => DateUtils.toISO(d);
    switch (p) {
        case 'month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))];
        case 'prev': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))];
        case 'year': return [`${y}-01-01`, `${y}-12-31`];
        case 'all': return ['', ''];
        default: return null;
    }
}

function markPreset(p) {
    document.querySelectorAll('[data-dacc-preset]').forEach(b => b.classList.toggle('btn-active', b.dataset.daccPreset === p));
    try { localStorage.setItem('dept_account_period', p); } catch { /* нет хранилища */ }
}

function setPreset(p) {
    const r = presetRange(p);
    if (r) { $('daccFrom').value = r[0]; $('daccTo').value = r[1]; }
    markPreset(p);
    render();
}

// ---------- загрузка ----------
async function loadAccounts() {
    const { data, error } = await Layout.db.rpc('fin_department_accounts', { p_department: cfg.department });
    if (error) return null;
    // вкладка — только у счёта, по которому уже есть операции: пустой счёт не засоряет (ВГ 25.09)
    const withOps = await Promise.all((data || []).map(async a => {
        const { count } = await Layout.db.from('fin_v_account_ledger').select('posting_id', { count: 'exact', head: true }).eq('account_id', a.account_id);
        return count ? a : null;
    }));
    return withOps.filter(Boolean);
}

async function loadRows(accountId) {
    const out = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await Layout.db.from('fin_v_account_ledger').select('*')
            .eq('account_id', accountId).order('ledger_seq').range(off, off + 999);
        if (error) { Layout.handleError(error, tr('dacc_title', 'Счёт')); break; }
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return out;
}

async function selectCurrency(cur) {
    currentCur = cur;
    const own = accounts.filter(a => a.currency_code === cur);
    $('daccAccountName').textContent = own.map(a => a.name).join(', ');
    document.querySelectorAll('[data-dacc-cur]').forEach(b => b.classList.toggle('tab-active', b.dataset.daccCur === cur));
    $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    // Остаток после операции — по дате операции (а не по порядку внесения): операцию, внесённую
    // задним числом, ставим на её дату, иначе в столбце «Остаток после» скачки (замечание ВГ 25.09)
    // в пределах одного дня сначала приходы, потом расходы — чтобы не было ложного минуса внутри дня
    const inFirst = r => Number(r.signed_amount) >= 0 ? 0 : 1;
    const loaded = await Promise.all(own.map(a => Promise.all([loadRows(a.account_id), Layout.db.rpc('fin_account_op_groups', { p_account: a.account_id })])));
    const ext = incomeRows.filter(r => r.currency_code === cur).map(r => ({ ...r, ext: true, ledger_seq: 0 }));
    const base = [...loaded.flatMap(([list]) => list), ...ext]
        .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || inFirst(a) - inFirst(b) || a.ledger_seq - b.ledger_seq);
    rows = pairUp(base, loaded.flatMap(([, g]) => g.data || []));
    // «Остаток после» — только по деньгам на руках у департамента: выручка, сданная на другой счёт, его не меняет
    let bal = 0;
    rows.forEach((r, i) => { if (!r.ext) bal += Number(r.signed_amount); r.bal = Math.round(bal * 100) / 100; r.ord = i; });
    // пара «перевод + трата» — одна позиция в ленте: grp — место пары, sub — порядок внутри (перевод, потом трата)
    const first = new Map();
    rows.forEach(r => { const k = r.gid || r.posting_id; if (!first.has(k)) first.set(k, r.ord); r.grp = first.get(k); r.sub = r.ord - r.grp; });
    opened.clear();
    const cats = [...new Map(rows.filter(r => r.category_id).map(r => [r.category_id, r.category_name])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    $('daccCategory').innerHTML = `<option value="">${e(tr('fin_filter_all_categories', 'Все статьи'))}</option>` +
        cats.map(([cid, name]) => `<option value="${cid}">${e(name)}</option>`).join('');
    render();
}

// Перевод на счёт и трата с него, сделанные одним действием («выдано Кухне на … и сразу потрачено»),
// ставим рядом: сначала перевод, сразу под ним трата (решение ВГ 25.09). Пары из чата — по заявке
// (fin_account_op_groups), пары из формы ДДС «перевод + сразу потрачено» — по той же дате, сумме и комментарию.
function pairUp(base, groups) {
    const gidOf = new Map(groups.map(g => [g.operation_id, g.group_id]));
    base.forEach(r => { r.gid = gidOf.get(r.operation_id) || null; });
    const norm = x => (x || '').trim();
    for (const trf of base.filter(r => !r.gid && r.type === 'transfer' && r.direction === 'in')) {
        const ex = base.find(r => !r.gid && r.type === 'expense' && r.occurred_on === trf.occurred_on
            && Number(r.amount) === Number(trf.amount) && norm(r.comment) === norm(trf.comment));
        if (ex) { trf.gid = ex.gid = `m:${trf.operation_id}`; }
    }
    const byGid = new Map();
    base.forEach(r => { if (r.gid) (byGid.get(r.gid) || byGid.set(r.gid, []).get(r.gid)).push(r); });
    const out = [], placed = new Set();
    for (const r of base) {
        if (!r.gid) { out.push(r); continue; }
        if (placed.has(r.gid)) continue;
        placed.add(r.gid);
        out.push(...byGid.get(r.gid).sort((a, b) => (a.direction === 'in' ? 0 : 1) - (b.direction === 'in' ? 0 : 1)));
    }
    return out;
}

// ---------- фильтры ----------
const isStorno = r => r.is_reversed || r.type === 'reversal';

function filtered() {
    const from = $('daccFrom').value, to = $('daccTo').value;
    const dir = $('daccDir').value, cat = $('daccCategory').value;
    const q = $('daccSearch').value.trim().toLowerCase();
    const amt = /^\d+([.,]\d+)?$/.test(q) ? Number(q.replace(',', '.')) : null;
    return rows.filter(r => {
        if (from && r.occurred_on < from) return false;
        if (to && r.occurred_on > to) return false;
        if (dir === 'in' && !(r.direction === 'in' && r.type !== 'transfer')) return false;
        if (dir === 'out' && !(r.direction === 'out' && r.type !== 'transfer')) return false;
        if (dir === 'transfer' && r.type !== 'transfer') return false;
        if (cat && r.category_id !== cat) return false;
        if (q) {
            if (amt !== null && Math.abs(Number(r.amount)) === amt) return true;
            const hay = [r.comment, r.reason, r.participant_name, r.contractor_name, r.contra_account, r.category_name, r.object_name]
                .filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
        }
        return true;
    });
}

// ---------- отрисовка ----------
function chip(label, value, cls = '', hint = '') {
    return `<div class="bg-base-100 rounded-xl shadow-sm p-4" ${hint ? `title="${e(hint)}"` : ''}>
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls}">${value}</div></div>`;
}

function renderTotals(list) {
    const cur = currentCur || 'INR';
    const from = $('daccFrom').value, to = $('daccTo').value;
    const today = DateUtils.toISO(new Date());
    const own = rows.filter(r => !r.ext);
    const now = own.length ? own[own.length - 1].bal : 0;
    // остатки — по всем проводкам счетов департамента, без учёта фильтров по статье и поиску
    const before = from ? own.filter(r => r.occurred_on < from) : [];
    const upto = to ? own.filter(r => r.occurred_on <= to) : own;
    const opening = before.length ? before[before.length - 1].bal : 0;
    const closing = upto.length ? upto[upto.length - 1].bal : 0;
    // сторно и отменённая операция вместе дают ноль — в итоги их не берём (как в ДДС).
    // Заработал — приходы (выручка), Получил на расходы — переводы на счёт департамента (ВГ 18.10),
    // Потратил — расходы по статьям; переводы с его счёта на другие — отдельной строкой
    let earned = 0, received = 0, spent = 0, passed = 0, rev = 0;
    for (const r of list) {
        const v = Number(r.signed_amount);
        if (isStorno(r)) rev += Math.abs(v);
        else if (v >= 0) { if (r.type === 'transfer') received += v; else earned += v; }
        else if (r.type === 'transfer') passed -= v; else spent -= v;
    }
    const filteredNote = $('daccCategory').value || $('daccSearch').value.trim() || $('daccDir').value
        ? ` <span class="text-xs font-normal opacity-60">${e(tr('dacc_by_filter', 'по фильтру'))}</span>` : '';
    $('daccTotals').innerHTML = [
        chip(tr('dacc_on_hand', 'На руках у департамента'), money(now, cur), now < 0 ? 'text-error' : ''),
        chip(tr('dacc_earned', 'Заработал'), `<span class="text-blue-600">${money(earned, cur)}</span>${filteredNote}`, '', tr('dacc_earned_hint', 'Выручка и другие приходы по статьям — и на счёт департамента, и сданные в Кассу или Гест-хаус')),
        chip(tr('dacc_received', 'Получил на расходы'), `<span class="text-teal-600">${money(received, cur)}</span>${filteredNote}`, '', tr('dacc_received_hint', 'Деньги, выданные департаменту из общей кассы или с других счетов')),
        chip(tr('dacc_spent', 'Потратил'), `<span class="text-red-600">${money(spent, cur)}</span>${filteredNote}`)
    ].join('');
    // «было → стало» — только для прошлых периодов: если период доходит до сегодня, «стало» = «на руках сейчас»
    const parts = [];
    if (from && to && to < today) parts.push(`${fmtDay(from)}: ${money(opening, cur)} → ${fmtDay(to)}: <b>${money(closing, cur)}</b>`);
    else if (from) parts.push(`${tr('dacc_opening', 'На начало')} ${fmtDay(from)}: ${money(opening, cur)}`);
    if (passed) parts.push(`${e(tr('dacc_passed_on', 'передано на другие счета'))}: ${money(passed, cur)}`);
    if (rev) parts.push(`<span title="${e(tr('dacc_storno_hint', 'Отменённые операции и их отмены — вместе дают ноль, в «Пришло» и «Ушло» не входят'))}" class="cursor-help">${e(tr('fin_totals_reversed', 'Сторнировано'))}: ${money(rev, cur)}</span>`);
    $('daccPeriodLine').innerHTML = parts.join(' · ');
}

// Сводка «Пришло — откуда / Ушло — на что» за период (ВГ 18.10): по статьям, переводы — по другому счёту.
// Считается по периоду, без фильтров по статье и поиску — чтобы всегда была видна вся картина;
// строка сводки ставит фильтр на ленту ниже.
// куда относится проводка в сводке и аналитике: статья, перевод (по другому счёту) или вид операции;
// null — сторно или проводка другой стороны (приход при sign < 0 и наоборот)
function groupOf(r, sign) {
    const v = Number(r.signed_amount);
    if (isStorno(r) || (sign > 0 ? v <= 0 : v >= 0)) return null;
    if (r.category_id) return { key: `c:${r.category_id}`, label: r.category_name, pick: { cat: r.category_id } };
    if (r.type === 'transfer') return {
        key: `t:${r.contra_account || ''}`,
        label: `${sign > 0 ? '←' : '→'} ${r.contra_account || FinUtils.typeLabel(r.type)}`,
        pick: { q: r.contra_account || '' }
    };
    return { key: `k:${r.type}`, label: FinUtils.typeLabel(r.type), pick: {} };
}

function summaryGroups(list, sign) {
    const groups = new Map();
    for (const r of list) {
        const gr = groupOf(r, sign);
        if (!gr) continue;
        const g = groups.get(gr.key) || groups.set(gr.key, { ...gr, sum: 0, n: 0 }).get(gr.key);
        g.sum += Math.abs(Number(r.signed_amount)); g.n++;
    }
    return [...groups.values()].sort((a, b) => b.sum - a.sum);
}

function renderSummary() {
    const cur = currentCur || 'INR';
    const from = $('daccFrom').value, to = $('daccTo').value;
    const inPeriod = rows.filter(r => (!from || r.occurred_on >= from) && (!to || r.occurred_on <= to));
    const curCat = $('daccCategory').value, curQ = $('daccSearch').value.trim(), curDir = $('daccDir').value;
    const anyFilter = curCat || curQ || curDir;
    const block = (title, sign, color) => {
        const list = summaryGroups(inPeriod, sign);
        const total = list.reduce((s, g) => s + g.sum, 0);
        const lines = list.map(g => {
            const share = total ? g.sum / total : 0;
            const dir = sign > 0 ? 'in' : 'out';
            const active = (g.pick.cat && g.pick.cat === curCat) || (g.pick.q !== undefined && curDir === 'transfer' && g.pick.q === curQ);
            return `<button type="button" class="w-full text-left px-2 py-1.5 rounded-lg hover:bg-base-200 ${active ? 'bg-base-200' : ''}"
                    data-dacc-pick='${e(JSON.stringify({ ...g.pick, dir }))}'>
                <div class="flex items-baseline gap-2 text-sm">
                    <span class="truncate flex-1 ${active ? 'font-semibold' : ''}">${e(g.label)}</span>
                    <span class="opacity-50 text-xs">${Math.round(share * 100)}%</span>
                    <span class="font-mono whitespace-nowrap ${color}">${money(g.sum, cur)}</span>
                </div>
                <div class="h-1 rounded-full bg-base-200 mt-1"><div class="h-1 rounded-full ${sign > 0 ? 'bg-blue-500' : 'bg-red-500'}" style="width:${Math.max(share * 100, 1).toFixed(1)}%"></div></div>
            </button>`;
        }).join('');
        return `<div class="bg-base-100 rounded-xl shadow-sm p-3">
            <div class="flex items-baseline justify-between px-2 mb-1">
                <div class="text-xs uppercase tracking-wide opacity-60">${e(title)}</div>
                <div class="font-mono font-semibold ${color}">${money(total, cur)}</div>
            </div>
            ${lines || `<div class="px-2 py-3 text-sm opacity-60">${e(tr('dacc_sum_empty', 'Нет операций'))}</div>`}
        </div>`;
    };
    $('daccSummary').innerHTML = block(tr('dacc_sum_in', 'Пришло — откуда'), 1, 'text-blue-600')
        + block(tr('dacc_sum_out', 'Ушло — на что'), -1, 'text-red-600')
        + `<div class="md:col-span-2 flex items-center gap-3 text-xs opacity-60 px-1">
            <span>${e(tr('dacc_sum_hint', 'За выбранный период, без отменённых операций. Нажмите строку — покажу эти операции'))}</span>
            ${anyFilter ? `<button type="button" class="link link-primary opacity-100" data-dacc-pick-reset>${e(tr('dacc_sum_reset', 'Показать все'))}</button>` : ''}
        </div>`;
}

// ---------- выручка ----------
async function loadIncome() {
    const { data, error } = await Layout.db.rpc('fin_department_income', { p_department: cfg.department });
    return error ? [] : (data || []);
}

// ---------- аналитика: статьи по месяцам / кварталам / годам (ВГ 18.10) ----------
// Видно, в каком месяце по какой статье ушло больше или меньше обычного: ячейка, которая в полтора раза
// выше обычной суммы по статье, — оранжевая, вдвое ниже — голубая. Нажатие на ячейку открывает эти операции.
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
const CHART_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#9ca3af'];
const CHART_TOP = 7;      // столько статей на графике отдельно, остальные — «Прочее»
let view = 'ops';
let step = 'month';
let chartLib = null;
let anChart = null;

function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLib) chartLib = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = CHART_JS; sc.onload = () => res(window.Chart); sc.onerror = () => { chartLib = null; rej(); };
        document.head.appendChild(sc);
    });
    return chartLib;
}

function bucketOf(iso) {
    const y = iso.slice(0, 4), m = Number(iso.slice(5, 7));
    return step === 'month' ? iso.slice(0, 7) : step === 'quarter' ? `${y}-Q${Math.ceil(m / 3)}` : y;
}

// границы ведра — чтобы ячейка открывала ленту ровно за этот месяц / квартал / год
function bucketRange(b) {
    const y = Number(b.slice(0, 4));
    let m1 = 1, m2 = 12;
    if (step === 'month') { m1 = m2 = Number(b.slice(5, 7)); }
    else if (step === 'quarter') { const q = Number(b.slice(6)); m1 = q * 3 - 2; m2 = q * 3; }
    return [DateUtils.toISO(new Date(y, m1 - 1, 1)), DateUtils.toISO(new Date(y, m2, 0))];
}

function bucketLabel(b) {
    const lang = { ru: 'ru-RU', en: 'en-GB', hi: 'hi-IN' }[localStorage.getItem('srsk_lang') || 'ru'] || 'ru-RU';
    if (step === 'month') {
        const d = new Date(Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, 1);
        return `${d.toLocaleString(lang, { month: 'short' }).replace('.', '')} ${b.slice(2, 4)}`;
    }
    if (step === 'quarter') return `${b.slice(5)} ${b.slice(0, 4)}`;
    return b;
}

// все вёдра подряд от «с» до «по» — пустой месяц тоже виден (провал — тоже сигнал)
function bucketList(from, to) {
    const out = [];
    const d = DateUtils.parseDate(from.slice(0, 7) + '-01');
    const end = DateUtils.parseDate(to);
    while (d <= end) {
        const b = bucketOf(DateUtils.toISO(d));
        if (out[out.length - 1] !== b) out.push(b);
        d.setMonth(d.getMonth() + 1);
    }
    return out;
}

function analyticsData() {
    const today = DateUtils.toISO(new Date());
    const live = rows.filter(r => !isStorno(r));
    const from = $('daccFrom').value || live[0]?.occurred_on || today;
    let to = $('daccTo').value || live[live.length - 1]?.occurred_on || today;
    if (to > today && from <= today) to = today;   // будущие месяцы года — без пустых столбцов
    const buckets = bucketList(from, to);
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const side = sign => {
        const groups = new Map();
        const totals = buckets.map(() => 0);
        for (const r of rows) {
            if (r.occurred_on < from || r.occurred_on > to) continue;
            const gr = groupOf(r, sign);
            if (!gr) continue;
            const i = idx.get(bucketOf(r.occurred_on));
            if (i === undefined) continue;
            const g = groups.get(gr.key) || groups.set(gr.key, { ...gr, cells: buckets.map(() => 0), sum: 0 }).get(gr.key);
            const v = Math.abs(Number(r.signed_amount));
            g.cells[i] += v; g.sum += v; totals[i] += v;
        }
        return { groups: [...groups.values()].sort((a, b) => b.sum - a.sum), totals };
    };
    return { buckets, out: side(-1), inc: side(1) };
}

function renderAnalytics() {
    const box = $('daccAnalytics');
    const cur = currentCur || 'INR';
    const d = analyticsData();
    const n = d.buckets.length;
    const stepBtn = (s, key, ru) => `<button class="btn btn-sm join-item ${step === s ? 'btn-active' : ''}" data-dacc-step="${s}">${e(tr(key, ru))}</button>`;
    const fmt = v => v ? money(v, cur) : '<span class="opacity-30">—</span>';
    const cell = (g, i, rowCls) => {
        const v = g.cells[i];
        // перекос — только у регулярной статьи (траты хотя бы в трёх столбцах), и сравнение с её обычной
        // суммой за те столбцы, где она была: разовая покупка — не перекос, пустой месяц — не провал
        const used = g.cells.filter(x => x > 0);
        const usual = used.length >= 3 ? used.reduce((a, b) => a + b, 0) / used.length : 0;
        let cls = '', hint = '';
        if (usual && v > 0) {
            const pct = Math.round((v / usual - 1) * 100);
            if (v >= usual * 1.5) { cls = 'bg-orange-100 text-orange-900'; hint = `+${pct}% ${tr('dacc_an_vs_avg', 'к обычному')}`; }
            else if (v <= usual * 0.5) { cls = 'bg-sky-100 text-sky-900'; hint = `${pct}% ${tr('dacc_an_vs_avg', 'к обычному')}`; }
        }
        const pick = JSON.stringify({ ...g.pick, dir: rowCls, range: bucketRange(d.buckets[i]) });
        return `<td class="text-right font-mono whitespace-nowrap ${cls} ${v ? 'cursor-pointer hover:underline' : ''}" ${hint ? `title="${e(hint)}"` : ''} ${v ? `data-dacc-pick='${e(pick)}'` : ''}>${fmt(v)}</td>`;
    };
    const section = (title, s, dir, color) => {
        const totalAll = s.totals.reduce((a, b) => a + b, 0);
        const head = `<tr class="bg-base-200/60 font-semibold">
            <td class="sticky left-0 bg-base-200">${e(title)}</td>
            ${s.totals.map(v => `<td class="text-right font-mono whitespace-nowrap ${color}">${fmt(v)}</td>`).join('')}
            <td class="text-right font-mono whitespace-nowrap ${color}">${fmt(totalAll)}</td>
            <td class="text-right font-mono whitespace-nowrap opacity-70">${fmt(totalAll / n)}</td></tr>`;
        const body = s.groups.map(g => `<tr>
            <td class="sticky left-0 bg-base-100 max-w-[16rem]"><div class="truncate" title="${e(g.label)}">${e(g.label)}</div></td>
            ${g.cells.map((_, i) => cell(g, i, dir)).join('')}
            <td class="text-right font-mono whitespace-nowrap font-semibold">${fmt(g.sum)}</td>
            <td class="text-right font-mono whitespace-nowrap opacity-70">${fmt(g.sum / n)}</td></tr>`).join('');
        return head + (body || `<tr><td colspan="${n + 3}" class="opacity-60 text-sm">${e(tr('dacc_sum_empty', 'Нет операций'))}</td></tr>`);
    };
    box.innerHTML = `
        <div class="flex flex-wrap items-center gap-3 mb-3">
            <div class="join">${stepBtn('month', 'cost_step_month', 'Месяц')}${stepBtn('quarter', 'cost_step_quarter', 'Квартал')}${stepBtn('year', 'cost_step_year', 'Год')}</div>
            <span class="text-xs opacity-60">${e(tr('dacc_an_hint', 'Период — выбранный выше. Оранжевое — в полтора раза больше обычного по статье, голубое — вдвое меньше. Нажмите сумму — покажу эти операции'))}</span>
        </div>
        <div class="bg-base-100 rounded-xl shadow-sm p-3 mb-4"><div style="height:320px"><canvas id="daccChart"></canvas></div></div>
        <div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto">
            <table class="table table-sm w-full">
                <thead><tr>
                    <th class="sticky left-0 bg-base-100">${e(tr('fin_category', 'Статья'))}</th>
                    ${d.buckets.map(b => `<th class="text-right whitespace-nowrap">${e(bucketLabel(b))}</th>`).join('')}
                    <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
                    <th class="text-right whitespace-nowrap">${e(tr('dacc_an_avg', 'В среднем'))}</th>
                </tr></thead>
                <tbody>
                    ${section(tr('dacc_sum_out', 'Ушло — на что'), d.out, 'out', 'text-red-600')}
                    ${section(tr('dacc_sum_in', 'Пришло — откуда'), d.inc, 'in', 'text-blue-600')}
                </tbody>
            </table>
        </div>`;
    drawChart(d, cur);
}

async function drawChart(d, cur) {
    let Chart;
    try { Chart = await loadChartLib(); } catch {
        $('daccChart')?.replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') }));
        return;
    }
    const canvas = $('daccChart');
    if (!canvas) return;
    if (anChart) anChart.destroy();
    const top = d.out.groups.slice(0, CHART_TOP);
    const rest = d.out.groups.slice(CHART_TOP);
    const datasets = top.map((g, i) => ({ label: g.label, data: g.cells, backgroundColor: CHART_COLORS[i], stack: 'out', order: 2 }));
    if (rest.length) datasets.push({ label: tr('dacc_an_other', 'Прочее'), stack: 'out', order: 2, backgroundColor: CHART_COLORS[CHART_TOP],
        data: d.buckets.map((_, i) => rest.reduce((s, g) => s + g.cells[i], 0)) });
    datasets.push({ type: 'line', label: tr('dacc_in', 'Пришло'), data: d.inc.totals, borderColor: '#2563eb', backgroundColor: '#2563eb', borderWidth: 2, pointRadius: 3, order: 1 });
    anChart = new Chart(canvas, {
        type: 'bar',
        data: { labels: d.buckets.map(bucketLabel), datasets },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
                tooltip: { callbacks: {
                    label: c => c.raw ? `${c.dataset.label}: ${money(c.raw, cur)}` : null,
                    footer: items => `${tr('dacc_out', 'Ушло')}: ${money(d.out.totals[items[0].dataIndex], cur)}`
                } } },
            scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: v => Number(v).toLocaleString('ru-RU') } } } }
    });
}

function setView(v) {
    view = v;
    document.querySelectorAll('[data-dacc-view]').forEach(t => t.classList.toggle('tab-active', t.dataset.daccView === v));
    $('daccOps').classList.toggle('hidden', v !== 'ops');
    $('daccAnalytics').classList.toggle('hidden', v !== 'analytics');
    try { localStorage.setItem('dept_account_view', v); } catch { /* нет хранилища */ }
    render();
}

function pickFromSummary(pick) {
    if (pick.range) { $('daccFrom').value = pick.range[0]; $('daccTo').value = pick.range[1]; markPreset('custom'); }
    if (view !== 'ops') setView('ops');
    if (pick.cat) { $('daccCategory').value = pick.cat; $('daccDir').value = ''; $('daccSearch').value = ''; }
    else if (pick.q !== undefined) { $('daccCategory').value = ''; $('daccDir').value = 'transfer'; $('daccSearch').value = pick.q; }
    else { $('daccCategory').value = ''; $('daccDir').value = pick.dir; $('daccSearch').value = ''; }
    render();
    $('daccHead').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function kindCell(r) {
    const arrow = r.contra_account
        ? ` <span class="opacity-70 whitespace-nowrap">${r.direction === 'out' ? '→' : '←'} ${e(r.contra_account)}</span>` : '';
    const badge = r.is_reversed ? ` <span class="badge badge-ghost badge-xs">${e(tr('fin_reversed_badge', 'сторнировано'))}</span>` : '';
    const ext = r.ext ? ` <span class="badge badge-outline badge-xs whitespace-nowrap" title="${e(tr('dacc_ext_hint', 'Выручка сдана на другой счёт — входит в «Заработал», но не в «На руках»'))}">${e(tr('dacc_handed_to', 'сдано'))}: ${e(r.account_name)}</span>` : '';
    return `${e(FinUtils.typeLabel(r.type))}${arrow}${ext}${badge}`;
}

function detailHtml(r) {
    const item = (label, val) => val ? `<div><span class="opacity-60">${e(label)}:</span> ${e(val)}</div>` : '';
    const canDds = window.hasPermission?.('fin_admin') || window.hasPermission?.('fin_observer');
    return `<div class="grid md:grid-cols-2 gap-x-6 gap-y-1 text-sm py-2">
        ${item(tr('fin_kind', 'Вид'), FinUtils.typeLabel(r.type))}
        ${item(tr('dacc_handed_to', 'сдано'), r.ext ? r.account_name : '')}
        ${item(tr('dacc_contra', 'Другой счёт'), r.contra_account ? `${r.direction === 'out' ? tr('dacc_to', 'куда') : tr('dacc_from', 'откуда')} — ${r.contra_account}` : '')}
        ${item(tr('fin_category', 'Статья'), r.category_name)}
        ${item(tr('fin_retreat_object', 'Ретрит'), r.object_name)}
        ${item(tr('fin_participant', 'Участник'), r.participant_name)}
        ${item(tr('fin_contractor', 'Контрагент'), r.contractor_name)}
        ${item(tr('fin_cost_center', 'Центр затрат'), r.cost_center_name)}
        ${item(tr('fin_channel', 'Канал оплаты'), r.payment_channel ? FinUtils.channelLabel(r.payment_channel) : '')}
        ${item(tr('fin_comment', 'Комментарий'), r.comment)}
        ${item(tr('fin_reason', 'Причина'), r.reason)}
        ${item(tr('dacc_entered_at', 'Внесено'), r.created_at ? new Date(r.created_at).toLocaleString('ru-RU') : '')}
        ${r.currency_code !== 'INR' && r.amount_base ? item(tr('dacc_in_inr', 'В рупиях'), money(r.amount_base, 'INR')) : ''}
        <div>${FinUtils.approvalBadge(r.approval)}</div>
        ${canDds ? `<div><a class="link link-primary" href="../finance/dds.html?op=${encodeURIComponent(r.operation_id)}" target="_blank" rel="noopener">${e(tr('fin_open_in_dds', 'Открыть в ДДС'))} →</a></div>` : ''}
    </div>`;
}

function sortIcon(key) {
    if (sort.key !== key) return '<span class="opacity-30">↕</span>';
    return sort.dir === 'asc' ? '↑' : '↓';
}

function renderTable(list) {
    const cmp = sort.key === 'amount'
        ? (a, b) => Number(a.signed_amount) - Number(b.signed_amount) || a.ord - b.ord
        : null;
    // по дате пара не разрывается: перевод сверху, трата сразу под ним в обоих направлениях
    const sorted = cmp ? [...list].sort(cmp) : [...list].sort((a, b) => (sort.dir === 'desc' ? b.grp - a.grp : a.grp - b.grp) || a.sub - b.sub);
    if (cmp && sort.dir === 'desc') sorted.reverse();
    $('daccHead').innerHTML = `<tr>
        <th class="w-6"></th>
        <th class="cursor-pointer select-none whitespace-nowrap" data-dacc-sort="date">${e(tr('fin_occurred_on', 'Дата'))} ${sortIcon('date')}</th>
        <th>${e(tr('fin_kind', 'Вид'))}</th>
        <th>${e(tr('fin_category', 'Статья'))}</th>
        <th>${e(tr('fin_comment', 'Комментарий'))}</th>
        <th class="text-right cursor-pointer select-none whitespace-nowrap" data-dacc-sort="amount">${e(tr('fin_amount', 'Сумма'))} ${sortIcon('amount')}</th>
        <th class="text-right whitespace-nowrap" title="${e(tr('dacc_after_hint', 'Сколько было на счёте после этой операции — по дате операции'))}">${e(tr('fin_running_balance', 'Остаток после'))}</th>
    </tr>`;
    if (!sorted.length) {
        $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-6 opacity-60">${e(tr('fin_no_operations', 'Операций нет'))}</td></tr>`;
        return;
    }
    $('daccBody').innerHTML = sorted.map(r => {
        const open = opened.has(r.posting_id);
        const v = Number(r.signed_amount);
        const paired = r.gid && r.sub > 0 && !cmp;
        return `<tr class="cursor-pointer hover:bg-base-200 ${r.is_reversed || r.type === 'reversal' ? 'opacity-60' : ''} ${open ? 'bg-base-200' : ''} ${paired ? 'dacc-paired' : ''}" data-dacc-row="${r.posting_id}">
            <td class="opacity-60">${open ? '▾' : '▸'}</td>
            <td class="whitespace-nowrap">${e(fmtDay(r.occurred_on))}</td>
            <td>${paired ? `<span class="opacity-50" title="${e(tr('dacc_paired_hint', 'Потрачено сразу из этого перевода'))}">↳ </span>` : ''}${kindCell(r)}</td>
            <td>${e(r.category_name || '—')}</td>
            <td class="max-w-md"><div class="truncate opacity-70" title="${e(r.comment || r.reason || '')}">${e(r.comment || r.reason || '')}</div>${
                r.participant_name || r.contractor_name ? `<div class="text-xs opacity-60 truncate">${e(r.participant_name || r.contractor_name)}</div>` : ''}</td>
            <td class="text-right font-mono whitespace-nowrap ${v < 0 ? 'text-red-600' : 'text-blue-600'}">${signed(v, r.currency_code)}</td>
            <td class="text-right font-mono whitespace-nowrap ${r.bal < 0 ? 'text-error' : ''} ${r.ext ? 'opacity-30' : ''}">${r.ext ? '—' : money(r.bal, r.currency_code)}</td>
        </tr>${open ? `<tr class="bg-base-200/40"><td></td><td colspan="6">${detailHtml(r)}</td></tr>` : ''}`;
    }).join('');
}

function render() {
    const list = filtered();
    renderTotals(list);
    if (view === 'analytics') { renderAnalytics(); return; }
    renderSummary();
    renderTable(list);
    $('daccCount').textContent = `${tr('fin_shown_count', 'Показано')}: ${list.length}`;
}

function exportCsv() {
    const list = filtered();
    const header = ['Дата', 'Вид', 'Другой счёт', 'Статья', 'Ретрит', 'От кого / кому', 'Комментарий', 'Сумма', 'Валюта', 'Остаток после'];
    const data = list.map(r => [r.occurred_on, FinUtils.typeLabel(r.type), r.ext ? `${tr('dacc_handed_to', 'сдано')}: ${r.account_name}` : (r.contra_account || ''), r.category_name || '', r.object_name || '',
        r.participant_name || r.contractor_name || '', r.comment || r.reason || '', r.signed_amount, r.currency_code, r.ext ? '' : r.bal]);
    const csv = '﻿' + [header, ...data].map(x => x.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${cfg.department}-${DateUtils.toISO(new Date())}.csv`;
    a.click();
}

// ---------- запуск ----------
async function init(options) {
    cfg = options;
    await Layout.init({ module: cfg.module, menuId: cfg.menuId, itemId: cfg.itemId });
    accounts = await loadAccounts();
    if (accounts === null) { $('daccNoAccess').classList.remove('hidden'); return; }
    $('daccContent').classList.remove('hidden');
    incomeRows = await loadIncome();
    // вкладка — валюта: в ней все счета департамента этой валюты и выручка, сданная в Кассу / Гест-хаус.
    // Появляется вместе с первой операцией; порядок у всех департаментов один: ₹ → ₽ → $ → € → остальные (ВГ 25.09)
    const CUR_ORDER = ['INR', 'RUB', 'USD', 'EUR'];
    const rank = c => { const i = CUR_ORDER.indexOf(c); return i < 0 ? CUR_ORDER.length : i; };
    const curs = [...new Set([...accounts.map(a => a.currency_code), ...incomeRows.map(r => r.currency_code)])]
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    if (!curs.length) {
        $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-6 opacity-60">${e(tr('dacc_no_accounts', 'У департамента пока нет счёта'))}</td></tr>`;
        return;
    }
    const sym = c => ({ INR: '₹', RUB: '₽', USD: '$', EUR: '€' }[c] || '');
    $('daccTabs').innerHTML = curs.map(c => `<a role="tab" class="tab" data-dacc-cur="${e(c)}">${e(`${sym(c)} ${c}`.trim())}</a>`).join('');
    $('daccTabs').classList.remove('hidden');

    $('daccTabs').addEventListener('click', ev => {
        const tab = ev.target.closest('[data-dacc-cur]');
        if (tab && tab.dataset.daccCur !== currentCur) selectCurrency(tab.dataset.daccCur);
    });
    ['daccDir', 'daccCategory'].forEach(id => $(id).addEventListener('change', render));
    // свои даты — сразу полями: ввели дату, подсветка пресета снимается
    ['daccFrom', 'daccTo'].forEach(id => $(id).addEventListener('change', () => { markPreset('custom'); render(); }));
    $('daccSearch').addEventListener('input', Layout.debounce(render, 300));
    document.querySelectorAll('[data-dacc-preset]').forEach(b => b.addEventListener('click', () => setPreset(b.dataset.daccPreset)));
    $('daccCsv').addEventListener('click', exportCsv);
    $('daccViewTabs').addEventListener('click', ev => {
        const tab = ev.target.closest('[data-dacc-view]');
        if (tab && tab.dataset.daccView !== view) setView(tab.dataset.daccView);
    });
    $('daccAnalytics').addEventListener('click', ev => {
        const st = ev.target.closest('[data-dacc-step]');
        if (st) {
            step = st.dataset.daccStep;
            try { localStorage.setItem('dept_account_step', step); } catch { /* нет хранилища */ }
            renderAnalytics();
            return;
        }
        const c = ev.target.closest('[data-dacc-pick]');
        if (c) pickFromSummary(JSON.parse(c.dataset.daccPick));
    });
    $('daccSummary').addEventListener('click', ev => {
        if (ev.target.closest('[data-dacc-pick-reset]')) {
            $('daccCategory').value = ''; $('daccDir').value = ''; $('daccSearch').value = '';
            render();
            return;
        }
        const btn = ev.target.closest('[data-dacc-pick]');
        if (btn) pickFromSummary(JSON.parse(btn.dataset.daccPick));
    });
    $('daccHead').addEventListener('click', ev => {
        const th = ev.target.closest('[data-dacc-sort]');
        if (!th) return;
        const key = th.dataset.daccSort;
        sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' };
        render();
    });
    $('daccBody').addEventListener('click', ev => {
        const rowEl = ev.target.closest('[data-dacc-row]');
        if (!rowEl) return;
        const id = rowEl.dataset.daccRow;
        if (opened.has(id)) opened.delete(id); else opened.add(id);
        render();
    });

    // по умолчанию — этот год (решение ВГ 25.09: за всё время суммы копятся годами и пугают)
    let preset = 'year';
    try { preset = localStorage.getItem('dept_account_period') || 'year'; } catch { /* нет хранилища */ }
    let r = presetRange(preset);
    if (!r) { preset = 'year'; r = presetRange(preset); }
    $('daccFrom').value = r[0]; $('daccTo').value = r[1];
    markPreset(preset);
    try {
        step = localStorage.getItem('dept_account_step') || 'month';
        if (localStorage.getItem('dept_account_view') === 'analytics') setView('analytics');
    } catch { /* нет хранилища */ }
    if (!['month', 'quarter', 'year'].includes(step)) step = 'month';
    await selectCurrency(curs[0]);
}

return { init };
})();
