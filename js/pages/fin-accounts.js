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

function render() {
    const isAdmin = window.hasPermission?.('fin_admin') || window.currentUser?.is_superuser;
    const accounts = FinUtils.refs.accounts.filter(a => a.kind === currentKind);
    const tbody = document.getElementById('accountsBody');
    if (!accounts.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center py-6 opacity-60">${t('fin_no_accounts_yet')}</td></tr>`;
        return;
    }
    tbody.innerHTML = accounts.map(a => `
        <tr class="${a.is_active ? '' : 'opacity-40'}">
            <td class="font-medium">${e(a.name)}${a.is_active ? '' : ` <span class="badge badge-ghost badge-xs">${t('fin_archived')}</span>`}</td>
            <td>${e(a.group_name || '')}</td>
            <td>${e(personNames[a.responsible_person_id] || '')}</td>
            <td class="text-right font-mono ${a.is_negative ? 'text-error font-bold' : ''}">${FinUtils.fmtMoney(a.balance, a.currency_code)}</td>
            <td class="text-right">
                ${isAdmin ? `
                <div class="dropdown dropdown-end">
                    <button class="btn btn-ghost btn-xs">⋯</button>
                    <ul class="dropdown-content menu bg-base-100 rounded-box shadow-lg z-50 w-52 p-1">
                        <li><a data-action="edit" data-id="${a.account_id}">${t('fin_edit_account')}</a></li>
                        ${a.last_ledger_seq === null ? `<li><a data-action="opening" data-id="${a.account_id}">${t('fin_new_opening')}</a></li>` : ''}
                        <li><a data-action="give" data-id="${a.account_id}">${t('fin_give_out')}</a></li>
                    </ul>
                </div>` : ''}
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

    document.getElementById('accountsBody').addEventListener('click', ev => {
        const link = ev.target.closest('[data-action]');
        if (!link) return;
        const id = link.dataset.id;
        switch (link.dataset.action) {
            case 'edit': openAccountModal(id); break;
            case 'opening': openOpening(id); break;
            case 'give': window.location.href = `dds.html?action=transfer&source=${id}`; break;
        }
    });

    document.getElementById('accountForm').addEventListener('submit', submitAccount);
    document.getElementById('openingForm').addEventListener('submit', submitOpening);
    FinUtils.attachPersonSearch(document.getElementById('accRespSearch'), document.getElementById('accRespId'));
    const accessHidden = document.getElementById('accessUserId');
    FinUtils.attachPersonSearch(document.getElementById('accessUserSearch'), accessHidden, true);
    accessHidden.addEventListener('change', onAccessUserPicked);
    // hidden input не кидает change при программной записи — следим кликом по подсказке
    document.getElementById('accessUserSearch').parentElement.addEventListener('click', () => {
        setTimeout(onAccessUserPicked, 50);
    });
}

window.FinAccounts = { openAccountModal, openOpening, openAccess, saveAccess, deactivateAccount };
init();
})();
