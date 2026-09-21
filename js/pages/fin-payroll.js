// ==================== ФИНАНСЫ: ЗАРПЛАТНАЯ ВЕДОМОСТЬ ====================
// Одна ведомость на весь ашрам, сгруппированная по департаментам.
// Баланс = Σ начислений − Σ выплат — накопительно за всё время, поэтому
// недоплата, неровная сумма и аванс переходят на следующий месяц сами
// (см. 438_fin_payroll.sql).
//
// Строка ведомости = человек в департаменте. Под ней могут быть несколько
// позиций-периодов (Уша: Кухня до 19.08, потом снова Кухня с осени) — история
// и баланс складываются, поэтому переходы туда-сюда не плодят строк.
// «Начислено» и «Выплачено» показываются за выбранный период (год/месяц/всё
// время): итог за всё время через годы ни о чём не говорит, а долг виден в
// балансе, который от периода не зависит.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let positions = [];
let accruals = [];
let payments = [];
let groups = [];
const detailOpen = new Set();

// PostgREST отдаёт не больше 1000 строк за запрос — читаем страницами
async function fetchAll(view, orderCol) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await Layout.db.from(view).select('*').order(orderCol).range(from, from + 999);
        if (error) return { error };
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return { data: out };
}

function periodLabel(periodStr) {
    const d = DateUtils.parseDate(periodStr);
    const lang = DateUtils.getLang();
    return `${DateUtils.monthNamesShort[lang]?.[d.getMonth()] || DateUtils.monthNamesShort.ru[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------- выбранный период колонок ----------
function currentRange() {
    const mode = document.getElementById('payrollRange')?.value || 'year';
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    if (mode === 'month') return { mode, from: `${y}-${m}-01`, to: `${y}-${m}-31`, label: periodLabel(`${y}-${m}-01`) };
    if (mode === 'year') return { mode, from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
    return { mode, from: '0000-01-01', to: '9999-12-31', label: t('fin_payroll_range_all_short') };
}

const inRange = (dateStr, r) => {
    const d = (dateStr || '').slice(0, 10);
    return d >= r.from && d <= r.to;
};

// ---------- группировка позиций по человеку + департаменту ----------
function buildGroups() {
    const r = currentRange();
    const map = new Map();
    for (const p of positions) {
        const key = `${p.vaishnava_id}|${p.department_id}`;
        if (!map.has(key)) map.set(key, { key, positions: [] });
        map.get(key).positions.push(p);
    }

    for (const g of map.values()) {
        g.positions.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
        const latest = g.positions[g.positions.length - 1];
        const current = g.positions.find(p => p.is_current) || null;
        const shown = current || latest;
        const ids = new Set(g.positions.map(p => p.id));
        g.current = current;
        g.employee_name = shown.employee_name;
        g.department_id = shown.department_id;
        g.department_name = shown.department_name;
        g.position_title = shown.position_title;
        g.salary_amount = shown.salary_amount;
        g.currency_code = shown.currency_code;
        g.is_current = !!current;
        g.ended_on = current ? null : g.positions.map(p => p.effective_to).filter(Boolean).sort().pop();
        g.balance = g.positions.reduce((s, p) => s + Number(p.balance || 0), 0);
        g.total_accrued_all = g.positions.reduce((s, p) => s + Number(p.total_accrued || 0), 0);
        g.accruals = accruals.filter(a => ids.has(a.position_id));
        g.payments = payments.filter(p => ids.has(p.position_id));
        g.accrued = g.accruals.filter(a => inRange(a.period, r)).reduce((s, a) => s + Number(a.amount), 0);
        g.paid = g.payments.filter(p => !p.is_reversed && inRange(p.occurred_on, r)).reduce((s, p) => s + Number(p.amount), 0);
        // платёж кладём на действующую позицию, а если её нет (остался долг за
        // прошлый период) — на последнюю: баланс всё равно складывается по группе
        g.payPositionId = (current || latest).id;
    }
    return [...map.values()];
}

// Баланс имеет смысл, если есть оклад или хоть одно начисление (в т.ч. ручное):
// без них — только разовые выплаты, долга нет
function tracksBalance(g) {
    return g.salary_amount != null || g.total_accrued_all > 0;
}

function balanceBadge(g) {
    if (!tracksBalance(g)) return '';
    const bal = Math.round(g.balance * 100) / 100;
    if (bal > 0) return `<span class="badge badge-warning badge-sm">${t('fin_payroll_debt')}: ${FinUtils.fmtMoney(bal, g.currency_code)}</span>`;
    if (bal < 0) return `<span class="badge badge-info badge-sm">${t('fin_payroll_advance')}: ${FinUtils.fmtMoney(-bal, g.currency_code)}</span>`;
    return `<span class="badge badge-success badge-sm">${t('fin_payroll_settled')}</span>`;
}

const chevron = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3 inline transition-transform"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;

function rowHtml(g) {
    const hasSalary = g.salary_amount != null;
    const tracks = tracksBalance(g);
    const isOpen = detailOpen.has(g.key);
    return `<tr class="${g.is_current ? '' : 'opacity-60'}">
        <td>
            <button type="button" class="inline-flex items-center gap-1 hover:underline" data-toggle="${g.key}">
                <span class="${isOpen ? 'rotate-90' : ''}">${chevron}</span>${e(g.employee_name)}
            </button>
            ${!g.is_current ? ` <span class="badge badge-ghost badge-xs">${t('fin_payroll_ended_on')} ${DateUtils.formatShort(DateUtils.parseDate(g.ended_on))}</span>` : ''}
        </td>
        <td>${e(g.position_title)}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(g.salary_amount, g.currency_code) : `<span class="opacity-50">${t('fin_payroll_no_salary')}</span>`}</td>
        <td class="font-mono">${tracks ? FinUtils.fmtMoney(g.accrued, g.currency_code) : '—'}</td>
        <td class="font-mono">${FinUtils.fmtMoney(g.paid, g.currency_code)}</td>
        <td>${balanceBadge(g)}</td>
        <td class="text-right">
            <div class="flex flex-wrap justify-end gap-1">
                ${g.is_current ? `<button type="button" class="btn btn-outline btn-xs" data-accrue="${g.current.id}">${t('fin_payroll_accrue')}</button>` : ''}
                <button type="button" class="btn btn-primary btn-xs" data-pay="${g.payPositionId}">${t(tracks ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')}</button>
            </div>
        </td>
    </tr>
    <tr class="${isOpen ? '' : 'hidden'}">
        <td colspan="7" class="bg-base-200/50 py-2">
            <div class="text-xs">${isOpen ? detailBodyHtml(g) : ''}</div>
        </td>
    </tr>`;
}

// Разбивка «за какой период что начислено» и «когда что выплачено» — всё за
// всё время, независимо от выбранного периода колонок (замечание ВГ, 16.09.2026)
function detailBodyHtml(g) {
    const accr = [...g.accruals].sort((a, b) => a.period.localeCompare(b.period));
    const pays = [...g.payments].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    const accHtml = accr.length
        ? accr.map(a => `<div class="flex justify-between gap-4"><span>${periodLabel(a.period)}${a.is_manual ? ` (${t('fin_payroll_manual')})` : ''}${a.days_worked != null && a.days_worked < a.days_in_month ? ` (${a.days_worked}/${a.days_in_month} ${t('fin_payroll_days')})` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(a.amount, a.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_accruals')}</div>`;
    const payHtml = pays.length
        ? pays.map(p => `<div class="flex justify-between gap-4 ${p.is_reversed ? 'opacity-50 line-through' : ''}"><span>${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}${p.comment ? ` — ${e(p.comment)}` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(p.amount, p.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_payments')}</div>`;
    return `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div><div class="font-semibold mb-1">${t('fin_payroll_accrued')} — ${t('fin_payroll_range_all_short')}</div>${accHtml}</div>
        <div><div class="font-semibold mb-1">${t('fin_payroll_paid')} — ${t('fin_payroll_range_all_short')}</div>${payHtml}</div>
    </div>`;
}

// Завершённые периоды без долга в списке не нужны — иначе он зарастает
// историей; действующие видны всегда, даже когда всё выплачено
function visibleGroups() {
    const showEnded = document.getElementById('showEnded')?.checked;
    return groups.filter(g => g.is_current || showEnded || (tracksBalance(g) && Math.round(g.balance * 100) !== 0));
}

function render() {
    groups = buildGroups();
    const range = currentRange();
    const container = document.getElementById('payrollBody');
    const byDept = new Map();
    for (const g of visibleGroups()) {
        if (!byDept.has(g.department_id)) byDept.set(g.department_id, { name: g.department_name, rows: [] });
        byDept.get(g.department_id).rows.push(g);
    }
    if (!byDept.size) {
        container.innerHTML = `<div class="text-center py-10 opacity-60">${t('fin_payroll_no_employees')}</div>`;
        return;
    }
    const sub = txt => `<div class="text-[10px] font-normal normal-case opacity-60">${e(txt)}</div>`;
    container.innerHTML = [...byDept.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => `
            <div class="card bg-base-100 shadow-sm mb-4">
                <div class="card-body p-0">
                    <div class="px-4 py-3 font-semibold border-b border-base-200">${e(d.name)}</div>
                    <div class="overflow-x-auto">
                        <table class="table table-sm table-fixed w-full min-w-[820px]">
                            <colgroup>
                                <col class="w-[20%]"><col class="w-[16%]"><col class="w-[11%]">
                                <col class="w-[11%]"><col class="w-[11%]"><col class="w-[13%]"><col class="w-[18%]">
                            </colgroup>
                            <thead><tr>
                                <th>${t('fin_payroll_employee')}</th>
                                <th>${t('fin_payroll_position')}</th>
                                <th>${t('fin_payroll_salary')}</th>
                                <th>${t('fin_payroll_accrued')}${sub(range.label)}</th>
                                <th>${t('fin_payroll_paid')}${sub(range.label)}</th>
                                <th>${t('fin_payroll_balance')}${sub(t('fin_payroll_range_all_short'))}</th>
                                <th></th>
                            </tr></thead>
                            <tbody>${d.rows.map(rowHtml).join('')}</tbody>
                        </table>
                    </div>
                </div>
            </div>`).join('');
}

async function load() {
    const [pos, acc, pay] = await Promise.all([
        fetchAll('fin_v_payroll_positions', 'employee_name'),
        fetchAll('fin_v_payroll_accruals', 'period'),
        fetchAll('fin_v_payroll_payments', 'occurred_on')
    ]);
    const err = pos.error || acc.error || pay.error;
    if (err) { Layout.handleError(err, 'Зарплатная ведомость'); return; }
    positions = pos.data;
    accruals = acc.data;
    payments = pay.data;
    render();
}

function toggleDetail(key) {
    if (detailOpen.has(key)) detailOpen.delete(key); else detailOpen.add(key);
    render();
}

function groupByPosition(positionId) {
    return groups.find(x => x.positions.some(p => p.id === positionId));
}

function openPayModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('payPositionId').value = positionId;
    document.getElementById('payModalTitle').textContent = `${t(tracksBalance(g) ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')} — ${g.employee_name} (${g.department_name})`;
    // Подсказка суммы: есть долг — предлагаем его; нет долга, но оклад есть —
    // предлагаем сам оклад (обычно платят именно его); нет оклада — пусто,
    // сумму вводят руками. Подсказку всегда можно поправить — это и оставляет
    // неровный остаток на будущее, как задумано (замечание ВГ, 16.09.2026)
    const bal = Math.round(g.balance * 100) / 100;
    document.getElementById('payAmount').value = bal > 0 ? bal : (g.salary_amount ?? '');
    document.getElementById('payDate').value = FinUtils.todayISO();
    document.getElementById('payComment').value = '';
    document.getElementById('payModal').showModal();
}

// Ручное начисление за месяц — для тех, у кого сумму каждый месяц называет
// глава департамента. По умолчанию предлагаем прошлый месяц: за него и платят.
function openAccrueModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('accruePositionId').value = positionId;
    document.getElementById('accrueModalTitle').textContent = `${t('fin_payroll_accrue_title')} — ${g.employee_name} (${g.department_name})`;
    const prev = new Date();
    prev.setDate(1);
    prev.setMonth(prev.getMonth() - 1);
    document.getElementById('accruePeriod').value = DateUtils.toISO(prev).slice(0, 7);
    document.getElementById('accrueAmount').value = g.salary_amount ?? '';
    document.getElementById('accrueModal').showModal();
}

async function submitAccrue(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_set_payroll_accrual', {
        position_id: document.getElementById('accruePositionId').value,
        period: document.getElementById('accruePeriod').value + '-01',
        amount: document.getElementById('accrueAmount').value
    });
    if (FinUtils.handleResult(res, 'fin_payroll_accrual_done')) {
        document.getElementById('accrueModal').close();
        await load();
    }
}

async function submitPay(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_pay_payroll', {
        position_id: document.getElementById('payPositionId').value,
        amount: document.getElementById('payAmount').value,
        occurred_on: document.getElementById('payDate').value,
        comment: document.getElementById('payComment').value || null
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('payModal').close();
        await load();
    }
}

// Начисление по расписанию срабатывает 1-го числа; сотруднику, заведённому
// посреди месяца, до этой даты неоткуда взять начисление — кнопка запускает
// ту же серверную функцию вручную. Идемпотентно: уже начисленные месяцы
// просто пропускаются, повторный клик ничего не задвоит.
async function runAccrualNow(ev) {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="loading loading-spinner loading-xs"></span> ${old}`;
    try {
        const res = await FinUtils.rpc('fin_trigger_payroll_accrual');
        if (FinUtils.handleResult(res, 'fin_payroll_accrual_done')) await load();
    } finally {
        btn.disabled = false;
        btn.innerHTML = old;
    }
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_payroll', itemId: 'fin_payroll' });

    document.getElementById('payrollBody').addEventListener('click', ev => {
        const payBtn = ev.target.closest('[data-pay]');
        const toggleBtn = ev.target.closest('[data-toggle]');
        const accrueBtn = ev.target.closest('[data-accrue]');
        if (payBtn) openPayModal(payBtn.dataset.pay);
        else if (accrueBtn) openAccrueModal(accrueBtn.dataset.accrue);
        else if (toggleBtn) toggleDetail(toggleBtn.dataset.toggle);
    });
    document.getElementById('payForm').addEventListener('submit', FinUtils.lockedSubmit(submitPay));
    document.getElementById('accrueForm').addEventListener('submit', FinUtils.lockedSubmit(submitAccrue));
    document.getElementById('runAccrualBtn').addEventListener('click', runAccrualNow);
    document.getElementById('showEnded').addEventListener('change', render);
    document.getElementById('payrollRange').addEventListener('change', render);

    await load();
}

init();
})();
