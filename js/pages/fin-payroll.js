// ==================== ФИНАНСЫ: ЗАРПЛАТНАЯ ВЕДОМОСТЬ ====================
// Одна ведомость на весь ашрам, сгруппированная по департаментам.
// Баланс = Σ начислений − Σ выплат по позиции — накопительно, поэтому
// недоплата, неровная сумма и аванс переходят на следующий месяц сами,
// без отдельного действия «перенести» (см. 438_fin_payroll.sql).
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let positions = [];
const detailCache = {};   // { position_id: { accruals: [...], payments: [...] } }
const detailOpen = new Set();

function periodLabel(periodStr) {
    const d = DateUtils.parseDate(periodStr);
    const lang = DateUtils.getLang();
    return `${DateUtils.monthNamesShort[lang]?.[d.getMonth()] || DateUtils.monthNamesShort.ru[d.getMonth()]} ${d.getFullYear()}`;
}

function balanceBadge(p) {
    if (p.salary_amount == null) return '';
    const bal = Number(p.balance) || 0;
    if (bal > 0) return `<span class="badge badge-warning badge-sm">${t('fin_payroll_debt')}: ${FinUtils.fmtMoney(bal, p.currency_code)}</span>`;
    if (bal < 0) return `<span class="badge badge-info badge-sm">${t('fin_payroll_advance')}: ${FinUtils.fmtMoney(-bal, p.currency_code)}</span>`;
    return `<span class="badge badge-success badge-sm">${t('fin_payroll_settled')}</span>`;
}

const chevron = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3 inline transition-transform"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;

function rowHtml(p) {
    const hasSalary = p.salary_amount != null;
    const isOpen = detailOpen.has(p.id);
    return `<tr class="${p.is_current ? '' : 'opacity-60'}">
        <td>
            <button type="button" class="inline-flex items-center gap-1 hover:underline" data-toggle="${p.id}">
                <span class="${isOpen ? 'rotate-90' : ''}">${chevron}</span>${e(p.employee_name)}
            </button>
            ${!p.is_current ? ` <span class="badge badge-ghost badge-xs">${t('fin_payroll_former')}</span>` : ''}
        </td>
        <td>${e(p.position_title)}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(p.salary_amount, p.currency_code) : `<span class="opacity-50">${t('fin_payroll_no_salary')}</span>`}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(p.total_accrued, p.currency_code) : '—'}</td>
        <td class="font-mono">${FinUtils.fmtMoney(p.total_paid, p.currency_code)}</td>
        <td>${balanceBadge(p)}</td>
        <td class="text-right">
            <button type="button" class="btn btn-primary btn-xs" data-pay="${p.id}">${t(hasSalary ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')}</button>
        </td>
    </tr>
    <tr id="detail-${p.id}" class="${isOpen ? '' : 'hidden'}">
        <td colspan="7" class="bg-base-200/50 py-2">
            <div id="detail-body-${p.id}" class="text-xs">${detailBodyHtml(p.id)}</div>
        </td>
    </tr>`;
}

// Разбивка «за какой период что начислено» и «когда что выплачено» —
// без этого баланс выглядит как непонятная общая цифра (замечание ВГ, 16.09.2026)
function detailBodyHtml(id) {
    const d = detailCache[id];
    if (!d) return `<span class="loading loading-spinner loading-xs"></span>`;
    const accruals = d.accruals.length
        ? d.accruals.map(a => `<div class="flex justify-between gap-4"><span>${periodLabel(a.period)}${a.days_worked < a.days_in_month ? ` (${a.days_worked}/${a.days_in_month} ${t('fin_payroll_days')})` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(a.amount, a.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_accruals')}</div>`;
    const payments = d.payments.length
        ? d.payments.map(p => `<div class="flex justify-between gap-4 ${p.is_reversed ? 'opacity-50 line-through' : ''}"><span>${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}${p.comment ? ` — ${e(p.comment)}` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(p.amount, p.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_payments')}</div>`;
    return `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div><div class="font-semibold mb-1">${t('fin_payroll_accrued')}</div>${accruals}</div>
        <div><div class="font-semibold mb-1">${t('fin_payroll_paid')}</div>${payments}</div>
    </div>`;
}

async function toggleDetail(id) {
    if (detailOpen.has(id)) { detailOpen.delete(id); render(); return; }
    detailOpen.add(id);
    render();
    if (!detailCache[id]) {
        const [acc, pay] = await Promise.all([
            Layout.db.from('fin_v_payroll_accruals').select('*').eq('position_id', id).order('period'),
            Layout.db.from('fin_v_payroll_payments').select('*').eq('position_id', id).order('occurred_on')
        ]);
        detailCache[id] = { accruals: acc.data || [], payments: pay.data || [] };
        const body = document.getElementById(`detail-body-${id}`);
        if (body) body.innerHTML = detailBodyHtml(id);
    }
}

// Бывшие сотрудники нужны в ведомости только пока за ними остаётся
// незакрытый остаток — иначе список зарастает историей навсегда
function visiblePositions() {
    return positions.filter(p => p.is_current || (p.salary_amount != null && Number(p.balance) !== 0));
}

function render() {
    const container = document.getElementById('payrollBody');
    const byDept = new Map();
    for (const p of visiblePositions()) {
        if (!byDept.has(p.department_id)) byDept.set(p.department_id, { name: p.department_name, rows: [] });
        byDept.get(p.department_id).rows.push(p);
    }
    if (!byDept.size) {
        container.innerHTML = `<div class="text-center py-10 opacity-60">${t('fin_payroll_no_employees')}</div>`;
        return;
    }
    container.innerHTML = [...byDept.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => `
            <div class="card bg-base-100 shadow-sm mb-4">
                <div class="card-body p-0">
                    <div class="px-4 py-3 font-semibold border-b border-base-200">${e(d.name)}</div>
                    <div class="overflow-x-auto">
                        <table class="table table-sm table-fixed w-full min-w-[820px]">
                            <colgroup>
                                <col class="w-[22%]"><col class="w-[18%]"><col class="w-[12%]">
                                <col class="w-[12%]"><col class="w-[12%]"><col class="w-[14%]"><col class="w-[10%]">
                            </colgroup>
                            <thead><tr>
                                <th>${t('fin_payroll_employee')}</th>
                                <th>${t('fin_payroll_position')}</th>
                                <th>${t('fin_payroll_salary')}</th>
                                <th>${t('fin_payroll_accrued')}</th>
                                <th>${t('fin_payroll_paid')}</th>
                                <th>${t('fin_payroll_balance')}</th>
                                <th></th>
                            </tr></thead>
                            <tbody>${d.rows.map(rowHtml).join('')}</tbody>
                        </table>
                    </div>
                </div>
            </div>`).join('');
}

async function load() {
    const { data, error } = await Layout.db.from('fin_v_payroll_positions').select('*').order('employee_name');
    if (error) { Layout.handleError(error, 'Зарплатная ведомость'); return; }
    positions = data || [];
    render();
}

function openPayModal(id) {
    const p = positions.find(x => x.id === id);
    if (!p) return;
    document.getElementById('payPositionId').value = p.id;
    document.getElementById('payModalTitle').textContent = `${t(p.salary_amount != null ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')} — ${p.employee_name}`;
    // Подсказка суммы: есть долг — предлагаем его; нет долга, но оклад есть —
    // предлагаем сам оклад (обычно платят именно его); нет оклада — пусто,
    // сумму вводят руками. Подсказку всегда можно поправить — это и оставляет
    // неровный остаток на будущее, как задумано (замечание ВГ, 16.09.2026)
    const bal = Number(p.balance) || 0;
    document.getElementById('payAmount').value = bal > 0 ? bal : (p.salary_amount ?? '');
    document.getElementById('payDate').value = FinUtils.todayISO();
    document.getElementById('payComment').value = '';
    document.getElementById('payModal').showModal();
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
        if (payBtn) openPayModal(payBtn.dataset.pay);
        else if (toggleBtn) toggleDetail(toggleBtn.dataset.toggle);
    });
    document.getElementById('payForm').addEventListener('submit', FinUtils.lockedSubmit(submitPay));
    document.getElementById('runAccrualBtn').addEventListener('click', runAccrualNow);

    await load();
}

init();
})();
