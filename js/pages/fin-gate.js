// ==================== ФИНАНСЫ: ОПЛАТЫ С ПРОХОДНОЙ ====================
// Месячный лист от плательщика (734): стройка (или наша касса) заплатила людям
// и поставщикам за месяц и прислала список. Лист вставляется из Excel, каждая
// строка разносится: статья и чьё — департамент или «не наше» (для сверки).
// «Провести» = по каждому департаменту перевод с плательщика + расход строками,
// дата — последний день месяца. Оплата труда с именем ложится в ведомость наёмных.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let sheets = [];
let departments = [];
let sheet = null;       // текущий лист: {id, period, payer_account_id, sheet_total, section_totals, status}
let rows = [];          // строки текущего листа
let dirty = false;
let postRequestId = null;

const money = v => FinUtils.fmtMoney(v, 'INR');
const fmtNum = v => (v == null || v === '' ? '' : String(Number(v)).replace('.', ','));
const monthValue = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

function monthLabel(periodStr) {
    // месяц отдельно от года — именительный падеж («август», а не «августа»)
    const d = DateUtils.parseDate(periodStr);
    const name = d.toLocaleDateString(DateUtils.getLang(), { month: 'long' });
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getFullYear()}`;
}

function monthOptions(selected) {
    const now = new Date();
    const out = [];
    for (let i = 0; i < 24; i++) {
        const v = monthValue(new Date(now.getFullYear(), now.getMonth() - i, 1));
        out.push(`<option value="${v}" ${v === selected ? 'selected' : ''}>${monthLabel(v)}</option>`);
    }
    return out.join('');
}

const catByCode = code => FinUtils.refs.categories.find(c => c.code === code);
const payerAccount = () => FinUtils.refs.accounts.find(a => a.account_id === sheet?.payer_account_id);
const isPosted = () => sheet?.status === 'posted';

// ==================== РАЗБОР ВСТАВКИ ИЗ EXCEL ====================
// Лист стройки — несколько разделов подряд: заголовок раздела, строка шапки
// (S.NO / NAME / ATD / SALARY / ADVANCE / TOTAL), строки людей, строка TOTAL.
// В конце — сводка по разделам («AUG TOTAL PAYMENT») и общий TOTAL листа.
// Строки сводки, совпавшие с итогом раздела, отбрасываются; остальные (подряды,
// поставщики — они есть только в сводке) становятся строками листа.

// «10,500» — тысячи, «43,5» — дробь; «19'» (литры), «THEKA» — не число
function parseNum(s) {
    if (s == null) return null;
    let v = String(s).replace(/[\s ₹]/g, '');
    if (!v) return null;
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v)) v = v.replace(/,/g, '');
    else v = v.replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null;
}
// «1000/2600», «350/13H» — первое число
const firstNum = s => parseNum(String(s || '').split('/')[0]);

const RE_SNO = /^(S\.?\s*NO\.?|№|SR\.?\s*NO\.?)$/i;
const RE_NAME = /^(NAME|ИМЯ|ФИО)$/i;
const RE_DAYS = /^(ATD|ATT|ATTDANCE|ATTENDANCE|DAYS|ДНИ)$/i;
const RE_RATE = /SALARY|RATE|ОКЛАД|СТАВКА/i;
const RE_ADV = /^ADV|АВАНС/i;
const RE_TOTAL = /TOTAL|AMT|DUE|ИТОГ|К ВЫПЛАТЕ|СУММА/i;
const RE_CARRY = /^B\/|BAL|ДОЛГ/i;
const RE_TOTAL_LABEL = /^(TOTAL|ИТОГО)$/i;
const RE_FARE = /FARE|ПРОЕЗД|RICKSHAW|РИКША/i;

function detectCols(cells) {
    const find = (re, last) => {
        let idx = -1;
        cells.forEach((c, i) => { if (re.test(c) && (last || idx < 0)) idx = i; });
        return idx;
    };
    const sno = find(RE_SNO);
    let name = find(RE_NAME);
    if (name < 0) name = sno >= 0 ? sno + 1 : 0;
    const total = find(RE_TOTAL, true);
    const carry = cells.findIndex((c, i) => i !== total && RE_CARRY.test(c));
    return {
        name, total, carry,
        days: find(RE_DAYS),
        rate: find(RE_RATE),
        adv: find(RE_ADV),
        carryLabel: carry >= 0 ? cells[carry] : null
    };
}

function parsePaste(text) {
    const out = [];
    const sectionTotals = {};
    const summary = [];
    let sheetTotal = null;
    let section = null;
    let cols = null;
    let isSummary = false;

    for (const line of text.split(/\r?\n/)) {
        const cells = line.split('\t').map(c => c.trim());
        const filled = cells.map((c, i) => ({ c, i })).filter(x => x.c !== '' && !/^[.\\/-]$/.test(x.c));
        if (!filled.length) continue;
        const texts = filled.filter(x => parseNum(x.c) == null);
        const hasNum = filled.some(x => parseNum(x.c) != null);

        if (texts.some(x => RE_NAME.test(x.c) || RE_SNO.test(x.c)) && texts.length >= 3) {
            cols = detectCols(cells);
            continue;
        }
        const totalLabel = texts.find(x => RE_TOTAL_LABEL.test(x.c));
        if (totalLabel) {
            const after = filled.filter(x => x.i > totalLabel.i).map(x => parseNum(x.c)).filter(v => v != null);
            const v = after.length ? after[after.length - 1] : null;
            if (isSummary) sheetTotal = v;
            else if (section) sectionTotals[section] = v;
            continue;
        }
        if (!hasNum) {
            // строка без чисел — заголовок следующего раздела
            section = texts.map(x => x.c).join(' ').replace(/\s+/g, ' ').trim();
            isSummary = /TOTAL\s+PAYMENT|ИТОГ/i.test(section);
            cols = null;
            continue;
        }
        if (!cols || cols.total < 0) continue;
        const amount = parseNum(cells[cols.total]);
        if (amount == null) continue;   // «THEKA», «LOAN» без суммы к выплате — они в сводке

        let name = cells[cols.name] || '';
        if (!name || parseNum(name) != null) {
            const other = texts.find(x => x.i !== cols.total && !RE_TOTAL_LABEL.test(x.c));
            name = other ? other.c : (section || '—');
        }
        if (isSummary) { summary.push({ name, amount }); continue; }

        const rateCell = cols.rate >= 0 ? cells[cols.rate] : '';
        const hm = /^\s*([\d.,]+)\s*\/\s*([\d.,]+)\s*H\s*$/i.exec(rateCell || '');
        const carry = cols.carry >= 0 ? parseNum(cells[cols.carry]) : null;
        out.push({
            section,
            name,
            days: cols.days >= 0 ? parseNum(cells[cols.days]) : null,
            hours: hm ? parseNum(hm[2]) : null,
            rate: hm ? parseNum(hm[1]) : parseNum(rateCell),
            advance: cols.adv >= 0 ? firstNum(cells[cols.adv]) : null,
            amount,
            note: carry ? `${cols.carryLabel}: ${carry}` : null
        });
    }

    // сводка: строка, равная итогу раздела, уже расписана поимённо — отбрасываем
    const sectionSums = {};
    for (const r of out) sectionSums[r.section] = (sectionSums[r.section] || 0) + r.amount;
    const free = new Set(Object.keys(sectionSums));
    let matched = 0;
    for (const s of summary) {
        const hit = [...free].find(sec => Math.abs((sectionTotals[sec] ?? sectionSums[sec]) - s.amount) < 0.5);
        if (hit) { free.delete(hit); matched++; continue; }
        out.push({ section: summaryTitle(), name: s.name, days: null, hours: null, rate: null, advance: null, amount: s.amount, note: null });
    }
    return { rows: out, sectionTotals, sheetTotal, matched, summaryCount: summary.length };
}
const summaryTitle = () => 'Только в сводке листа';

function applyParse() {
    const text = document.getElementById('pasteArea').value;
    if (!text.trim()) return;
    const res = parsePaste(text);
    if (!res.rows.length) { Layout.showNotification('В таблице не нашлось строк с суммой к выплате', 'warning'); return; }
    if (rows.length && !confirm(`Заменить ${rows.length} строк листа новыми (${res.rows.length})? Разноска совпавших строк сохранится.`)) return;

    // разноска переживает повторную вставку: раздел + имя
    const prev = new Map(rows.map(r => [`${r.section}|${r.name}`, r]));
    const labor = catByCode('dept_labor')?.id || null;
    const transport = catByCode('dept_transport')?.id || null;
    rows = res.rows.map(r => {
        const p = prev.get(`${r.section}|${r.name}`);
        return {
            ...r,
            category_id: p ? p.category_id : (RE_FARE.test(r.name) ? transport : labor),
            alloc: p ? p.alloc : null,
            department_id: p ? p.department_id : null
        };
    });
    sheet.section_totals = res.sectionTotals;
    if (res.sheetTotal != null) document.getElementById('sheetTotal').value = res.sheetTotal;
    document.getElementById('pasteArea').value = '';
    dirty = true;
    Layout.showNotification(`Строк: ${res.rows.length}` + (res.summaryCount ? ` · из сводки совпали с разделами ${res.matched} из ${res.summaryCount}` : ''), 'success');
    render();
}

// ==================== ЗАГРУЗКА ====================
async function loadSheets() {
    const { data, error } = await Layout.db.from('fin_v_gate_sheets').select('*').order('period', { ascending: false });
    if (error) { Layout.handleError(error, t('nav_fin_gate')); return; }
    sheets = data || [];
}

async function openSheet(id) {
    const s = sheets.find(x => x.id === id);
    if (!s) return;
    const { data, error } = await Layout.db.from('fin_v_gate_rows').select('*').eq('sheet_id', id).order('position');
    if (error) { Layout.handleError(error, t('nav_fin_gate')); return; }
    sheet = { ...s, section_totals: s.section_totals || {} };
    rows = data || [];
    dirty = false;
    postRequestId = null;
    fillHeader();
    render();
}

function newSheet() {
    if (dirty && !confirm('Несохранённые изменения пропадут. Продолжить?')) return;
    const now = new Date();
    const stroika = FinUtils.refs.accounts.find(a => a.is_active && a.currency_code === 'INR' && /^Стройка/.test(a.name));
    sheet = {
        id: null, status: 'draft', sheet_total: null, section_totals: {},
        period: monthValue(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        payer_account_id: stroika?.account_id || null
    };
    rows = [];
    dirty = false;
    postRequestId = null;
    fillHeader();
    render();
}

function fillPicker() {
    const sel = document.getElementById('sheetPicker');
    sel.innerHTML = (sheet && !sheet.id ? `<option value="" selected>${t('fin_gate_new_sheet')}</option>` : '') +
        sheets.map(s => `<option value="${s.id}" ${s.id === sheet?.id ? 'selected' : ''}>${monthLabel(s.period)} — ${e(s.payer_account_name)} · ${t(s.status === 'posted' ? 'fin_gate_status_posted' : 'fin_gate_status_draft')}</option>`).join('');
    sel.classList.toggle('hidden', !sel.options.length);
}

function fillHeader() {
    document.getElementById('sheetMonth').innerHTML = monthOptions(sheet.period);
    document.getElementById('sheetPayer').innerHTML = FinUtils.accountOptions(sheet.payer_account_id, a => a.currency_code === 'INR');
    if (!sheet.payer_account_id) sheet.payer_account_id = document.getElementById('sheetPayer').value || null;
    document.getElementById('sheetTotal').value = sheet.sheet_total ?? '';
    const posted = isPosted();
    ['sheetMonth', 'sheetPayer', 'sheetTotal'].forEach(id => { document.getElementById(id).disabled = posted; });
    document.getElementById('pasteBlock').classList.toggle('hidden', posted);
    ['deleteBtn', 'saveBtn', 'postBtn'].forEach(id => document.getElementById(id).classList.toggle('hidden', posted));
    document.getElementById('deleteBtn').classList.toggle('hidden', posted || !sheet.id);
    const st = document.getElementById('sheetStatus');
    st.className = `badge ${posted ? 'badge-success' : 'badge-ghost'}`;
    st.textContent = t(posted ? 'fin_gate_status_posted' : 'fin_gate_status_draft');
    document.getElementById('sheetEditor').classList.remove('hidden');
    document.getElementById('emptyState').classList.add('hidden');
    fillPicker();
}

// ==================== ОТРИСОВКА ====================
function sections() {
    const map = new Map();
    rows.forEach((r, i) => {
        const key = r.section || '—';
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(i);
    });
    return map;
}

function whoseValue(r) {
    if (r.alloc === 'dept' && r.department_id) return `dept:${r.department_id}`;
    if (r.alloc === 'not_ours') return 'not_ours';
    return '';
}

function whoseOptions(value, mixed) {
    return (mixed ? `<option value="__mixed" selected disabled>— разное —</option>` : '') +
        `<option value="" ${!mixed && !value ? 'selected' : ''}>${t('fin_gate_unallocated')}</option>` +
        departments.map(d => `<option value="dept:${d.id}" ${!mixed && value === `dept:${d.id}` ? 'selected' : ''}>${e(d.name)}</option>`).join('') +
        `<option value="not_ours" ${!mixed && value === 'not_ours' ? 'selected' : ''}>${t('fin_gate_not_ours')}</option>`;
}

function categoryOptions(value, mixed) {
    return (mixed ? `<option value="__mixed" selected disabled>— разное —</option>` : '') +
        FinUtils.refs.categories
            .filter(c => c.is_active && c.direction === 'out')
            .map(c => `<option value="${c.id}" ${!mixed && c.id === value ? 'selected' : ''}>${e(c.name)}</option>`).join('');
}

function render() {
    const posted = isPosted();
    const dis = posted ? 'disabled' : '';
    const secMap = sections();
    document.getElementById('sheetSections').innerHTML = [...secMap.entries()].map(([sec, idxs], si) => {
        const list = idxs.map(i => rows[i]);
        const sum = list.reduce((s, r) => s + Number(r.amount || 0), 0);
        const declared = sheet.section_totals?.[sec];
        const off = declared != null && Math.abs(declared - sum) >= 0.5;
        const whoseVals = new Set(list.map(whoseValue));
        const catVals = new Set(list.map(r => r.category_id || ''));
        const hasHours = list.some(r => r.hours != null);
        const body = idxs.map(i => {
            const r = rows[i];
            const unalloc = !whoseValue(r);
            return `<tr data-row="${i}" class="${unalloc ? 'bg-warning/20' : r.alloc === 'not_ours' ? 'opacity-60' : ''}">
                <td>${e(r.name)}${r.note ? `<div class="text-xs opacity-60">${e(r.note)}</div>` : ''}</td>
                <td class="font-mono text-right">${fmtNum(r.days)}</td>
                ${hasHours ? `<td class="font-mono text-right">${fmtNum(r.hours)}</td>` : ''}
                <td class="font-mono text-right">${r.rate != null ? money(r.rate) : ''}</td>
                <td class="font-mono text-right">${Number(r.advance) ? money(r.advance) : ''}</td>
                <td class="font-mono text-right font-semibold ${Number(r.amount) < 0 ? 'text-error' : ''}">${money(r.amount)}</td>
                <td><select class="select select-bordered select-xs w-full" data-f="category" data-i="${i}" ${dis}>${categoryOptions(r.category_id)}</select></td>
                <td><select class="select select-bordered select-xs w-full" data-f="whose" data-i="${i}" ${dis}>${whoseOptions(whoseValue(r))}</select></td>
            </tr>`;
        }).join('');
        return `<div class="card bg-base-100 shadow-sm mb-4" id="sec-${si}">
            <div class="card-body p-0">
                <div class="px-4 py-3 border-b border-base-200 flex flex-wrap items-center gap-2">
                    <span class="font-semibold">${e(sec)}</span>
                    <span class="text-xs opacity-60">${list.length}</span>
                    <span class="font-mono ml-2">${money(sum)}</span>
                    ${off ? `<span class="badge badge-warning badge-sm">⚠ в листе ${money(declared)}</span>` : ''}
                    <div class="ml-auto flex flex-wrap gap-2 items-center">
                        <span class="text-xs opacity-60">${t('fin_gate_all_section')}:</span>
                        <select class="select select-bordered select-xs" data-sec="${si}" data-f="category" ${dis}>${categoryOptions([...catVals][0], catVals.size > 1)}</select>
                        <select class="select select-bordered select-xs" data-sec="${si}" data-f="whose" ${dis}>${whoseOptions([...whoseVals][0], whoseVals.size > 1)}</select>
                    </div>
                </div>
                <div class="overflow-x-auto">
                    <table class="table table-sm w-full min-w-[860px]">
                        <thead><tr>
                            <th>${t('fin_hired_name')}</th>
                            <th class="text-right w-16">${t('fin_hired_days')}</th>
                            ${hasHours ? `<th class="text-right w-16">${t('fin_hired_hours')}</th>` : ''}
                            <th class="text-right w-24">${t('fin_hired_rate')}</th>
                            <th class="text-right w-24">${t('fin_hired_advance')}</th>
                            <th class="text-right w-28">${t('fin_hired_to_pay')}</th>
                            <th class="w-48">${t('fin_gate_what')}</th>
                            <th class="w-44">${t('fin_gate_whose')}</th>
                        </tr></thead>
                        <tbody>${body}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
    }).join('');
    renderWarn(secMap);
    renderSummary();
}

function totals() {
    const sum = list => list.reduce((s, r) => s + Number(r.amount || 0), 0);
    const ours = rows.filter(r => r.alloc === 'dept' && r.department_id);
    const byDept = new Map();
    for (const r of ours) {
        const name = departments.find(d => d.id === r.department_id)?.name || r.department_name || '—';
        if (!byDept.has(name)) byDept.set(name, []);
        byDept.get(name).push(r);
    }
    return {
        all: sum(rows),
        ours: sum(ours),
        notOurs: sum(rows.filter(r => r.alloc === 'not_ours')),
        unalloc: rows.filter(r => !whoseValue(r)),
        byDept: [...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([name, list]) => ({ name, list, total: sum(list) }))
    };
}

// О каждом пропуске — предупреждение сверху: сколько, список, клик ведёт к строке
function renderWarn(secMap) {
    const out = [];
    const tt = totals();
    if (tt.unalloc.length) {
        out.push(`<div class="alert alert-warning py-2 text-sm block">⚠ ${t('fin_gate_unallocated')}: ${tt.unalloc.length} — ${money(tt.unalloc.reduce((s, r) => s + Number(r.amount || 0), 0))}<div class="mt-1 flex flex-wrap gap-1">${
            tt.unalloc.map(r => `<button type="button" class="badge badge-outline badge-sm cursor-pointer" data-goto="${rows.indexOf(r)}">${e(r.name)}</button>`).join('')}</div></div>`);
    }
    const sheetTotal = parseNum(document.getElementById('sheetTotal').value);
    if (sheetTotal != null && rows.length && Math.abs(sheetTotal - tt.all) >= 0.5) {
        out.push(`<div class="alert alert-warning py-2 text-sm">⚠ ${t('fin_gate_rows_sum')} ${money(tt.all)}, ${t('fin_gate_sheet_total').toLowerCase()} ${money(sheetTotal)} — разница ${money(tt.all - sheetTotal)}</div>`);
    }
    const bad = [];
    [...secMap.entries()].forEach(([sec, idxs], si) => {
        const declared = sheet.section_totals?.[sec];
        const sum = idxs.reduce((s, i) => s + Number(rows[i].amount || 0), 0);
        if (declared != null && Math.abs(declared - sum) >= 0.5) {
            bad.push(`<button type="button" class="link" data-goto-sec="${si}">${e(sec)}</button>: строки ${money(sum)}, в листе ${money(declared)}`);
        }
    });
    if (bad.length) out.push(`<div class="alert alert-warning py-2 text-sm block">⚠ Разделы не сходятся со своим итогом: ${bad.length}<ul class="list-disc ml-5">${bad.map(b => `<li>${b}</li>`).join('')}</ul></div>`);
    const negOurs = rows.filter(r => r.alloc === 'dept' && Number(r.amount) < 0);
    if (negOurs.length) out.push(`<div class="alert alert-error py-2 text-sm">⚠ Наше с минусом — так не провести: ${negOurs.map(r => e(r.name)).join(', ')}</div>`);
    if (dirty) out.push(`<div class="alert py-2 text-sm">Есть несохранённые изменения</div>`);
    document.getElementById('sheetWarn').innerHTML = out.join('');
}

function renderSummary() {
    const el = document.getElementById('sheetSummary');
    if (!rows.length) { el.innerHTML = ''; return; }
    const tt = totals();
    const acc = payerAccount();
    let balanceHtml = '';
    if (acc) {
        const bal = Number(acc.balance);
        const before = isPosted() ? null : bal;
        const after = isPosted() ? bal : bal - tt.ours;
        balanceHtml = `<div class="flex justify-between gap-4"><span>${e(acc.name)}: ${isPosted() ? 'остаток сейчас' : `${t('fin_gate_debt_before').toLowerCase()} → ${t('fin_gate_debt_after').toLowerCase()}`}</span>
            <span class="font-mono">${before != null ? `${money(before)} → ` : ''}<b class="${after < 0 ? 'text-error' : ''}">${money(after)}</b></span></div>
            ${after < 0 ? `<div class="text-xs text-error text-right">минус — мы должны плательщику</div>` : ''}`;
    }
    el.innerHTML = `<div class="card bg-base-100 shadow-sm"><div class="card-body p-4 text-sm space-y-1">
        <div class="font-semibold mb-1">${t('fin_gate_by_dept')}</div>
        ${tt.byDept.map(d => `<div class="flex justify-between gap-4 pl-2"><span>${e(d.name)} <span class="opacity-60">· ${d.list.length}</span></span><span class="font-mono">${money(d.total)}</span></div>`).join('') || '<div class="opacity-60 pl-2">—</div>'}
        <div class="divider my-1"></div>
        <div class="flex justify-between gap-4 font-semibold"><span>${t('fin_gate_ours')}</span><span class="font-mono">${money(tt.ours)}</span></div>
        <div class="flex justify-between gap-4"><span>${t('fin_gate_not_ours')}</span><span class="font-mono">${money(tt.notOurs)}</span></div>
        ${tt.unalloc.length ? `<div class="flex justify-between gap-4 text-warning"><span>${t('fin_gate_unallocated')}</span><span class="font-mono">${money(tt.unalloc.reduce((s, r) => s + Number(r.amount || 0), 0))}</span></div>` : ''}
        <div class="flex justify-between gap-4 opacity-70"><span>${t('fin_gate_rows_sum')}</span><span class="font-mono">${money(tt.all)}</span></div>
        <div class="divider my-1"></div>
        ${balanceHtml}
    </div></div>`;
}

// ==================== ПРАВКИ ====================
function setWhose(r, value) {
    if (value.startsWith('dept:')) { r.alloc = 'dept'; r.department_id = value.slice(5); }
    else if (value === 'not_ours') { r.alloc = 'not_ours'; r.department_id = null; }
    else { r.alloc = null; r.department_id = null; }
}

function onChange(ev) {
    const sel = ev.target.closest('select[data-f]');
    if (!sel || sel.value === '__mixed') return;
    const apply = r => {
        if (sel.dataset.f === 'whose') setWhose(r, sel.value);
        else r.category_id = sel.value || null;
    };
    if (sel.dataset.sec != null) {
        const idxs = [...sections().values()][Number(sel.dataset.sec)];
        idxs.forEach(i => apply(rows[i]));
    } else {
        apply(rows[Number(sel.dataset.i)]);
    }
    dirty = true;
    render();
}

function onClick(ev) {
    const go = ev.target.closest('[data-goto]');
    const goSec = ev.target.closest('[data-goto-sec]');
    const target = go ? document.querySelector(`tr[data-row="${go.dataset.goto}"]`)
                 : goSec ? document.getElementById(`sec-${goSec.dataset.gotoSec}`) : null;
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.querySelector('select[data-f="whose"]')?.focus();
}

// ==================== СОХРАНИТЬ / ПРОВЕСТИ / УДАЛИТЬ ====================
async function save(silent) {
    sheet.period = document.getElementById('sheetMonth').value;
    sheet.payer_account_id = document.getElementById('sheetPayer').value;
    const res = await FinUtils.rpc('fin_gate_sheet_save', {
        id: sheet.id,
        period: sheet.period,
        payer_account_id: sheet.payer_account_id,
        sheet_total: document.getElementById('sheetTotal').value || null,
        note: null,
        section_totals: sheet.section_totals || null,
        rows: rows.map(r => ({
            section: r.section, name: r.name, days: r.days, hours: r.hours, rate: r.rate,
            advance: r.advance, amount: r.amount, category_id: r.category_id,
            alloc: r.alloc, department_id: r.department_id, note: r.note
        }))
    });
    if (!res?.ok || !silent) { if (!FinUtils.handleResult(res)) return false; }
    await loadSheets();
    await openSheet(res.result.id);
    return true;
}

async function post() {
    const tt = totals();
    if (tt.unalloc.length) { Layout.showNotification(`${t('fin_gate_unallocated')}: ${tt.unalloc.length}`, 'warning'); return; }
    if (!tt.byDept.length) { Layout.showNotification('Нечего проводить: нет строк «наше»', 'warning'); return; }
    const acc = payerAccount();
    const msg = `Провести лист за ${monthLabel(document.getElementById('sheetMonth').value)}?\n\n` +
        tt.byDept.map(d => `${d.name}: ${money(d.total)}`).join('\n') +
        `\n\nИтого наше: ${money(tt.ours)} — с «${acc?.name || ''}», дата — последний день месяца.`;
    if (!confirm(msg)) return;
    if (dirty || !sheet.id) { if (!await save(true)) return; }
    postRequestId = postRequestId || FinUtils.newRequestId();
    const res = await FinUtils.rpc('fin_gate_sheet_post', { sheet_id: sheet.id, request_id: postRequestId });
    if (FinUtils.handleResult(res, 'fin_gate_posted')) {
        await FinUtils.reloadAccounts();
        await loadSheets();
        await openSheet(sheet.id);
    }
}

async function removeDraft() {
    if (!sheet.id || !confirm('Удалить черновик листа? Проводок у него нет.')) return;
    const res = await FinUtils.rpc('fin_gate_sheet_delete', { id: sheet.id });
    if (FinUtils.handleResult(res)) {
        await loadSheets();
        sheet = null; rows = []; dirty = false;
        if (sheets.length) await openSheet(sheets[0].id); else showEmpty();
    }
}

function showEmpty() {
    document.getElementById('sheetEditor').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    fillPicker();
}

// ==================== РАСПЕЧАТКА ДЛЯ ДИНЫ ХАРИДАСА ====================
function printSheet() {
    const tt = totals();
    const acc = payerAccount();
    const period = document.getElementById('sheetMonth').value;
    const sheetTotal = parseNum(document.getElementById('sheetTotal').value);
    const row = r => `<tr><td>${e(r.name)}</td><td class="n">${fmtNum(r.days)}</td><td class="n">${fmtNum(r.hours)}</td>
        <td class="n">${Number(r.advance) ? money(r.advance) : ''}</td><td class="n">${money(r.amount)}</td>
        <td>${e(FinUtils.refs.categories.find(c => c.id === r.category_id)?.name || '')}</td></tr>`;
    const deptBlocks = tt.byDept.map(d => `<h3>${e(d.name)} — ${money(d.total)}</h3>
        <table><thead><tr><th>Имя</th><th class="n">Дни</th><th class="n">Часы</th><th class="n">Аванс</th><th class="n">К выплате</th><th>Статья</th></tr></thead>
        <tbody>${d.list.map(row).join('')}</tbody></table>`).join('');
    const notOursBySec = new Map();
    for (const r of rows.filter(x => x.alloc === 'not_ours')) {
        const k = r.section || '—';
        const cur = notOursBySec.get(k) || { n: 0, sum: 0 };
        cur.n++; cur.sum += Number(r.amount || 0);
        notOursBySec.set(k, cur);
    }
    const bal = acc ? Number(acc.balance) : null;
    const before = acc && !isPosted() ? bal : (acc ? bal + tt.ours : null);
    const after = acc ? before - tt.ours : null;
    const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>Оплаты с проходной — ${monthLabel(period)}</title>
        <style>@page{size:A4;margin:12mm}body{font-family:'Noto Sans',Arial,sans-serif;font-size:11px;color:#000;margin:0}
        h1{font-size:16px;margin:0 0 4px}h2{font-size:13px;margin:14px 0 4px}h3{font-size:12px;margin:10px 0 3px}
        table{width:100%;border-collapse:collapse;margin-bottom:4px}th,td{border:1px solid #9ca3af;padding:2px 5px;text-align:left}
        th{font-weight:700}.n{text-align:right;white-space:nowrap}.tot td{font-weight:700}</style></head><body>
        <h1>Оплаты с проходной — ${e(acc?.name || '')} — ${monthLabel(period)}</h1>
        <div>Проводка: ${DateUtils.formatShort(DateUtils.parseDate(DateUtils.toISO(new Date(DateUtils.parseDate(period).getFullYear(), DateUtils.parseDate(period).getMonth() + 1, 0))))} · ${t(isPosted() ? 'fin_gate_status_posted' : 'fin_gate_status_draft')}</div>
        <h2>Наше — по департаментам</h2>${deptBlocks || '<div>—</div>'}
        <h2>Не наше — по разделам листа</h2>
        <table><thead><tr><th>Раздел</th><th class="n">Строк</th><th class="n">Сумма</th></tr></thead><tbody>
        ${[...notOursBySec.entries()].map(([k, v]) => `<tr><td>${e(k)}</td><td class="n">${v.n}</td><td class="n">${money(v.sum)}</td></tr>`).join('')}
        </tbody></table>
        <h2>Итог</h2>
        <table><tbody>
        ${tt.byDept.map(d => `<tr><td>${e(d.name)}</td><td class="n">${money(d.total)}</td></tr>`).join('')}
        <tr class="tot"><td>Наше</td><td class="n">${money(tt.ours)}</td></tr>
        <tr><td>Не наше</td><td class="n">${money(tt.notOurs)}</td></tr>
        ${tt.unalloc.length ? `<tr><td>Не разнесено</td><td class="n">${money(tt.unalloc.reduce((s, r) => s + Number(r.amount || 0), 0))}</td></tr>` : ''}
        <tr><td>Сумма строк листа</td><td class="n">${money(tt.all)}</td></tr>
        ${sheetTotal != null ? `<tr><td>Итог, написанный в листе</td><td class="n">${money(sheetTotal)}</td></tr>` : ''}
        ${acc ? `<tr><td>Долг «${e(acc.name)}» до зачёта</td><td class="n">${money(before)}</td></tr>
        <tr class="tot"><td>Долг после зачёта${after < 0 ? ' (минус — мы должны)' : ''}</td><td class="n">${money(after)}</td></tr>` : ''}
        </tbody></table></body></html>`;
    const w = window.open('', '_blank');
    if (!w) { Layout.showNotification('Браузер не дал открыть окно печати', 'warning'); return; }
    w.document.write(html);
    w.document.close();
    (w.document.fonts?.ready || Promise.resolve()).then(() => { w.focus(); w.print(); });
}

// ==================== СТАРТ ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_gate', itemId: 'fin_gate' });

    const [d] = await Promise.all([
        Layout.db.from('fin_v_departments').select('id, name').order('name'),
        FinUtils.loadRefs(),
        loadSheets()
    ]);
    if (d.error) { Layout.handleError(d.error, t('nav_fin_gate')); return; }
    departments = d.data || [];

    document.getElementById('sheetPicker').addEventListener('change', ev => {
        if (!ev.target.value) return;
        if (dirty && !confirm('Несохранённые изменения пропадут. Продолжить?')) { fillPicker(); return; }
        openSheet(ev.target.value);
    });
    document.getElementById('newSheetBtn').addEventListener('click', newSheet);
    document.getElementById('parseBtn').addEventListener('click', applyParse);
    document.getElementById('sheetSections').addEventListener('change', onChange);
    document.getElementById('sheetWarn').addEventListener('click', onClick);
    document.getElementById('sheetPayer').addEventListener('change', ev => { sheet.payer_account_id = ev.target.value; dirty = true; render(); });
    document.getElementById('sheetMonth').addEventListener('change', () => { dirty = true; render(); });
    document.getElementById('sheetTotal').addEventListener('input', () => { dirty = true; renderWarn(sections()); });
    const locked = fn => async ev => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        try { await fn(); } finally { btn.disabled = false; }
    };
    document.getElementById('saveBtn').addEventListener('click', locked(() => save(false)));
    document.getElementById('postBtn').addEventListener('click', locked(post));
    document.getElementById('deleteBtn').addEventListener('click', locked(removeDraft));
    document.getElementById('printBtn').addEventListener('click', printSheet);
    window.addEventListener('beforeunload', ev => { if (dirty) { ev.preventDefault(); ev.returnValue = ''; } });

    if (sheets.length) await openSheet(sheets[0].id);
    else showEmpty();
}

init();
})();
