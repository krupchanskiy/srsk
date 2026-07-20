// ==================== ФИНАНСЫ: СЧЕТА ====================
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let currentKind = 'real';
let openingRequestId = null;
const personNames = {}; // id -> имя ответственного

async function loadResponsibleNames() {
    const ids = [...new Set(FinUtils.refs.accounts.map(a => a.responsible_person_id).filter(Boolean))];
    if (!ids.length) return;
    const { data } = await Layout.db.from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name')
        .in('id', ids);
    for (const v of data || []) {
        personNames[v.id] = v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim();
    }
}

// Ячейка «Последний чекпоинт» с цветом давности: сегодня — зелёный,
// 1-3 дня — жёлтый, дольше / никогда — красный (ежедневный ритуал, runbook §4)
const AGE_COLORS = { success: '#059669', warning: '#b45309', error: '#dc2626' };
function ageClass(days) { return days <= 0 ? 'success' : days <= 3 ? 'warning' : 'error'; }

function checkpointCell(a) {
    if (!a.last_checkpoint_seq) {
        return `<span class="badge badge-error badge-sm">${t('fin_never_reconciled')}</span>`;
    }
    const days = Math.floor((Date.now() - new Date(a.last_checkpoint_at).getTime()) / 86400000);
    const c = AGE_COLORS[ageClass(days)];
    const dot = `<span class="inline-block w-2 h-2 rounded-full mr-1 align-middle" style="background:${c}"></span>`;
    return `${dot}<span style="color:${c}">№${a.last_checkpoint_seq}, ${DateUtils.formatShort(new Date(a.last_checkpoint_at))}</span>` +
        (Number(a.unreconciled_count) > 0 ? ` <span class="badge badge-warning badge-xs">+${a.unreconciled_count}</span>` : '');
}

// Сводка по текущей вкладке: сумма остатков по валютам, число счетов, минусов
function renderSummary(accounts) {
    const box = document.getElementById('accountsSummary');
    if (!box) return;
    const byCur = {};
    for (const a of accounts) byCur[a.currency_code] = (byCur[a.currency_code] || 0) + Number(a.balance);
    const totalHtml = Object.entries(byCur).filter(([, v]) => v !== 0)
        .map(([c, v]) => `<div class="fin-kpi-value ${v < 0 ? 'text-error' : ''}">${FinUtils.fmtMoney(v, c)}</div>`).join('')
        || '<div class="fin-kpi-value opacity-40">—</div>';
    const negCount = accounts.filter(a => a.is_negative).length;
    const tile = (chipClass, icon, label, value) => `
        <div class="card bg-base-100 fin-kpi"><div class="card-body">
            <div class="flex items-center gap-3">
                <div class="fin-icon-chip ${chipClass}">${icon}</div>
                <div class="min-w-0">
                    <div class="fin-kpi-label">${label}</div>
                    <div class="mt-0.5">${value}</div>
                </div>
            </div>
        </div></div>`;
    const walletIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/></svg>';
    const hashIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.75h16.5m-16.5 4.5h16.5M6.75 3.75l-3 16.5m13.5-16.5l-3 16.5"/></svg>';
    const warnIcon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181"/></svg>';
    box.innerHTML =
        tile('', walletIcon, t('fin_total_balance'), totalHtml) +
        tile('', hashIcon, t('fin_accounts_count'), `<div class="fin-kpi-value">${accounts.length}</div>`) +
        (negCount ? tile('is-error', warnIcon, t('fin_negative_accounts'), `<div class="fin-kpi-value text-error">${negCount}</div>`) : '');
}

function render() {
    const isAdmin = window.hasPermission?.('fin_admin') || window.currentUser?.is_superuser;
    const accounts = FinUtils.refs.accounts.filter(a => a.kind === currentKind);
    renderSummary(accounts);
    const tbody = document.getElementById('accountsBody');
    if (!accounts.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-10 opacity-60">
            <div class="mb-2">${t('fin_no_accounts_yet')}</div>
            ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="FinAccounts.openAccountModal()">${t('fin_new_account')}</button>` : ''}
        </td></tr>`;
        return;
    }
    tbody.innerHTML = accounts.map(a => `
        <tr class="${a.is_active ? '' : 'opacity-60'} cursor-pointer" data-account="${a.account_id}" tabindex="0" title="${t('fin_open_ledger')}">
            <td class="font-medium">${e(a.name)}${a.is_active ? '' : ` <span class="badge badge-ghost badge-xs">${t('fin_archived')}</span>`}</td>
            <td>${e(a.group_name || '')}</td>
            <td>${e(personNames[a.responsible_person_id] || '')}</td>
            <td class="text-sm whitespace-nowrap">${checkpointCell(a)}</td>
            <td class="text-right font-mono ${a.is_negative ? 'text-error font-bold' : ''}">${FinUtils.fmtMoney(a.balance, a.currency_code)}</td>
            <td class="text-right whitespace-nowrap">
                <button class="btn btn-ghost btn-sm" data-action="reconcile" data-id="${a.account_id}" title="${t('fin_recon_do')}" aria-label="${t('fin_recon_do')}">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                </button>
                ${isAdmin ? `
                <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${a.account_id}" title="${t('fin_edit_account')}" aria-label="${t('fin_edit_account')}">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Z"/></svg>
                </button>
                ${a.last_ledger_seq === null ? `
                <button class="btn btn-ghost btn-sm" data-action="opening" data-id="${a.account_id}" title="${t('fin_new_opening')}" aria-label="${t('fin_new_opening')}">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>
                </button>` : ''}
                <button class="btn btn-ghost btn-sm" data-action="give" data-id="${a.account_id}" title="${t('fin_give_out')}" aria-label="${t('fin_give_out')}">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M7 16l-4-4m0 0l4-4m-4 4h18M17 8l4 4m0 0l-4 4m4-4H3"/></svg>
                </button>` : ''}
            </td>
        </tr>
    `).join('');
}

// ==================== СЧЁТ: СОЗДАНИЕ / ПРАВКА ====================
function fillAccountSelects() {
    document.getElementById('accKind').innerHTML =
        `<option value="real">${t('fin_kind_real')}</option><option value="custodial">${t('fin_kind_custodial')}</option>`;
    document.getElementById('accMode').innerHTML =
        `<option value="cash_count">${t('fin_recon_cash')}</option><option value="statement">${t('fin_recon_statement')}</option>`;
    document.getElementById('accCurrency').innerHTML = FinUtils.refs.currencies
        .filter(c => c.is_active)
        .map(c => `<option value="${c.code}">${e(c.symbol)} ${c.code}</option>`).join('');
    document.getElementById('accCostCenter').innerHTML = FinUtils.costCenterOptions();
    document.getElementById('groupList').innerHTML =
        [...new Set(FinUtils.refs.accounts.map(a => a.group_name).filter(Boolean))]
            .map(g => `<option value="${e(g)}">`).join('');
}

function openAccountModal(accountId) {
    fillAccountSelects();
    const acc = accountId ? FinUtils.refs.accounts.find(a => a.account_id === accountId) : null;
    document.getElementById('accId').value = acc?.account_id || '';
    document.getElementById('accountModalTitle').textContent = acc ? t('fin_edit_account') : t('fin_new_account');
    document.getElementById('accName').value = acc?.name || '';
    document.getElementById('accKind').value = acc?.kind || 'real';
    document.getElementById('accMode').value = acc?.reconciliation_mode || 'cash_count';
    document.getElementById('accCurrency').value = acc?.currency_code || 'INR';
    document.getElementById('accGroup').value = acc?.group_name || '';
    document.getElementById('accRespSearch').value = acc?.responsible_person_id ? (personNames[acc.responsible_person_id] || '') : '';
    document.getElementById('accRespId').value = acc?.responsible_person_id || '';
    document.getElementById('accCostCenter').value = acc?.default_cost_center_id || '';
    // Тип/валюта/способ сверки после создания не меняются
    ['accKind', 'accMode', 'accCurrency'].forEach(id => document.getElementById(id).disabled = !!acc);
    document.getElementById('accDeactivateBtn').classList.toggle('hidden', !acc || !acc.is_active);

    // Ответственный у счёта с проводками меняется только передачей ответственности
    const hasActivity = acc && acc.last_ledger_seq !== null;
    document.getElementById('accRespSearch').disabled = hasActivity;
    const trBlock = document.getElementById('respTransferBlock');
    trBlock.classList.toggle('hidden', !hasActivity);
    if (hasActivity) {
        const fresh = Number(acc.last_checkpoint_seq || 0) === Number(acc.last_ledger_seq || 0) && acc.last_checkpoint_seq;
        document.getElementById('respTransferBtn').disabled = !fresh;
        document.getElementById('respTransferHint').classList.toggle('hidden', !!fresh);
        document.getElementById('respNewSearch').value = '';
        document.getElementById('respNewId').value = '';
        document.getElementById('respReason').value = '';
    }
    document.getElementById('accountModal').showModal();
}

async function submitAccount(ev) {
    ev.preventDefault();
    const id = document.getElementById('accId').value;
    let res;
    if (id) {
        res = await FinUtils.rpc('fin_update_account', {
            account_id: id,
            name: document.getElementById('accName').value,
            group_name: document.getElementById('accGroup').value || null,
            responsible_person_id: document.getElementById('accRespId').value || null,
            default_cost_center_id: document.getElementById('accCostCenter').value || null
        });
    } else {
        res = await FinUtils.rpc('fin_create_account', {
            name: document.getElementById('accName').value,
            kind: document.getElementById('accKind').value,
            reconciliation_mode: document.getElementById('accMode').value,
            currency_code: document.getElementById('accCurrency').value,
            group_name: document.getElementById('accGroup').value || null,
            responsible_person_id: document.getElementById('accRespId').value || null,
            default_cost_center_id: document.getElementById('accCostCenter').value || null
        });
    }
    if (FinUtils.handleResult(res)) {
        document.getElementById('accountModal').close();
        await refresh();
    }
}

async function deactivateAccount() {
    const id = document.getElementById('accId').value;
    if (!id) return;
    const res = await FinUtils.rpc('fin_update_account', { account_id: id, is_active: false });
    if (FinUtils.handleResult(res)) {
        document.getElementById('accountModal').close();
        await refresh();
    }
}

// Передача ответственности (только по свежей сверке — сервер проверяет
// и чекпоинт, и текущий MAX(ledger_seq))
async function transferResponsibility() {
    const accId = document.getElementById('accId').value;
    const acc = FinUtils.refs.accounts.find(a => a.account_id === accId);
    const newId = document.getElementById('respNewId').value;
    const reason = document.getElementById('respReason').value.trim();
    if (!acc || !newId || !reason) {
        Layout.showNotification(t('fin_new_responsible') + ' + ' + t('fin_reason'), 'error');
        return;
    }
    const res = await FinUtils.rpc('fin_transfer_account_responsibility', {
        account_id: accId,
        expected_seq: Number(acc.last_checkpoint_seq),
        new_responsible_person_id: newId,
        reason
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('accountModal').close();
        await refresh();
    }
}

// ==================== НАЧАЛЬНЫЙ ОСТАТОК ====================
function openOpening(accountId) {
    const acc = FinUtils.refs.accounts.find(a => a.account_id === accountId);
    if (!acc) return;
    openingRequestId = openingRequestId || FinUtils.newRequestId();
    document.getElementById('opAccountId').value = accountId;
    document.getElementById('opAccountName').textContent = acc.name;
    document.getElementById('opAmount').value = '';
    document.getElementById('opDate').value = FinUtils.todayISO();
    document.getElementById('opDirection').value = 'in';
    document.getElementById('opComment').value = '';
    document.getElementById('openingModal').showModal();
}

async function submitOpening(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_create_opening', {
        request_id: openingRequestId,
        account_id: document.getElementById('opAccountId').value,
        direction: document.getElementById('opDirection').value,
        amount: document.getElementById('opAmount').value,
        occurred_on: document.getElementById('opDate').value,
        comment: document.getElementById('opComment').value || null
    });
    if (FinUtils.handleResult(res)) {
        openingRequestId = null;
        document.getElementById('openingModal').close();
        await refresh();
    }
}

// ==================== ДОСТУП ====================
async function openAccess() {
    document.getElementById('accessUserSearch').value = '';
    document.getElementById('accessUserId').value = '';
    renderAccessCheckboxes([]);
    const { data } = await Layout.db.from('fin_v_account_access').select('*');
    const byUser = {};
    for (const row of data || []) {
        (byUser[row.user_id] = byUser[row.user_id] || { name: row.user_name, accounts: [] }).accounts.push(row.account_name);
    }
    document.getElementById('accessCurrent').innerHTML = Object.values(byUser)
        .map(u => `<div>${e(u.name || '?')}: <span class="opacity-70">${e(u.accounts.join(', '))}</span></div>`)
        .join('') || '<div class="opacity-50">—</div>';
    document.getElementById('accessModal').showModal();
}

function renderAccessCheckboxes(selectedIds) {
    document.getElementById('accessAccounts').innerHTML = FinUtils.refs.accounts
        .filter(a => a.is_active)
        .map(a => `
            <label class="label cursor-pointer justify-start gap-3 py-1">
                <input type="checkbox" class="checkbox checkbox-sm access-cb" value="${a.account_id}" ${selectedIds.includes(a.account_id) ? 'checked' : ''}>
                <span class="label-text">${e(a.name)}</span>
            </label>`).join('');
}

async function onAccessUserPicked() {
    const userId = document.getElementById('accessUserId').value;
    if (!userId) { renderAccessCheckboxes([]); return; }
    const { data } = await Layout.db.from('fin_v_account_access').select('account_id').eq('user_id', userId);
    renderAccessCheckboxes((data || []).map(r => r.account_id));
}

async function saveAccess() {
    const userId = document.getElementById('accessUserId').value;
    if (!userId) {
        Layout.showNotification(t('fin_select_user'), 'error');
        return;
    }
    const ids = [...document.querySelectorAll('.access-cb:checked')].map(cb => cb.value);
    const res = await FinUtils.rpc('fin_set_account_access', { user_id: userId, account_ids: ids });
    if (FinUtils.handleResult(res)) {
        document.getElementById('accessModal').close();
    }
}

// ==================== ОБЩЕЕ ====================
async function refresh() {
    await FinUtils.reloadAccounts();
    await loadResponsibleNames();
    render();
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_accounts', itemId: 'fin_accounts' });
    await FinUtils.loadRefs();
    await loadResponsibleNames();
    render();

    document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => {
        document.querySelectorAll('[role="tab"]').forEach(x => x.classList.remove('tab-active'));
        tab.classList.add('tab-active');
        currentKind = tab.dataset.kind;
        render();
    }));

    const accBody = document.getElementById('accountsBody');
    accBody.addEventListener('click', ev => {
        const link = ev.target.closest('[data-action]');
        if (link) {
            const id = link.dataset.id;
            switch (link.dataset.action) {
                case 'edit': openAccountModal(id); break;
                case 'opening': openOpening(id); break;
                case 'give': window.location.href = `dds.html?action=transfer&source=${id}`; break;
                case 'reconcile': window.location.href = `reconciliation.html?account=${id}`; break;
            }
            return;
        }
        // клик по строке (не по кнопке) → лента счёта в ДДС
        const row = ev.target.closest('tr[data-account]');
        if (row) window.location.href = `dds.html?account=${row.dataset.account}`;
    });
    accBody.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter') return;
        const row = ev.target.closest('tr[data-account]');
        if (row && !ev.target.closest('[data-action]')) window.location.href = `dds.html?account=${row.dataset.account}`;
    });

    document.getElementById('accountForm').addEventListener('submit', submitAccount);
    document.getElementById('openingForm').addEventListener('submit', submitOpening);
    FinUtils.attachPersonSearch(document.getElementById('accRespSearch'), document.getElementById('accRespId'));
    FinUtils.attachPersonSearch(document.getElementById('respNewSearch'), document.getElementById('respNewId'));
    const accessHidden = document.getElementById('accessUserId');
    FinUtils.attachPersonSearch(document.getElementById('accessUserSearch'), accessHidden, true);
    accessHidden.addEventListener('change', onAccessUserPicked);
    // hidden input не кидает change при программной записи — следим кликом по подсказке
    document.getElementById('accessUserSearch').parentElement.addEventListener('click', () => {
        setTimeout(onAccessUserPicked, 50);
    });
}

window.FinAccounts = { openAccountModal, openOpening, openAccess, saveAccess, deactivateAccount, transferResponsibility };
init();
})();
