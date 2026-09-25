// ==================== СЧЁТ ДЕПАРТАМЕНТА ====================
// Движение денег по счетам департамента — только просмотр (решение ВГ 25.09.2026).
// Глава департамента видит свой счёт: приходы, расходы, переводы к другим счетам и от них;
// фильтры и сортировка как в ДДС, ничего менять нельзя. Данные — та же лента ДДС
// (fin_v_account_ledger), какие счета чьи — fin_department_accounts.
// Пилот — Кухня (kitchen/account.html); другой департамент — такая же страница со своим названием.
window.DeptAccount = (function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов не обновился — русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

let cfg = null;
let accounts = [];
let rows = [];            // все проводки выбранного счёта, по дате (внутри дня — приходы раньше), .bal — остаток после
const opened = new Set(); // раскрытые строки (posting_id)
let sort = { key: 'date', dir: 'desc' };

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
    return data || [];
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

async function selectAccount(id) {
    $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    // Остаток после операции — по дате операции (а не по порядку внесения): операцию, внесённую
    // задним числом, ставим на её дату, иначе в столбце «Остаток после» скачки (замечание ВГ 25.09)
    // в пределах одного дня сначала приходы, потом расходы — чтобы не было ложного минуса внутри дня
    const inFirst = r => Number(r.signed_amount) >= 0 ? 0 : 1;
    const [loaded, groups] = await Promise.all([loadRows(id), Layout.db.rpc('fin_account_op_groups', { p_account: id })]);
    const base = loaded.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || inFirst(a) - inFirst(b) || a.ledger_seq - b.ledger_seq);
    rows = pairUp(base, groups.data || []);
    let bal = 0;
    rows.forEach((r, i) => { bal += Number(r.signed_amount); r.bal = Math.round(bal * 100) / 100; r.ord = i; });
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
    const cur = rows[rows.length - 1]?.currency_code || accounts.find(a => a.account_id === $('daccAccount').value)?.currency_code || 'INR';
    const from = $('daccFrom').value, to = $('daccTo').value;
    const today = DateUtils.toISO(new Date());
    const now = rows.length ? rows[rows.length - 1].bal : 0;
    // остатки — по всем проводкам счёта, без учёта фильтров по статье и поиску
    const before = from ? rows.filter(r => r.occurred_on < from) : [];
    const upto = to ? rows.filter(r => r.occurred_on <= to) : rows;
    const opening = before.length ? before[before.length - 1].bal : 0;
    const closing = upto.length ? upto[upto.length - 1].bal : 0;
    // сторно и отменённая операция вместе дают ноль — в «Пришло/Ушло» их не показываем (как в ДДС)
    let inc = 0, out = 0, rev = 0;
    for (const r of list) {
        const v = Number(r.signed_amount);
        if (isStorno(r)) rev += Math.abs(v); else if (v >= 0) inc += v; else out -= v;
    }
    const filteredNote = $('daccCategory').value || $('daccSearch').value.trim() || $('daccDir').value
        ? ` <span class="text-xs font-normal opacity-60">${e(tr('dacc_by_filter', 'по фильтру'))}</span>` : '';
    $('daccTotals').innerHTML = [
        chip(tr('dacc_balance_now', 'Сейчас на счёте'), money(now, cur), now < 0 ? 'text-error' : ''),
        chip(tr('dacc_in', 'Пришло'), `<span class="text-blue-600">${money(inc, cur)}</span>${filteredNote}`),
        chip(tr('dacc_out', 'Ушло'), `<span class="text-red-600">${money(out, cur)}</span>${filteredNote}`)
    ].join('');
    // «было → стало» — только для прошлых периодов: если период доходит до сегодня, «стало» = «сейчас на счёте»
    const parts = [];
    if (from && to && to < today) parts.push(`${fmtDay(from)}: ${money(opening, cur)} → ${fmtDay(to)}: <b>${money(closing, cur)}</b>`);
    else if (from) parts.push(`${tr('dacc_opening', 'На начало')} ${fmtDay(from)}: ${money(opening, cur)}`);
    if (rev) parts.push(`<span title="${e(tr('dacc_storno_hint', 'Отменённые операции и их отмены — вместе дают ноль, в «Пришло» и «Ушло» не входят'))}" class="cursor-help">${e(tr('fin_totals_reversed', 'Сторнировано'))}: ${money(rev, cur)}</span>`);
    $('daccPeriodLine').innerHTML = parts.join(' · ');
}

function kindCell(r) {
    const arrow = r.contra_account
        ? ` <span class="opacity-70 whitespace-nowrap">${r.direction === 'out' ? '→' : '←'} ${e(r.contra_account)}</span>` : '';
    const badge = r.is_reversed ? ` <span class="badge badge-ghost badge-xs">${e(tr('fin_reversed_badge', 'сторнировано'))}</span>` : '';
    return `${e(FinUtils.typeLabel(r.type))}${arrow}${badge}`;
}

function detailHtml(r) {
    const item = (label, val) => val ? `<div><span class="opacity-60">${e(label)}:</span> ${e(val)}</div>` : '';
    const canDds = window.hasPermission?.('fin_admin') || window.hasPermission?.('fin_observer');
    return `<div class="grid md:grid-cols-2 gap-x-6 gap-y-1 text-sm py-2">
        ${item(tr('fin_kind', 'Вид'), FinUtils.typeLabel(r.type))}
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
    const list = filtered();
    renderTotals(list);
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
    if (!accounts.length) {
        $('daccBody').innerHTML = `<tr><td colspan="7" class="text-center py-6 opacity-60">${e(tr('dacc_no_accounts', 'У департамента пока нет счёта'))}</td></tr>`;
        return;
    }
    $('daccAccount').innerHTML = accounts.map(a => `<option value="${a.account_id}">${e(a.name)}${a.is_active ? '' : ' (закрыт)'}</option>`).join('');
    $('daccAccountWrap').classList.toggle('hidden', accounts.length < 2);
    $('daccAccountName').textContent = accounts.length === 1 ? accounts[0].name : '';

    $('daccAccount').addEventListener('change', ev => selectAccount(ev.target.value));
    ['daccDir', 'daccCategory'].forEach(id => $(id).addEventListener('change', render));
    // свои даты — сразу полями: ввели дату, подсветка пресета снимается
    ['daccFrom', 'daccTo'].forEach(id => $(id).addEventListener('change', () => { markPreset('custom'); render(); }));
    $('daccSearch').addEventListener('input', Layout.debounce(render, 300));
    document.querySelectorAll('[data-dacc-preset]').forEach(b => b.addEventListener('click', () => setPreset(b.dataset.daccPreset)));
    $('daccCsv').addEventListener('click', exportCsv);
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
    await selectAccount(accounts[0].account_id);
}

return { init };
})();
