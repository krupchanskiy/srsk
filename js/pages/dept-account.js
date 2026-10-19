// ==================== СЧЁТ ДЕПАРТАМЕНТА ====================
// Движение денег по счетам департамента — только просмотр (решение ВГ 25.09.2026).
// Глава департамента видит свой счёт: приходы, расходы, переводы к другим счетам и от них;
// фильтры и сортировка как в ДДС, ничего менять нельзя. Данные — та же лента ДДС
// (fin_v_account_ledger), какие счета чьи — fin_department_accounts.
// ВГ 19.10 — три разных вида денег, не в одной куче:
//   «Подотчёт» — счёт департамента: что выдали и что на это потрачено (без временной кассы);
//   «Выручка» — приходы по статьям департамента с любого счёта, каждая операция (fin_department_income);
//   «Касса ДДС» — временная касса, которая хранится у департамента (Касса ДДС у ГХ, мигр. 711),
//     и прошлые операции такой кассы на счёте департамента (is_transit).
// Вкладки валют — для «Подотчёта», «Кассы ДДС» и «Аналитики»; «Выручка» показывает все валюты сразу.
// Пилот — Кухня (kitchen/account.html); другой департамент — такая же страница со своим названием.
window.DeptAccount = (function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов не обновился — русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

let cfg = null;
let accounts = [];
let currentCur = null;    // вкладка валюты
let ledgers = { own: [], box: [] };   // «Подотчёт» и «Касса ДДС» выбранной валюты
let rows = [];            // лента текущей вкладки, по дате (внутри дня — приходы раньше), .bal — остаток после
const opened = new Set(); // раскрытые строки (posting_id)
let sort = { key: 'date', dir: 'desc' };
// Выручка: приходы по статьям департамента с любого счёта (мигр. 706/711) — выручку магазина сдают
// в Кассу и Гест-хаус, а не на его счёт
let incomeRows = [];
const ledgerKind = () => view === 'box' ? 'box' : 'own';

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

const rowsCache = new Map();   // account_id → проводки: аналитика берёт все валюты, вкладка — одну
async function loadRows(accountId) {
    if (rowsCache.has(accountId)) return rowsCache.get(accountId);
    const out = [];
    for (let off = 0; ; off += 1000) {
        const { data, error } = await Layout.db.from('fin_v_account_ledger').select('*')
            .eq('account_id', accountId).order('ledger_seq').range(off, off + 999);
        if (error) { Layout.handleError(error, tr('dacc_title', 'Счёт')); break; }
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    rowsCache.set(accountId, out);
    return out;
}

// Лента: по дате, пары «перевод + трата» рядом, «Остаток после» по деньгам этой ленты.
// Перевод внутри самой ленты (+X и −X: ручная правка держателя, перенос временной кассы на её счёт)
// денег не двигает — его не показываем.
function buildLedger(list, groups) {
    const byOp = new Map();
    list.forEach(r => (byOp.get(r.operation_id) || byOp.set(r.operation_id, []).get(r.operation_id)).push(r));
    const inner = new Set();
    byOp.forEach((ops, op) => {
        if (ops.length > 1 && ops.every(r => r.type === 'transfer')
            && Math.abs(ops.reduce((x, r) => x + Number(r.signed_amount), 0)) < 0.005) inner.add(op);
    });
    // Остаток после операции — по дате операции (а не по порядку внесения): операцию, внесённую
    // задним числом, ставим на её дату, иначе в столбце «Остаток после» скачки (замечание ВГ 25.09)
    // в пределах одного дня сначала приходы, потом расходы — чтобы не было ложного минуса внутри дня
    const inFirst = r => Number(r.signed_amount) >= 0 ? 0 : 1;
    const base = list.filter(r => !inner.has(r.operation_id))
        .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || inFirst(a) - inFirst(b) || a.ledger_seq - b.ledger_seq);
    const out = pairUp(base, groups);
    let bal = 0;
    out.forEach((r, i) => { bal += Number(r.signed_amount); r.bal = Math.round(bal * 100) / 100; r.ord = i; });
    // пара «перевод + трата» — одна позиция в ленте: grp — место пары, sub — порядок внутри (перевод, потом трата)
    const first = new Map();
    out.forEach(r => { const k = r.gid || r.posting_id; if (!first.has(k)) first.set(k, r.ord); r.grp = first.get(k); r.sub = r.ord - r.grp; });
    return out;
}

async function selectCurrency(cur) {
    currentCur = cur;
    document.querySelectorAll('[data-dacc-cur]').forEach(b => b.classList.toggle('tab-active', b.dataset.daccCur === cur));
    $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    const inCur = accounts.filter(a => a.currency_code === cur);
    const loaded = await Promise.all(inCur.map(a => Promise.all([loadRows(a.account_id), Layout.db.rpc('fin_account_op_groups', { p_account: a.account_id })])));
    const groups = loaded.flatMap(([, g]) => g.data || []);
    const own = [], box = [];
    inCur.forEach((a, i) => loaded[i][0].forEach(r => {
        // прошлые операции временной кассы на счёте департамента — в «Кассу ДДС», не в «Подотчёт»
        if (a.purpose === 'cashbox' || r.is_transit) box.push(r); else own.push(r);
    }));
    ledgers = { own: buildLedger(own, groups), box: buildLedger(box, groups) };
    setLedger();
}

// лента текущей вкладки + список статей для фильтра
function setLedger() {
    rows = ledgers[ledgerKind()];
    opened.clear();
    const purpose = ledgerKind() === 'box' ? 'cashbox' : 'own';
    $('daccAccountName').textContent = accounts.filter(a => a.currency_code === currentCur && a.purpose === purpose).map(a => a.name).join(', ');
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
    const box = ledgerKind() === 'box';
    const from = $('daccFrom').value, to = $('daccTo').value;
    const today = DateUtils.toISO(new Date());
    const now = rows.length ? rows[rows.length - 1].bal : 0;
    // остатки — по всей ленте, без учёта фильтров по статье и поиску
    const before = from ? rows.filter(r => r.occurred_on < from) : [];
    const upto = to ? rows.filter(r => r.occurred_on <= to) : rows;
    const opening = before.length ? before[before.length - 1].bal : 0;
    const closing = upto.length ? upto[upto.length - 1].bal : 0;
    // сторно и отменённая операция вместе дают ноль — в итоги их не берём (как в ДДС)
    let given = 0, income = 0, spent = 0, passed = 0, rev = 0;
    for (const r of list) {
        const v = Number(r.signed_amount);
        if (isStorno(r)) rev += Math.abs(v);
        else if (v >= 0) { if (r.type === 'transfer') given += v; else income += v; }
        else if (r.type === 'transfer') passed -= v; else spent -= v;
    }
    const filteredNote = $('daccCategory').value || $('daccSearch').value.trim() || $('daccDir').value
        ? ` <span class="text-xs font-normal opacity-60">${e(tr('dacc_by_filter', 'по фильтру'))}</span>` : '';
    const val = (v, cls) => `<span class="${cls}">${money(v, cur)}</span>${filteredNote}`;
    // «Подотчёт»: выдали → потратили → на руках (ВГ 19.10). Приход прямо на счёт департамента
    // (касса кафе на «Кафе») — отдельной плашкой, только если он есть
    const chips = box ? [
        chip(tr('dacc_box_now', 'В кассе ДДС'), money(now, cur), now < 0 ? 'text-error' : ''),
        chip(tr('dacc_in', 'Пришло'), val(given + income, 'text-blue-600')),
        chip(tr('dacc_out', 'Ушло'), val(spent + passed, 'text-red-600'))
    ] : [
        chip(tr('dacc_on_hand', 'На руках у департамента'), money(now, cur), now < 0 ? 'text-error' : ''),
        chip(tr('dacc_given', 'Выдано'), val(given, 'text-teal-600'), '', tr('dacc_received_hint', 'Деньги, выданные департаменту из общей кассы или с других счетов')),
        ...(income ? [chip(tr('dacc_income_on_acc', 'Пришло на счёт'), val(income, 'text-blue-600'))] : []),
        chip(tr('dacc_spent', 'Потратил'), val(spent, 'text-red-600'))
    ];
    $('daccTotals').innerHTML = chips.join('');
    // «было → стало» — только для прошлых периодов: если период доходит до сегодня, «стало» = «сейчас»
    const parts = [];
    if (from && to && to < today) parts.push(`${fmtDay(from)}: ${money(opening, cur)} → ${fmtDay(to)}: <b>${money(closing, cur)}</b>`);
    else if (from) parts.push(`${tr('dacc_opening', 'На начало')} ${fmtDay(from)}: ${money(opening, cur)}`);
    if (!box && passed) parts.push(`${e(tr('dacc_passed_on', 'передано на другие счета'))}: ${money(passed, cur)}`);
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

// ---------- выручка: каждая операция (ВГ 19.10: «видеть все деньги за мурти и за магазин, не просто итог») ----------
const CAFE_POINTS = { self: 'Самообслуживание', cafe: 'Кафе' };
const CUR_ORDER = ['INR', 'RUB', 'USD', 'EUR'];
const curRank = c => { const i = CUR_ORDER.indexOf(c); return i < 0 ? CUR_ORDER.length : i; };

// суммы по валютам строкой: «₹88 100 · ₽23 000 · €100» — валюты не складываем
function byCurrency(list) {
    const m = new Map();
    for (const r of list) m.set(r.currency_code, (m.get(r.currency_code) || 0) + Number(r.signed_amount));
    return [...m.entries()].filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => curRank(a[0]) - curRank(b[0]))
        .map(([c, v]) => money(v, c)).join(' · ') || '—';
}

function renderRevenue() {
    const from = $('daccFrom').value, to = $('daccTo').value;
    const inPeriod = incomeRows.filter(r => (!from || r.occurred_on >= from) && (!to || r.occurred_on <= to));
    const live = inPeriod.filter(r => !isStorno(r));
    const cat = $('daccRevCat').value;
    // по статьям: сколько операций и сколько в каждой валюте; сторно и отменённое не считаем
    const cats = new Map();
    live.forEach(r => (cats.get(r.category_id) || cats.set(r.category_id, { name: r.category_name, rows: [] }).get(r.category_id)).rows.push(r));
    const base = list => list.reduce((x, r) => x + Math.sign(Number(r.signed_amount)) * Math.abs(Number(r.amount_base)), 0);
    const cards = [...cats.entries()].sort((a, b) => base(b[1].rows) - base(a[1].rows)).map(([id, g]) => `
        <button type="button" class="text-left bg-base-100 rounded-xl shadow-sm p-4 hover:shadow-md ${cat === id ? 'ring-2 ring-primary' : ''}" data-dacc-rev-cat="${e(id)}">
            <div class="text-xs uppercase tracking-wide opacity-60">${e(g.name)} · ${g.rows.length}</div>
            <div class="text-xl font-bold mt-1 text-blue-600">${byCurrency(g.rows)}</div>
            <div class="text-xs opacity-50">≈ ${money(base(g.rows), 'INR')}</div>
        </button>`).join('');
    $('daccRevSummary').innerHTML = `
        <div class="bg-base-100 rounded-xl shadow-sm p-4">
            <div class="text-xs uppercase tracking-wide opacity-60">${e(tr('dacc_rev_total', 'Выручка за период'))} · ${live.length}</div>
            <div class="text-2xl font-bold mt-1 text-blue-600">${byCurrency(live)}</div>
            <div class="text-xs opacity-50">≈ ${money(base(live), 'INR')} · ${e(tr('dacc_rev_hint', 'с любого счёта, куда сдали деньги; «≈» — в рупиях по курсу дня'))}</div>
        </div>${cards}`;
    // список статей для фильтра — по всей выручке, не только за период
    const sel = $('daccRevCat');
    const all = [...new Map(incomeRows.map(r => [r.category_id, r.category_name])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'ru'));
    if (sel.options.length !== all.length + 1) {
        sel.innerHTML = `<option value="">${e(tr('fin_filter_all_categories', 'Все статьи'))}</option>` + all.map(([id, n]) => `<option value="${e(id)}">${e(n)}</option>`).join('');
        sel.value = cat;
    }
    const q = $('daccRevSearch').value.trim().toLowerCase();
    const list = inPeriod.filter(r => (!cat || r.category_id === cat)
        && (!q || [r.comment, r.note, r.account_name, r.category_name, String(r.amount)].filter(Boolean).join(' ').toLowerCase().includes(q)))
        .slice().reverse();
    $('daccRevCount').textContent = `${tr('fin_shown_count', 'Показано')}: ${list.length}`;
    $('daccRevBody').innerHTML = list.length ? list.map(r => {
        const v = Number(r.signed_amount);
        const extra = [CAFE_POINTS[r.cafe_point], r.note].filter(Boolean).join(' · ');
        return `<tr class="${isStorno(r) ? 'opacity-50' : ''}">
            <td class="whitespace-nowrap">${e(fmtDay(r.occurred_on))}</td>
            <td>${e(r.category_name)}${r.is_reversed ? ` <span class="badge badge-ghost badge-xs">${e(tr('fin_reversed_badge', 'сторнировано'))}</span>` : ''}${
                r.type === 'reversal' ? ` <span class="badge badge-ghost badge-xs">${e(FinUtils.typeLabel(r.type))}</span>` : ''}${extra ? `<div class="text-xs opacity-60">${e(extra)}</div>` : ''}</td>
            <td class="whitespace-nowrap opacity-70">${e(r.account_name)}</td>
            <td class="max-w-md"><div class="truncate opacity-70" title="${e(r.comment || '')}">${e(r.comment || '')}</div></td>
            <td class="text-right font-mono whitespace-nowrap ${v < 0 ? 'text-red-600' : 'text-blue-600'}">${signed(v, r.currency_code)}${
                r.currency_code !== 'INR' ? `<div class="text-xs opacity-50">≈ ${money(r.amount_base, 'INR')}</div>` : ''}</td>
        </tr>`;
    }).join('') : `<tr><td colspan="5" class="text-center py-6 opacity-60">${e(tr('fin_no_operations', 'Операций нет'))}</td></tr>`;
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

// Аналитика — результат департамента (ВГ 19.10): сколько заработал и сколько потратил за каждый
// месяц / квартал / год и что в итоге. Выдачи на подотчёт — не доход, их здесь нет (они в «Подотчёте»).
// Данные — fin_department_analytics (мигр. 718), правила на сервере:
//   выручка — статьи департамента и статьи его производственных линий (у Мастерской — «Мурти»);
//   расходы — траты с его счетов (без временной кассы); у продавца — ещё себестоимость линии
//   у производителя (мурти Мастерской — и в Магазине, одни и те же цифры);
//   траты на ретриты — затраты ретрита, в итог не входят, показаны отдельно (ВГ 19.10).
// Все валюты вместе, в рупиях по курсу дня операции; сторно не учитывается.
let anRows = [];
// рупии со знаком операции: в ленте amount_base всегда положительный, знак — у signed_amount
const baseSigned = r => Math.sign(Number(r.signed_amount)) * Math.abs(Number(r.amount_base));

function analyticsData() {
    const today = DateUtils.toISO(new Date());
    const live = anRows.filter(r => !isStorno(r));
    const rev = live.filter(r => r.kind === 'revenue');
    const cost = live.filter(r => r.kind === 'cost');
    const dates = [...rev, ...cost].map(r => r.occurred_on).sort();
    const from = $('daccFrom').value || dates[0] || today;
    let to = $('daccTo').value || dates[dates.length - 1] || today;
    if (to > today && from <= today) to = today;   // будущие месяцы года — без пустых столбцов
    const inP = r => r.occurred_on >= from && r.occurred_on <= to;
    const buckets = bucketList(from, to);
    const idx = new Map(buckets.map((b, i) => [b, i]));
    const side = (list, keyOf, value) => {
        const groups = new Map();
        const totals = buckets.map(() => 0);
        for (const r of list) {
            if (!inP(r)) continue;
            const i = idx.get(bucketOf(r.occurred_on));
            if (i === undefined) continue;
            const gr = keyOf(r);
            const g = groups.get(gr.key) || groups.set(gr.key, { ...gr, cells: buckets.map(() => 0), sum: 0, rows: [] }).get(gr.key);
            g.rows.push(r);
            const v = value(r);
            g.cells[i] += v; g.sum += v; totals[i] += v;
        }
        return { groups: [...groups.values()].sort((a, b) => b.sum - a.sum), totals, sum: totals.reduce((a, b) => a + b, 0) };
    };
    const revenue = side(rev, r => ({ key: `r:${r.category_id}`, label: r.category_name, line: r.line, pick: { rev: r.category_id } }), r => baseSigned(r));
    const costs = side(cost,
        r => r.source
            ? { key: `x:${r.category_id}:${r.source}`, label: r.category_name, src: r.source, line: r.line }
            : { key: `c:${r.category_id}`, label: r.category_name, line: r.line, pick: { cat: r.category_id } },
        r => -baseSigned(r));
    const retreat = side(live.filter(r => r.kind === 'retreat'), r => ({ key: `t:${r.object_name}`, label: r.object_name }), r => -baseSigned(r));
    const result = buckets.map((_, i) => revenue.totals[i] - costs.totals[i]);
    // выручка по валютам за период — какие деньги на самом деле пришли
    const revCur = new Map();
    rev.filter(inP).forEach(r => revCur.set(r.currency_code, (revCur.get(r.currency_code) || 0) + Number(r.signed_amount)));
    // направления (производственные линии): выручка − себестоимость; без линии — «Остальное»
    const lineNames = [...new Set([...revenue.groups, ...costs.groups].map(g => g.line).filter(Boolean))];
    const lines = lineNames.length ? [...lineNames, null].map(name => {
        const rg = revenue.groups.filter(g => (g.line || null) === name), cg = costs.groups.filter(g => (g.line || null) === name);
        const r = rg.reduce((x, g) => x + g.sum, 0), c = cg.reduce((x, g) => x + g.sum, 0);
        return { name, key: `l:${name || ''}`, rev: r, cost: c, res: r - c, rg, cg };
    }).filter(l => l.rev || l.cost) : [];
    return { buckets, from, to, revenue, costs, retreat, result, revCur, lines };
}

// Как «Себестоимость» на кухне (ВГ 19.10): сверху всегда главные цифры, ниже разделы —
// «Сводка» (откуда выручка и на что расходы), «По месяцам» (таблица), «Графики». Не всё сразу.
let anSection = 'summary';
const anOpen = new Set();      // раскрытые статьи в «Сводке»
const anTableOpen = new Map(); // «По месяцам»: статья → 'all' (все операции) или номер месяца
let anResultOpen = false;      // раскрыт ли «Итог» по месяцам

// операции статьи — дата, где лежали деньги, комментарий, сумма в своей валюте и в рупиях
function opsListHtml(list) {
    return `<div class="ml-2 mb-2 border-l-2 border-base-300 pl-3 text-sm">${list.slice().sort((a, b) => b.occurred_on.localeCompare(a.occurred_on)).map(r => {
        const extra = [CAFE_POINTS[r.cafe_point], r.note].filter(Boolean).join(' · ');
        const v = Number(r.signed_amount);
        return `<div class="flex items-baseline gap-2 py-0.5">
            <span class="opacity-60 w-14 shrink-0">${e(fmtDay(r.occurred_on))}</span>
            <span class="opacity-60 shrink-0 hidden sm:inline">${e(r.account_name || '')}</span>
            <span class="truncate flex-1 opacity-80" title="${e([r.comment, extra].filter(Boolean).join(' · '))}">${e(r.comment || extra || '')}</span>
            <span class="font-mono whitespace-nowrap">${money(Math.abs(v), r.currency_code)}</span>
            ${r.currency_code !== 'INR' ? `<span class="font-mono whitespace-nowrap text-xs opacity-50">≈ ${money(Math.abs(Number(r.amount_base)), 'INR')}</span>` : ''}
        </div>`;
    }).join('')}</div>`;
}

function renderAnalytics() {
    const box = $('daccAnalytics');
    const d = analyticsData();
    const n = d.buckets.length;
    const inr = v => money(v, 'INR');
    const sgn = v => `${v >= 0 ? '+' : '−'}${inr(Math.abs(v))}`;
    const stepWord = { month: tr('cost_step_month', 'Месяц'), quarter: tr('cost_step_quarter', 'Квартал'), year: tr('cost_step_year', 'Год') }[step].toLowerCase();
    const res = d.revenue.sum - d.costs.sum;
    const revCurLine = [...d.revCur.entries()].filter(([, v]) => Math.abs(v) >= 0.005).sort((a, b) => curRank(a[0]) - curRank(b[0]))
        .map(([c, v]) => money(v, c)).join(' · ');
    // главные цифры — видны всегда
    const kpi = (label, value, cls, sub) => `<div class="bg-base-100 rounded-xl shadow-sm p-4">
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls}">${value}</div>
        ${sub ? `<div class="text-xs opacity-60 mt-0.5">${sub}</div>` : ''}</div>`;
    const kpis = [
        kpi(tr('dacc_an_revenue', 'Выручка'), inr(d.revenue.sum), 'text-blue-600', revCurLine),
        kpi(tr('dacc_an_costs', 'Расходы'), inr(d.costs.sum), 'text-red-600',
            d.revenue.sum ? `${Math.round(d.costs.sum / d.revenue.sum * 100)}% ${e(tr('dacc_an_margin', 'от выручки'))}` : ''),
        `<div class="bg-base-100 rounded-xl shadow-sm p-4 ${n > 1 ? 'cursor-pointer hover:shadow-md' : ''}" ${n > 1 ? 'data-dacc-an-result' : ''}>
            <div class="text-xs uppercase tracking-wide opacity-60">${e(tr('dacc_an_result', 'Итог'))}${n > 1 ? ` <span class="opacity-60">${anResultOpen ? '▾' : '▸'}</span>` : ''}</div>
            <div class="text-2xl font-bold mt-1 ${res >= 0 ? 'text-green-600' : 'text-red-600'}">${sgn(res)}</div>
            <div class="text-xs opacity-60 mt-0.5">${inr(d.revenue.sum)} − ${inr(d.costs.sum)}${d.revenue.sum ? ` · ${Math.round(res / d.revenue.sum * 100)}% ${e(tr('dacc_an_margin', 'от выручки'))}` : ''}</div></div>`,
        n > 1 ? kpi(`${tr('dacc_an_per_bucket', 'в среднем за')} ${stepWord}`, sgn(res / n), res >= 0 ? 'text-green-600' : 'text-red-600',
            `${inr(d.revenue.sum / n)} − ${inr(d.costs.sum / n)}`) : ''
    ].join('');
    const sections = [['summary', tr('dacc_an_sec_summary', 'Сводка')], ['table', tr('dacc_an_sec_table', 'По месяцам')], ['charts', tr('cost_section_charts', 'Графики')]];
    const stepBtn = (s, key, ru) => `<button class="btn btn-sm join-item ${step === s ? 'btn-active' : ''}" data-dacc-step="${s}">${e(tr(key, ru))}</button>`;
    let body = '';
    if (anSection === 'summary') {
        // откуда выручка и на что расходы — по статьям, с долями
        const lines = (groups, total, color) => groups.map(g => {
            const share = total ? g.sum / total : 0;
            const open = anOpen.has(g.key);
            return `<div class="px-2 py-1.5 rounded-lg cursor-pointer hover:bg-base-200 ${open ? 'bg-base-200' : ''}" data-dacc-an-open="${e(g.key)}">
                <div class="flex items-baseline gap-2 text-sm">
                    <span class="opacity-50 w-3">${open ? '▾' : '▸'}</span>
                    <span class="truncate flex-1 ${open ? 'font-semibold' : ''}">${e(g.label)} <span class="opacity-50 text-xs">· ${g.rows.length}</span>${g.src ? ` <span class="badge badge-ghost badge-xs" title="${e(`${tr('dacc_an_from_other', 'траты других департаментов на')} «${g.obj}»`)}">${e(g.src)}</span>` : ''}</span>
                    <span class="opacity-50 text-xs">${Math.round(share * 100)}%</span>
                    <span class="font-mono whitespace-nowrap">${inr(g.sum)}</span>
                </div>
                <div class="h-1 rounded-full bg-base-200 mt-1"><div class="h-1 rounded-full ${color}" style="width:${Math.max(share * 100, 1).toFixed(1)}%"></div></div>
            </div>${open ? opsListHtml(g.rows) : ''}`;
        }).join('') || `<div class="px-2 py-3 text-sm opacity-60">${e(tr('dacc_sum_empty', 'Нет операций'))}</div>`;
        const card = (title, s, color, textCls) => `<div class="bg-base-100 rounded-xl shadow-sm p-3">
            <div class="flex items-baseline justify-between px-2 mb-1">
                <div class="text-xs uppercase tracking-wide opacity-60">${e(title)}</div>
                <div class="font-mono font-semibold ${textCls}">${inr(s.sum)}</div>
            </div>${lines(s.groups, s.sum, color)}</div>`;
        // по направлениям: продукт — выручка − себестоимость = итог; нажатие раскрывает его статьи
        const linesCard = d.lines.length ? `<div class="bg-base-100 rounded-xl shadow-sm p-3 md:col-span-2">
            <div class="text-xs uppercase tracking-wide opacity-60 px-2 mb-1">${e(tr('dacc_an_lines', 'По направлениям'))}</div>
            ${d.lines.map(l => {
                const open = anOpen.has(l.key);
                return `<div class="px-2 py-1.5 rounded-lg cursor-pointer hover:bg-base-200 ${open ? 'bg-base-200' : ''}" data-dacc-an-open="${e(l.key)}">
                    <div class="flex flex-wrap items-baseline gap-2 text-sm">
                        <span class="opacity-50 w-3">${open ? '▾' : '▸'}</span>
                        <span class="flex-1 font-semibold">${e(l.name || tr('dacc_an_rest', 'Остальное'))}</span>
                        <span class="font-mono text-blue-600">${inr(l.rev)}</span><span class="opacity-50">−</span>
                        <span class="font-mono text-red-600">${inr(l.cost)}</span><span class="opacity-50">=</span>
                        <span class="font-mono font-semibold ${l.res >= 0 ? 'text-green-600' : 'text-red-600'}">${sgn(l.res)}</span>
                    </div></div>${open ? `<div class="ml-6 mb-2 text-sm">${[...l.rg.map(g => [g, 'text-blue-600']), ...l.cg.map(g => [g, 'text-red-600'])].map(([g, c]) => `
                        <div class="flex items-baseline gap-2 py-0.5"><span class="flex-1">${e(g.label)}${g.src ? ` <span class="badge badge-ghost badge-xs">${e(g.src)}</span>` : ''}</span>
                        <span class="font-mono ${c}">${inr(g.sum)}</span></div>`).join('')}</div>` : ''}`;
            }).join('')}</div>` : '';
        // траты на ретриты — затраты ретритов: видны, но в итог не входят
        const rOpen = anOpen.has('retreats');
        const retreatsCard = d.retreat.sum ? `<div class="bg-base-100 rounded-xl shadow-sm p-3 md:col-span-2 opacity-80">
            <div class="px-2 py-1.5 rounded-lg cursor-pointer hover:bg-base-200" data-dacc-an-open="retreats">
                <div class="flex items-baseline gap-2 text-sm"><span class="opacity-50 w-3">${rOpen ? '▾' : '▸'}</span>
                <span class="flex-1">${e(tr('dacc_an_retreats', 'Траты на ретриты — затраты ретритов, в итог не входят'))}</span>
                <span class="font-mono">${inr(d.retreat.sum)}</span></div></div>
            ${rOpen ? lines(d.retreat.groups, d.retreat.sum, 'bg-base-300') : ''}</div>` : '';
        body = `<div class="grid md:grid-cols-2 gap-3">
            ${linesCard}
            ${card(tr('dacc_an_rev_from', 'Выручка — откуда'), d.revenue, 'bg-blue-500', 'text-blue-600')}
            ${card(tr('dacc_an_costs_on', 'Расходы — на что'), d.costs, 'bg-red-500', 'text-red-600')}
            ${retreatsCard}
        </div>`;
    } else if (anSection === 'table') {
        const fmt = v => v ? inr(v) : '<span class="opacity-30">—</span>';
        const cell = (g, i, kind) => {
            const v = g.cells[i];
            // перекос — только у регулярной траты (хотя бы в трёх столбцах): в полтора раза больше обычного — оранжевая,
            // вдвое меньше — голубая; разовая покупка — не перекос, пустой месяц — не провал
            let cls = '', hint = '';
            if (kind === 'out') {
                const used = g.cells.filter(x => x > 0);
                const usual = used.length >= 3 ? used.reduce((a, b) => a + b, 0) / used.length : 0;
                if (usual && v > 0) {
                    const pct = Math.round((v / usual - 1) * 100);
                    if (v >= usual * 1.5) { cls = 'bg-orange-100 text-orange-900'; hint = `+${pct}% ${tr('dacc_an_vs_avg', 'к обычному')}`; }
                    else if (v <= usual * 0.5) { cls = 'bg-sky-100 text-sky-900'; hint = `${pct}% ${tr('dacc_an_vs_avg', 'к обычному')}`; }
                }
            }
            // сумма за месяц раскрывает операции этого месяца прямо под строкой
            const on = anTableOpen.get(g.key) === i;
            return `<td class="text-right font-mono whitespace-nowrap ${cls} ${v ? 'cursor-pointer hover:underline' : ''} ${on ? 'ring-1 ring-primary' : ''}" ${hint ? `title="${e(hint)}"` : ''} ${v ? `data-dacc-an-cell="${e(g.key)}|${i}"` : ''}>${fmt(v)}</td>`;
        };
        // раскрытая строка: все операции статьи по месяцам или операции одного месяца
        const openedRow = g => {
            const st = anTableOpen.get(g.key);
            if (st === undefined) return '';
            const parts = d.buckets.map((b, i) => ({ b, i, rows: g.rows.filter(r => bucketOf(r.occurred_on) === b) }))
                .filter(x => x.rows.length && (st === 'all' || st === x.i));
            return `<tr class="bg-base-200/30"><td colspan="${n + 3}">${parts.map(x => `
                <div class="text-xs uppercase tracking-wide opacity-60 mt-1">${e(bucketLabel(x.b))} · ${inr(g.cells[x.i])}</div>
                ${opsListHtml(x.rows)}`).join('')}</td></tr>`;
        };
        const section = (title, s, kind, color) => `<tr class="bg-base-200/60 font-semibold">
                <td class="sticky left-0 bg-base-200">${e(title)}</td>
                ${s.totals.map(v => `<td class="text-right font-mono whitespace-nowrap ${color}">${fmt(v)}</td>`).join('')}
                <td class="text-right font-mono whitespace-nowrap ${color}">${fmt(s.sum)}</td>
                <td class="text-right font-mono whitespace-nowrap opacity-70">${fmt(s.sum / n)}</td></tr>`
            + (s.groups.map(g => `<tr>
                <td class="sticky left-0 bg-base-100 max-w-[18rem] cursor-pointer hover:bg-base-200" data-dacc-an-cell="${e(g.key)}|all"><div class="truncate" title="${e(g.label)}"><span class="opacity-50">${anTableOpen.get(g.key) === 'all' ? '▾' : '▸'}</span> ${e(g.label)} <span class="opacity-50 text-xs">· ${g.rows.length}</span>${g.src ? ` <span class="badge badge-ghost badge-xs">${e(g.src)}</span>` : ''}</div></td>
                ${g.cells.map((_, i) => cell(g, i, kind)).join('')}
                <td class="text-right font-mono whitespace-nowrap font-semibold">${fmt(g.sum)}</td>
                <td class="text-right font-mono whitespace-nowrap opacity-70">${fmt(g.sum / n)}</td></tr>${openedRow(g)}`).join('')
              || `<tr><td colspan="${n + 3}" class="opacity-60 text-sm">${e(tr('dacc_sum_empty', 'Нет операций'))}</td></tr>`);
        body = `<div class="bg-base-100 rounded-xl shadow-sm overflow-x-auto">
            <table class="table table-sm w-full">
                <thead><tr>
                    <th class="sticky left-0 bg-base-100">${e(tr('fin_category', 'Статья'))}</th>
                    ${d.buckets.map(b => `<th class="text-right whitespace-nowrap">${e(bucketLabel(b))}</th>`).join('')}
                    <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
                    <th class="text-right whitespace-nowrap">${e(tr('dacc_an_avg', 'В среднем'))}</th>
                </tr></thead>
                <tbody>
                    ${section(tr('dacc_an_revenue', 'Выручка'), d.revenue, 'in', 'text-blue-600')}
                    ${section(tr('dacc_an_costs', 'Расходы'), d.costs, 'out', 'text-red-600')}
                    <tr class="font-semibold border-t-2 border-base-300">
                        <td class="sticky left-0 bg-base-100">${e(tr('dacc_an_result', 'Итог'))}</td>
                        ${d.result.map(v => `<td class="text-right font-mono whitespace-nowrap ${v >= 0 ? 'text-green-600' : 'text-red-600'}">${v ? sgn(v) : '—'}</td>`).join('')}
                        <td class="text-right font-mono whitespace-nowrap ${res >= 0 ? 'text-green-600' : 'text-red-600'}">${sgn(res)}</td>
                        <td class="text-right font-mono whitespace-nowrap opacity-70">${sgn(res / n)}</td></tr>
                </tbody>
            </table>
        </div>
        <div class="text-xs opacity-60 mt-2">${e(tr('dacc_an_hint3', 'Оранжевое — трата в полтора раза больше обычной по статье, голубое — вдвое меньше. Нажмите статью — раскроются все её операции по месяцам, сумму за месяц — операции этого месяца'))}</div>`;
    } else {
        body = `<div class="grid xl:grid-cols-2 gap-3">
            <div class="bg-base-100 rounded-xl shadow-sm p-3">
                <div class="text-xs uppercase tracking-wide opacity-60 mb-2">${e(tr('dacc_an_ch_result', 'Выручка, расходы и итог'))}</div>
                <div style="height:300px"><canvas id="daccChart"></canvas></div></div>
            <div class="bg-base-100 rounded-xl shadow-sm p-3">
                <div class="text-xs uppercase tracking-wide opacity-60 mb-2">${e(tr('dacc_an_ch_costs', 'Расходы по статьям'))}</div>
                <div style="height:300px"><canvas id="daccChart2"></canvas></div></div>
        </div>`;
    }
    // «Итог» по месяцам — только по нажатию, иначе за год это длинный список
    const resultList = anResultOpen && n > 1 ? `<div class="bg-base-100 rounded-xl shadow-sm p-3 mb-3 text-sm">${d.buckets.map((b, i) => `
        <div class="flex items-baseline gap-2 py-0.5">
            <span class="w-20">${e(bucketLabel(b))}</span>
            <span class="font-mono text-blue-600">${inr(d.revenue.totals[i])}</span><span class="opacity-50">−</span>
            <span class="font-mono text-red-600">${inr(d.costs.totals[i])}</span><span class="opacity-50">=</span>
            <span class="font-mono font-semibold ${d.result[i] >= 0 ? 'text-green-600' : 'text-red-600'}">${sgn(d.result[i])}</span>
        </div>`).join('')}</div>` : '';
    box.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">${kpis}</div>
        ${resultList}
        <div class="text-xs opacity-60 mb-3">${e(fmtDay(d.from))} — ${e(fmtDay(d.to))} · ${e(tr('dacc_an_base_hint', 'Все суммы — в рупиях по курсу дня операции, все валюты вместе; сторно не учитывается'))}</div>
        <div class="flex flex-wrap items-center gap-3 mb-4">
            <div role="tablist" class="tabs tabs-boxed w-fit">${sections.map(([id, label]) =>
                `<a role="tab" class="tab ${id === anSection ? 'tab-active' : ''}" data-dacc-an="${id}">${e(label)}</a>`).join('')}</div>
            ${anSection !== 'summary' ? `<div class="join">${stepBtn('month', 'cost_step_month', 'Месяц')}${stepBtn('quarter', 'cost_step_quarter', 'Квартал')}${stepBtn('year', 'cost_step_year', 'Год')}</div>` : ''}
        </div>
        ${body}`;
    if (anSection === 'charts') drawCharts(d);
}

let anChart2 = null;
async function drawCharts(d) {
    let Chart;
    try { Chart = await loadChartLib(); } catch {
        $('daccChart')?.replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') }));
        return;
    }
    if (!$('daccChart')) return;
    if (anChart) anChart.destroy();
    if (anChart2) anChart2.destroy();
    const inr = v => money(v, 'INR');
    const labels = d.buckets.map(bucketLabel);
    const opts = stacked => ({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
            tooltip: { callbacks: { label: c => c.raw ? `${c.dataset.label}: ${inr(c.raw)}` : null } } },
        scales: { x: { stacked }, y: { stacked, beginAtZero: true, ticks: { callback: v => Number(v).toLocaleString('ru-RU') } } } });
    anChart = new Chart($('daccChart'), {
        type: 'bar',
        data: { labels, datasets: [
            { label: tr('dacc_an_revenue', 'Выручка'), data: d.revenue.totals, backgroundColor: '#3b82f6', order: 2 },
            { label: tr('dacc_an_costs', 'Расходы'), data: d.costs.totals, backgroundColor: '#ef4444', order: 2 },
            { type: 'line', label: tr('dacc_an_result', 'Итог'), data: d.result, borderColor: '#16a34a', backgroundColor: '#16a34a', borderWidth: 2, pointRadius: 3, order: 1 }
        ] },
        options: opts(false)
    });
    // расходы по статьям столбиками: крупные отдельно, остальные — «Прочее»
    const top = d.costs.groups.slice(0, CHART_TOP), rest = d.costs.groups.slice(CHART_TOP);
    const sets = top.map((g, i) => ({ label: g.src ? `${g.label} (${g.src})` : g.label, data: g.cells, backgroundColor: CHART_COLORS[i] }));
    if (rest.length) sets.push({ label: tr('dacc_an_other', 'Прочее'), backgroundColor: CHART_COLORS[CHART_TOP],
        data: d.buckets.map((_, i) => rest.reduce((x, g) => x + g.cells[i], 0)) });
    anChart2 = new Chart($('daccChart2'), { type: 'bar', data: { labels, datasets: sets }, options: opts(true) });
}

function setView(v) {
    const was = ledgerKind();
    view = v;
    document.querySelectorAll('[data-dacc-view]').forEach(t => t.classList.toggle('tab-active', t.dataset.daccView === v));
    $('daccOps').classList.toggle('hidden', v !== 'ops' && v !== 'box');
    $('daccAnalytics').classList.toggle('hidden', v !== 'analytics');
    $('daccRevenue').classList.toggle('hidden', v !== 'revenue');
    // выручка — все валюты сразу и свои итоги: вкладки валют и плашки ленты ей не нужны
    ['daccTabs', 'daccTotals', 'daccPeriodLine'].forEach(id => $(id).classList.toggle('hidden', v === 'revenue' || v === 'analytics'));
    try { localStorage.setItem('dept_account_view', v); } catch { /* нет хранилища */ }
    if (was !== ledgerKind()) setLedger(); else render();
}

function pickFromSummary(pick) {
    if (pick.range) { $('daccFrom').value = pick.range[0]; $('daccTo').value = pick.range[1]; markPreset('custom'); }
    if (pick.rev) {
        $('daccRevSearch').value = '';
        if (![...$('daccRevCat').options].some(o => o.value === pick.rev)) renderRevenue();
        $('daccRevCat').value = pick.rev;
        setView('revenue');
        return;
    }
    if (view !== 'ops' && view !== 'box') setView('ops');
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
    // в «Кассе ДДС» видно, на каком счёте лежала операция (касса или счёт департамента до 19.10)
    const acc = ledgerKind() === 'box' ? ` <span class="badge badge-outline badge-xs whitespace-nowrap">${e(r.account_name)}</span>` : '';
    return `${e(FinUtils.typeLabel(r.type))}${arrow}${acc}${badge}`;
}

function detailHtml(r) {
    const item = (label, val) => val ? `<div><span class="opacity-60">${e(label)}:</span> ${e(val)}</div>` : '';
    const canDds = window.hasPermission?.('fin_admin') || window.hasPermission?.('fin_observer');
    return `<div class="grid md:grid-cols-2 gap-x-6 gap-y-1 text-sm py-2">
        ${item(tr('fin_kind', 'Вид'), FinUtils.typeLabel(r.type))}
        ${item(tr('fin_account', 'Счёт'), r.account_name)}
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
            <td class="text-right font-mono whitespace-nowrap ${r.bal < 0 ? 'text-error' : ''}">${money(r.bal, r.currency_code)}</td>
        </tr>${open ? `<tr class="bg-base-200/40"><td></td><td colspan="6">${detailHtml(r)}</td></tr>` : ''}`;
    }).join('');
}

function render() {
    if (view === 'revenue') { renderRevenue(); return; }
    if (view === 'analytics') { renderAnalytics(); return; }
    const list = filtered();
    renderTotals(list);
    renderSummary();
    renderTable(list);
    $('daccCount').textContent = `${tr('fin_shown_count', 'Показано')}: ${list.length}`;
}

function exportCsv() {
    const list = filtered();
    const header = ['Дата', 'Вид', 'Другой счёт', 'Статья', 'Ретрит', 'От кого / кому', 'Комментарий', 'Сумма', 'Валюта', 'Остаток после'];
    const data = list.map(r => [r.occurred_on, FinUtils.typeLabel(r.type), r.contra_account || '', r.category_name || '', r.object_name || '',
        r.participant_name || r.contractor_name || '', r.comment || r.reason || '', r.signed_amount, r.currency_code, r.bal]);
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
    const [inc, an] = await Promise.all([loadIncome(),
        Layout.db.rpc('fin_department_analytics', { p_department: cfg.department })]);
    incomeRows = inc;
    anRows = an.error ? [] : (an.data || []);
    // вкладки видов: «Выручка» — если у департамента есть приходы по его статьям, «Касса ДДС» — если касса у него хранится
    const hasBox = accounts.some(a => a.purpose === 'cashbox');
    $('daccTabRevenue').classList.toggle('hidden', !incomeRows.length);
    $('daccTabBox').classList.toggle('hidden', !hasBox);
    $('daccRevCat').addEventListener('change', render);
    $('daccRevSearch').addEventListener('input', Layout.debounce(render, 300));
    $('daccRevSummary').addEventListener('click', ev => {
        const b = ev.target.closest('[data-dacc-rev-cat]');
        if (!b) return;
        $('daccRevCat').value = $('daccRevCat').value === b.dataset.daccRevCat ? '' : b.dataset.daccRevCat;
        render();
    });
    // вкладка валюты появляется вместе с первой операцией по счёту;
    // порядок у всех департаментов один: ₹ → ₽ → $ → € → остальные (ВГ 25.09)
    const curs = [...new Set(accounts.map(a => a.currency_code))]
        .sort((a, b) => curRank(a) - curRank(b) || a.localeCompare(b));
    if (!curs.length && !incomeRows.length) {
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
        const op = ev.target.closest('[data-dacc-an-open]');
        if (op) {
            const k = op.dataset.daccAnOpen;
            if (anOpen.has(k)) anOpen.delete(k); else anOpen.add(k);
            renderAnalytics();
            return;
        }
        if (ev.target.closest('[data-dacc-an-result]')) { anResultOpen = !anResultOpen; renderAnalytics(); return; }
        const tc = ev.target.closest('[data-dacc-an-cell]');
        if (tc) {
            const [k, raw] = tc.dataset.daccAnCell.split('|');
            const val = raw === 'all' ? 'all' : Number(raw);
            if (anTableOpen.get(k) === val) anTableOpen.delete(k); else anTableOpen.set(k, val);
            renderAnalytics();
            return;
        }
        const sec = ev.target.closest('[data-dacc-an]');
        if (sec) {
            anSection = sec.dataset.daccAn;
            try { localStorage.setItem('dept_account_an', anSection); } catch { /* нет хранилища */ }
            renderAnalytics();
            return;
        }
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
    let saved = 'ops';
    try {
        step = localStorage.getItem('dept_account_step') || 'month';
        anSection = localStorage.getItem('dept_account_an') || 'summary';
        saved = localStorage.getItem('dept_account_view') || 'ops';
    } catch { /* нет хранилища */ }
    if (!['month', 'quarter', 'year'].includes(step)) step = 'month';
    if (!['summary', 'table', 'charts'].includes(anSection)) anSection = 'summary';
    // сохранённая вкладка — только если она есть у этого департамента; без счетов — сразу выручка
    const available = v => v === 'ops' || v === 'analytics' || (v === 'revenue' && incomeRows.length) || (v === 'box' && hasBox);
    if (!curs.length) saved = 'revenue';
    else if (!available(saved)) saved = 'ops';
    if (saved !== 'ops') setView(saved);
    if (curs.length) await selectCurrency(curs[0]); else render();
}

return { init };
})();
