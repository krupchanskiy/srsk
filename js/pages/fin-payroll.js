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

function balanceBadge(p) {
    if (p.salary_amount == null) return '';
    const bal = Number(p.balance) || 0;
    if (bal > 0) return `<span class="badge badge-warning badge-sm">${t('fin_payroll_debt')}: ${FinUtils.fmtMoney(bal, p.currency_code)}</span>`;
    if (bal < 0) return `<span class="badge badge-info badge-sm">${t('fin_payroll_advance')}: ${FinUtils.fmtMoney(-bal, p.currency_code)}</span>`;
    return `<span class="badge badge-success badge-sm">${t('fin_payroll_settled')}</span>`;
}

function rowHtml(p) {
    const hasSalary = p.salary_amount != null;
    return `<tr class="${p.is_current ? '' : 'opacity-60'}">
        <td>${e(p.employee_name)}${!p.is_current ? ` <span class="badge badge-ghost badge-xs">${t('fin_payroll_former')}</span>` : ''}</td>
        <td>${e(p.position_title)}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(p.salary_amount, p.currency_code) : `<span class="opacity-50">${t('fin_payroll_no_salary')}</span>`}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(p.total_accrued, p.currency_code) : '—'}</td>
        <td class="font-mono">${FinUtils.fmtMoney(p.total_paid, p.currency_code)}</td>
        <td>${balanceBadge(p)}</td>
        <td class="text-right">
            <button type="button" class="btn btn-primary btn-xs" data-pay="${p.id}">${t(hasSalary ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')}</button>
        </td>
    </tr>`;
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
                        <table class="table table-sm">
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
    // По умолчанию сумма выплаты = текущий долг; если аванс или нет оклада — пусто,
    // сумму вводят руками (это и оставляет неровный остаток на будущее, как задумано)
    document.getElementById('payAmount').value = p.salary_amount != null && Number(p.balance) > 0 ? p.balance : '';
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

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_payroll', itemId: 'fin_payroll' });

    document.getElementById('payrollBody').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-pay]');
        if (btn) openPayModal(btn.dataset.pay);
    });
    document.getElementById('payForm').addEventListener('submit', FinUtils.lockedSubmit(submitPay));

    await load();
}

init();
})();
