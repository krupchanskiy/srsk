// ==================== ФИНАНСЫ: НАЁМНЫЕ РАБОЧИЕ ====================
// Вторая вкладка зарплатной ведомости (733): люди со стороны — уборщицы,
// помощницы на кухне, рабочие Зелёных. Платят по листу за месяц: дни, часы,
// начислено, аванс, к выплате. Здесь — история людей по месяцам и правка
// рабочих; выплаты вносятся листом на странице «Оплаты с проходной» (734).
// В себестоимость кухни идёт за месяц работы.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let workers = [];
let payments = [];
let departments = [];
let loaded = false;

const monthValue = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;

function monthLabel(periodStr) {
    // месяц отдельно от года — именительный падеж («август», а не «августа»)
    const d = DateUtils.parseDate(periodStr);
    const name = d.toLocaleDateString(DateUtils.getLang(), { month: 'long' });
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getFullYear()}`;
}

// Последние 24 месяца, по умолчанию прошлый: лист приходит после конца месяца
function monthOptions(selected) {
    const now = new Date();
    const out = [];
    for (let i = 0; i < 24; i++) {
        const v = monthValue(new Date(now.getFullYear(), now.getMonth() - i, 1));
        out.push(`<option value="${v}" ${v === selected ? 'selected' : ''}>${monthLabel(v)}</option>`);
    }
    return out.join('');
}

function rateLabel(w) {
    if (w.rate == null) return '—';
    if (w.pay_kind === 'month') return `${FinUtils.fmtMoney(w.rate, w.currency_code)} / ${t('fin_hired_per_month')}`;
    let s = `${FinUtils.fmtMoney(w.rate, w.currency_code)} / ${t('fin_hired_per_day')}`;
    if (w.hour_rate != null) s += ` + ${FinUtils.fmtMoney(w.hour_rate, w.currency_code)} / ${t('fin_hired_per_hour')}`;
    return s;
}

const fmtNum = v => (v == null || v === '' ? '—' : String(Number(v)).replace('.', ','));

async function load() {
    const [w, p, d] = await Promise.all([
        Layout.db.from('fin_v_hired_workers').select('*').order('name'),
        Layout.db.from('fin_v_hired_payments').select('*').order('occurred_on'),
        Layout.db.from('fin_v_departments').select('*').order('name')
    ]);
    const err = w.error || p.error || d.error;
    if (err) { Layout.handleError(err, t('fin_payroll_tab_hired')); return; }
    workers = w.data || [];
    payments = (p.data || []).filter(x => !x.is_reversed);
    departments = d.data || [];
    loaded = true;
    render();
}

function render() {
    const period = document.getElementById('hiredMonth').value;
    const body = document.getElementById('hiredBody');
    const monthPays = payments.filter(p => p.period === period);
    const byWorker = new Map();
    for (const p of monthPays) {
        if (!byWorker.has(p.worker_id)) byWorker.set(p.worker_id, []);
        byWorker.get(p.worker_id).push(p);
    }
    // Видны работающие и все, кому в этом месяце что-то выплачено
    const shown = workers.filter(w => w.is_active || byWorker.has(w.id));
    if (!shown.length) {
        body.innerHTML = `<div class="text-center py-10 opacity-60">${t('fin_hired_no_workers')}</div>`;
        document.getElementById('hiredGrandTotal').innerHTML = '';
        return;
    }
    const byDept = new Map();
    for (const w of shown) {
        if (!byDept.has(w.department_id)) byDept.set(w.department_id, { name: w.department_name, rows: [] });
        byDept.get(w.department_id).rows.push(w);
    }
    const sum = (list, f) => list.reduce((s, x) => s + Number(x[f] || 0), 0);
    let grand = 0;
    body.innerHTML = [...byDept.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map(d => {
        let deptTotal = 0;
        const cur = d.rows[0].currency_code;
        const rows = d.rows.map(w => {
            const ps = byWorker.get(w.id) || [];
            const paid = sum(ps, 'amount');
            deptTotal += paid;
            const payers = [...new Set(ps.map(p => p.source_account_name).filter(Boolean))].join(', ');
            const cell = (v, money) => ps.length ? (money ? FinUtils.fmtMoney(v, w.currency_code) : fmtNum(v)) : '';
            return `<tr class="${w.is_active ? '' : 'opacity-60'}">
                <td><button type="button" class="hover:underline text-left" data-edit-worker="${w.id}">${e(w.name)}</button>
                    ${w.is_active ? '' : ` <span class="badge badge-ghost badge-xs">${t('fin_hired_inactive')}</span>`}</td>
                <td class="text-xs">${rateLabel(w)}</td>
                <td class="font-mono">${cell(sum(ps, 'days'))}</td>
                <td class="font-mono">${cell(sum(ps, 'hours'))}</td>
                <td class="font-mono">${cell(sum(ps, 'accrued'), true)}</td>
                <td class="font-mono">${cell(sum(ps, 'advance'), true)}</td>
                <td class="font-mono">${ps.length ? FinUtils.fmtMoney(paid, w.currency_code) : `<span class="opacity-50">${t('fin_hired_not_paid')}</span>`}</td>
                <td class="text-xs">${e(payers)}</td>
            </tr>`;
        }).join('');
        grand += deptTotal;
        return `<div class="card bg-base-100 shadow-sm mb-4">
            <div class="card-body p-0">
                <div class="px-4 py-3 font-semibold border-b border-base-200 flex justify-between gap-2">
                    <span>${e(d.name)}</span><span class="font-mono">${FinUtils.fmtMoney(deptTotal, cur)}</span>
                </div>
                <div class="overflow-x-auto">
                    <table class="table table-sm w-full min-w-[820px]">
                        <thead><tr>
                            <th>${t('fin_hired_name')}</th><th>${t('fin_hired_pay_kind')}</th>
                            <th>${t('fin_hired_days')}</th><th>${t('fin_hired_hours')}</th>
                            <th>${t('fin_hired_accrued')}</th><th>${t('fin_hired_advance')}</th>
                            <th>${t('fin_hired_to_pay')}</th><th>${t('fin_hired_paid_by')}</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
    }).join('');
    document.getElementById('hiredGrandTotal').innerHTML =
        `${t('fin_hired_total')}: <span class="font-mono font-semibold">${FinUtils.fmtMoney(grand, 'INR')}</span>`;
}

// ---------- рабочий ----------
function deptOptions(selectedId) {
    return departments.map(d => `<option value="${d.id}" ${d.id === selectedId ? 'selected' : ''}>${e(d.name)}</option>`).join('');
}

function openWorker(id) {
    const w = workers.find(x => x.id === id);
    document.getElementById('workerId').value = w?.id || '';
    document.getElementById('workerName').value = w?.name || '';
    document.getElementById('workerDept').innerHTML = deptOptions(w?.department_id);
    document.getElementById('workerKind').value = w?.pay_kind || 'day';
    document.getElementById('workerRate').value = w?.rate ?? '';
    document.getElementById('workerHourRate').value = w?.hour_rate ?? '';
    document.getElementById('workerNote').value = w?.note || '';
    document.getElementById('workerActive').checked = w ? w.is_active : true;
    document.getElementById('workerActiveWrap').classList.toggle('hidden', !w);
    document.getElementById('workerModal').showModal();
}

async function submitWorker(ev) {
    ev.preventDefault();
    const id = document.getElementById('workerId').value;
    const res = await FinUtils.rpc('fin_hired_worker_save', {
        id: id || null,
        name: document.getElementById('workerName').value,
        department_id: document.getElementById('workerDept').value,
        pay_kind: document.getElementById('workerKind').value,
        rate: document.getElementById('workerRate').value || null,
        hour_rate: document.getElementById('workerHourRate').value || null,
        note: document.getElementById('workerNote').value || null,
        is_active: id ? document.getElementById('workerActive').checked : true
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('workerModal').close();
        await load();
    }
}

// ---------- вкладки ----------
function showTab(tab) {
    document.querySelectorAll('#payrollTabs [data-tab]').forEach(x => x.classList.toggle('tab-active', x.dataset.tab === tab));
    document.getElementById('tabSalaried').classList.toggle('hidden', tab !== 'salaried');
    document.getElementById('tabHired').classList.toggle('hidden', tab !== 'hired');
    history.replaceState(null, '', tab === 'hired' ? '#hired' : location.pathname + location.search);
    if (tab === 'hired' && !loaded) load();
}

async function init() {
    const now = new Date();
    document.getElementById('hiredMonth').innerHTML = monthOptions(monthValue(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
    document.getElementById('payrollTabs').addEventListener('click', ev => {
        const tab = ev.target.closest('[data-tab]');
        if (tab) showTab(tab.dataset.tab);
    });
    document.getElementById('hiredMonth').addEventListener('change', render);
    document.getElementById('hiredAddWorkerBtn').addEventListener('click', () => openWorker(null));
    document.getElementById('hiredBody').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-edit-worker]');
        if (btn) openWorker(btn.dataset.editWorker);
    });
    document.getElementById('workerForm').addEventListener('submit', FinUtils.lockedSubmit(submitWorker));
    await FinUtils.loadRefs();
    if (location.hash === '#hired') showTab('hired');
}

// Вызывается из fin-payroll.js после Layout.init — переводы и права уже есть
window.FinHired = { init };
})();
