// ==================== ФИНАНСЫ: ДДС ====================
// Журнал операций (общая лента) / лента счёта с running balance.
// Формы: расход (мультистрочный), приход/пожертвование, перевод.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

const OP_TYPES = ['payment', 'refund', 'transfer', 'expense', 'income', 'donation', 'opening', 'reversal', 'reconciliation_adjustment'];

// request_id живёт от открытия формы до успешного сохранения:
// повтор после сетевой ошибки уходит с тем же UUID (идемпотентность)
const requestIds = { expense: null, income: null, transfer: null, reversal: null };
let expenseRowSeq = 0;
let opsById = {};   // операции общей ленты (для кнопки сторно в развороте)

// ==================== ФИЛЬТРЫ ====================
const FILTER_IDS = { filterAccount: 'account', filterType: 'type', filterApproval: 'approval', filterFrom: 'from', filterTo: 'to', filterSearch: 'q' };

function buildFilters() {
    document.getElementById('filterAccount').innerHTML =
        `<option value="">${t('fin_filter_all_accounts')}</option>` +
        FinUtils.refs.accounts.map(a => `<option value="${a.account_id}">${e(a.name)}</option>`).join('');
    document.getElementById('filterType').innerHTML =
        `<option value="">${t('fin_filter_all_types')}</option>` +
        OP_TYPES.map(tp => `<option value="${tp}">${e(FinUtils.typeLabel(tp))}</option>`).join('');
    document.getElementById('filterApproval').innerHTML =
        `<option value="">${t('fin_filter_all_statuses')}</option>` +
        ['pending', 'approved', 'disputed', 'not_required'].map(a => `<option value="${a}">${t('fin_approval_' + a)}</option>`).join('');

    // восстановление фильтров из URL (ссылки на выборку можно шарить)
    const params = new URLSearchParams(window.location.search);
    Object.entries(FILTER_IDS).forEach(([id, param]) => {
        if (params.get(param)) document.getElementById(id).value = params.get(param);
    });

    ['filterAccount', 'filterType', 'filterApproval', 'filterFrom', 'filterTo'].forEach(id =>
        document.getElementById(id).addEventListener('change', () => loadTable()));
    document.getElementById('filterSearch').addEventListener('input', Layout.debounce(() => loadTable(), 400));
}

function filterValues() {
    return {
        account: document.getElementById('filterAccount').value || null,
        type: document.getElementById('filterType').value || null,
        approval: document.getElementById('filterApproval').value || null,
        from: document.getElementById('filterFrom').value || null,
        to: document.getElementById('filterTo').value || null,
        q: document.getElementById('filterSearch').value.trim() || null
    };
}

function syncFiltersToUrl() {
    const url = new URL(window.location);
    Object.entries(FILTER_IDS).forEach(([id, param]) => {
        const v = document.getElementById(id).value.trim();
        if (v) url.searchParams.set(param, v); else url.searchParams.delete(param);
    });
    history.replaceState(null, '', url);
}

// ==================== ТАБЛИЦА ====================
function badges(op) {
    let html = '';
    if (op.is_reversed) html += ` <span class="badge badge-ghost badge-xs">${t('fin_reversed_badge')}</span>`;
    if (op.has_post_close || op.is_post_close) html += ` <span class="badge badge-neutral badge-xs">${t('fin_post_close_badge')}</span>`;
    if (op.is_late) html += ` <span class="badge badge-outline badge-xs" title="${t('fin_late_badge')}" aria-label="${t('fin_late_badge')}">${FinUtils.ICONS.clock}</span>`;
    if (op.has_attachments) html += ` <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3 inline opacity-60"><path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"/></svg>`;
    return html;
}

const PAGE = 200;
let listOffset = 0;      // смещение пагинации текущей выборки
let shownCount = 0;

// Плашка «Показано N» + кнопка «Показать ещё»
function renderPager(gotFullPage) {
    const el = document.getElementById('ddsPager');
    if (!el) return;
    if (!shownCount) { el.innerHTML = ''; return; }
    el.innerHTML = `<span class="opacity-70">${t('fin_shown_count')}: ${shownCount}</span>` +
        (gotFullPage ? ` <button class="btn btn-ghost btn-sm" id="ddsMoreBtn">${t('fin_load_more')}</button>` : '');
    document.getElementById('ddsMoreBtn')?.addEventListener('click', () => loadTable(true));
}

// Подсветить свежесозданную операцию (первая строка после перезагрузки)
let highlightNext = false;
function applyHighlight() {
    if (!highlightNext) return;
    highlightNext = false;
    document.querySelector('#ddsBody tr')?.classList.add('fin-new-row');
}

async function loadTable(append = false) {
    const f = filterValues();
    syncFiltersToUrl();
    const head = document.getElementById('ddsHead');
    const body = document.getElementById('ddsBody');
    if (!append) {
        listOffset = 0;
        shownCount = 0;
        body.innerHTML = `<tr><td colspan="8" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    }

    if (f.account) {
        // Лента одного счёта: по ledger_seq, с running balance
        head.innerHTML = `<tr>
            <th data-i18n="fin_occurred_on">${t('fin_occurred_on')}</th>
            <th>${t('fin_kind')}</th>
            <th>${t('fin_category')}</th>
            <th>${t('fin_retreat_object')}</th>
            <th>${t('fin_comment')}</th>
            <th class="text-right">${t('fin_amount')}</th>
            <th class="text-right">${t('fin_running_balance')}</th>
            <th>${t('fin_status')}</th></tr>`;

        let q = Layout.db.from('fin_v_account_ledger').select('*')
            .eq('account_id', f.account)
            .order('ledger_seq', { ascending: false })
            .range(listOffset, listOffset + PAGE - 1);
        if (f.type) q = q.eq('type', f.type);
        if (f.approval) q = q.eq('approval', f.approval);
        if (f.from) q = q.gte('occurred_on', f.from);
        if (f.to) q = q.lte('occurred_on', f.to);
        if (f.q) q = q.ilike('comment', `%${f.q}%`);
        const { data, error } = await q;
        if (error) { Layout.handleError(error, 'ДДС'); return; }
        if (!data.length && !append) {
            body.innerHTML = `<tr><td colspan="8" class="text-center py-6 opacity-60">${t('fin_no_operations')}</td></tr>`;
            renderPager(false);
            return;
        }
        const html = data.map(p => `
            <tr class="${p.is_reversed ? 'opacity-60' : ''}">
                <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}</td>
                <td>${e(FinUtils.typeLabel(p.type))}${badges(p)}</td>
                <td>${e(p.category_name || '—')}</td>
                <td>${e(p.object_name || '')}</td>
                <td class="max-w-xs truncate opacity-70">${e(p.comment || '')}</td>
                <td class="text-right font-mono ${Number(p.signed_amount) < 0 ? 'text-error' : 'text-success'}">${FinUtils.fmtMoney(p.signed_amount, p.currency_code)}</td>
                <td class="text-right font-mono">${FinUtils.fmtMoney(p.running_balance, p.currency_code)}</td>
                <td>${FinUtils.approvalBadge(p.approval)}</td>
            </tr>
        `).join('');
        if (append) body.insertAdjacentHTML('beforeend', html); else body.innerHTML = html;
        listOffset += data.length;
        shownCount += data.length;
        renderPager(data.length === PAGE);
    } else {
        // Общая лента: по created_at DESC (ledger_seq разных счетов не сравнимы)
        head.innerHTML = `<tr>
            <th>${t('fin_occurred_on')}</th>
            <th>${t('fin_kind')}</th>
            <th class="text-right">${t('fin_amount')}</th>
            <th>${t('fin_comment')}</th>
            <th>${t('fin_status')}</th></tr>`;

        let q = Layout.db.from('fin_v_operations').select('*')
            .order('created_at', { ascending: false })
            .range(listOffset, listOffset + PAGE - 1);
        if (f.type) q = q.eq('type', f.type);
        if (f.approval) q = q.eq('approval', f.approval);
        if (f.from) q = q.gte('occurred_on', f.from);
        if (f.to) q = q.lte('occurred_on', f.to);
        if (f.q) q = q.or(`comment.ilike.%${f.q}%,payer_name.ilike.%${f.q}%`);
        const { data, error } = await q;
        if (error) { Layout.handleError(error, 'ДДС'); return; }
        if (!data.length && !append) {
            body.innerHTML = `<tr><td colspan="5" class="text-center py-6 opacity-60">${t('fin_no_operations')}</td></tr>`;
            renderPager(false);
            return;
        }
        opsById = append ? { ...opsById, ...Object.fromEntries(data.map(op => [op.operation_id, op])) }
                         : Object.fromEntries(data.map(op => [op.operation_id, op]));
        const html = data.map(op => `
            <tr class="cursor-pointer hover:bg-base-200 ${op.is_reversed ? 'opacity-60' : ''}" data-op="${op.operation_id}" tabindex="0">
                <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(op.occurred_on))}</td>
                <td>${e(FinUtils.typeLabel(op.type))}${badges(op)}</td>
                <td class="text-right font-mono whitespace-nowrap">${FinUtils.fmtAmountsByCurrencyColored(op.amounts_by_currency)}</td>
                <td class="max-w-md truncate opacity-70">${e([op.payer_name, op.comment].filter(Boolean).join(' · '))}</td>
                <td>${FinUtils.approvalBadge(op.approval)}</td>
            </tr>
            <tr class="hidden" id="det-${op.operation_id}"><td colspan="5" class="bg-base-200/50 p-0"></td></tr>
        `).join('');
        if (append) body.insertAdjacentHTML('beforeend', html); else body.innerHTML = html;
        listOffset += data.length;
        shownCount += data.length;
        renderPager(data.length === PAGE);
        applyHighlight();
    }
}

// Разворот операции в проводки
async function toggleDetails(opId) {
    const row = document.getElementById('det-' + opId);
    if (!row) return;
    if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const cell = row.firstElementChild;
    cell.innerHTML = `<div class="p-3"><span class="loading loading-spinner loading-sm"></span></div>`;
    const [{ data }, { data: atts }] = await Promise.all([
        Layout.db.from('fin_v_account_ledger').select('*').eq('operation_id', opId).order('ledger_seq'),
        Layout.db.from('fin_v_attachments').select('*').eq('parent_type', 'operation').eq('parent_id', opId)
    ]);
    postingsById = { ...postingsById, ...Object.fromEntries((data || []).map(p => [p.posting_id, p])) };
    const op = opsById[opId];
    const canEdit = window.hasPermission?.('fin_admin') && op && !op.is_reversed
        && !['reversal', 'refund', 'transfer', 'opening', 'reconciliation_adjustment'].includes(op.type);
    cell.innerHTML = `<div class="p-3 text-sm space-y-1">` + (data || []).map(p => `
        <div class="flex flex-wrap gap-3 items-center">
            <span class="font-medium">${e(p.account_name)}</span>
            <span class="font-mono ${Number(p.signed_amount) < 0 ? 'text-error' : 'text-success'}">${FinUtils.fmtMoney(p.signed_amount, p.currency_code)}</span>
            ${p.amount_base !== null && p.currency_code !== 'INR' ? `<span class="opacity-60 font-mono">₹ ${Number(p.amount_base).toLocaleString('ru-RU')}</span>` : ''}
            ${p.category_name ? `<span class="opacity-70">${e(p.category_name)}</span>` : ''}
            ${p.cost_center_name ? `<span class="badge badge-ghost badge-sm">${e(p.cost_center_name)}</span>` : ''}
            ${p.object_name ? `<span class="opacity-70">${e(p.object_name)}</span>` : ''}
            ${p.participant_name ? `<span class="opacity-70">${e(p.participant_name)}</span>` : ''}
            ${p.contractor_name ? `<span class="opacity-70">${e(p.contractor_name)}</span>` : ''}
            ${p.payment_channel ? `<span class="opacity-50">${e(FinUtils.channelLabel(p.payment_channel))}</span>` : ''}
            ${canEdit ? `<button class="btn btn-ghost btn-sm gap-1" onclick="FinDds.openAnalytics('${p.posting_id}')" aria-label="${t('fin_edit_analytics')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z"/></svg>
                <span class="hidden md:inline">${t('fin_edit_analytics')}</span>
            </button>` : ''}
        </div>`).join('')
        + FinUtils.attachmentsHtml(atts || [])
        + (window.hasPermission?.('fin_admin') ? `<div class="pt-1"><label class="btn btn-ghost btn-xs gap-1">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"/></svg>
            ${t('fin_attach_file')}<input type="file" class="hidden" accept="image/jpeg,image/png,image/webp,application/pdf" onchange="FinDds.attachFile(this, '${opId}')">
        </label></div>` : '')
        + reversalButtonHtml(opId) + `</div>`;
}

// Прикрепить файл из разворота
async function attachFile(input, opId) {
    const file = input.files?.[0];
    if (!file) return;
    input.disabled = true;
    const res = await FinUtils.uploadAndAttach(file, opId);
    input.disabled = false;
    input.value = '';
    if (FinUtils.handleResult(res)) {
        const row = document.getElementById('det-' + opId);
        if (row) { row.classList.add('hidden'); toggleDetails(opId); }
    }
}

// ==================== ПРАВКА АНАЛИТИКИ ====================
let postingsById = {};

function openAnalytics(postingId) {
    const p = postingsById[postingId];
    if (!p) return;
    document.getElementById('anPostingId').value = postingId;
    document.getElementById('anHash').value = p.analytics_hash;
    document.getElementById('anInfo').textContent =
        `${p.account_name} · ${FinUtils.fmtMoney(p.signed_amount, p.currency_code)}`;
    document.getElementById('anCategory').innerHTML = FinUtils.categoryOptions(p.direction, p.category_id);
    document.getElementById('anCc').innerHTML = FinUtils.costCenterOptions(p.cost_center_id);
    document.getElementById('anObject').innerHTML = FinUtils.objectOptions(p.object_id);
    document.getElementById('anContractor').innerHTML = FinUtils.contractorOptions(p.contractor_id);
    document.getElementById('anReason').value = '';
    document.getElementById('analyticsModal').showModal();
}

async function submitAnalytics(ev) {
    ev.preventDefault();
    const p = postingsById[document.getElementById('anPostingId').value];
    const res = await FinUtils.rpc('fin_update_posting_analytics', {
        posting_id: p.posting_id,
        expected_analytics_hash: document.getElementById('anHash').value,
        target: {
            category_id: document.getElementById('anCategory').value,
            cost_center_id: document.getElementById('anCc').value || null,
            object_id: document.getElementById('anObject').value || null,
            participant_id: p.participant_id || null,
            participant_balance_kind: p.participant_balance_kind || null,
            contractor_id: document.getElementById('anContractor').value || null
        },
        reason: document.getElementById('anReason').value || null,
        audit_request_id: FinUtils.newRequestId()
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('analyticsModal').close();
        await loadTable();
    }
}

// ==================== СТОРНО ====================
function reversalButtonHtml(opId) {
    const op = opsById[opId];
    if (!op || op.is_reversed || op.type === 'reversal') return '';
    if (!window.hasPermission?.('fin_admin')) return '';
    return `<div class="pt-2"><button class="btn btn-outline btn-error btn-xs gap-1" onclick="FinDds.openReversal('${opId}')">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/></svg>
        ${t('fin_reverse')}</button></div>`;
}

function openReversal(opId) {
    const op = opsById[opId];
    if (!op) return;
    requestIds.reversal = requestIds.reversal || FinUtils.newRequestId();
    document.getElementById('revOpId').value = opId;
    document.getElementById('revInfo').textContent =
        `${FinUtils.typeLabel(op.type)} · ${DateUtils.formatShort(DateUtils.parseDate(op.occurred_on))} · ${FinUtils.fmtAmountsByCurrency(op.amounts_by_currency)}`;
    document.getElementById('revReason').value = '';
    document.getElementById('revNewDate').checked = false;
    document.getElementById('revDate').value = FinUtils.todayISO();
    document.getElementById('revDateWrap').classList.add('hidden');
    document.getElementById('reversalModal').showModal();
}

async function submitReversal(ev) {
    ev.preventDefault();
    const newDate = document.getElementById('revNewDate').checked;
    const res = await FinUtils.rpc('fin_create_reversal', {
        request_id: requestIds.reversal,
        original_operation_id: document.getElementById('revOpId').value,
        occurred_on_policy: newDate ? 'actual_reverse_date' : 'same_as_original',
        occurred_on: newDate ? document.getElementById('revDate').value : null,
        reason: document.getElementById('revReason').value
    });
    if (FinUtils.handleResult(res)) {
        requestIds.reversal = null;
        document.getElementById('reversalModal').close();
        await FinUtils.reloadAccounts();
        await loadTable();
    }
}

// ==================== ФОРМА: РАСХОД ====================
function expenseRowHtml(idx) {
    return `
    <div class="border border-base-300 rounded-lg p-3 mb-2 exp-row" data-idx="${idx}">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_account')}</span></label>
                <select class="select select-bordered select-sm exp-account" required>${FinUtils.accountOptions()}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_amount')}</span></label>
                <input type="number" class="input input-bordered input-sm exp-amount" min="0.01" step="0.01" required>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_category')}</span></label>
                <select class="select select-bordered select-sm exp-category" required>${FinUtils.categoryOptions('out', null, true)}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_cost_center')}</span></label>
                <select class="select select-bordered select-sm exp-cc">${FinUtils.costCenterOptions()}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_retreat_object')}</span></label>
                <select class="select select-bordered select-sm exp-object">${FinUtils.objectOptions()}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_contractor')}</span></label>
                <select class="select select-bordered select-sm exp-contractor">${FinUtils.contractorOptions()}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_channel')}</span></label>
                <select class="select select-bordered select-sm exp-channel">${FinUtils.channelOptions('cash')}</select>
            </div>
        </div>
        ${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm text-error mt-1" aria-label="${t('fin_remove_row')}" onclick="this.closest('.exp-row').remove(); FinDds.updateRecap && FinDds.updateRecap()">${FinUtils.ICONS.x}</button>` : ''}
    </div>`;
}

function addExpenseRow() {
    expenseRowSeq++;
    document.getElementById('expRows').insertAdjacentHTML('beforeend', expenseRowHtml(expenseRowSeq));
}

function openExpense() {
    requestIds.expense = requestIds.expense || FinUtils.newRequestId();
    document.getElementById('expDate').value = FinUtils.todayISO();
    document.getElementById('expComment').value = '';
    document.getElementById('expFiles').value = '';
    document.getElementById('expFilesList').textContent = '';
    document.getElementById('expRows').innerHTML = expenseRowHtml(0);
    updateExpenseRecap();
    document.getElementById('expenseModal').showModal();
}

async function submitExpense(ev) {
    ev.preventDefault();
    const rows = [...document.querySelectorAll('#expRows .exp-row')].map(row => ({
        id: FinUtils.newRequestId(),
        account_id: row.querySelector('.exp-account').value,
        amount: row.querySelector('.exp-amount').value,
        category_id: row.querySelector('.exp-category').value,
        cost_center_id: row.querySelector('.exp-cc').value || null,
        object_id: row.querySelector('.exp-object').value || null,
        contractor_id: row.querySelector('.exp-contractor').value || null,
        payment_channel: row.querySelector('.exp-channel').value || null
    }));

    const opId = requestIds.expense;
    const res = await FinUtils.rpc('fin_create_expense', {
        request_id: opId,
        occurred_on: document.getElementById('expDate').value,
        comment: document.getElementById('expComment').value || null,
        rows
    });
    if (FinUtils.handleResult(res)) {
        requestIds.expense = null;
        // чеки: операция уже создана — привязываем файлы (upload-flow ТЗ 4.13)
        const files = [...document.getElementById('expFiles').files];
        for (const f of files) {
            const attRes = await FinUtils.uploadAndAttach(f, opId);
            if (!attRes?.ok) Layout.showNotification(`${f.name}: ${attRes?.error?.message || 'ошибка загрузки'}`, 'warning');
        }
        document.getElementById('expenseModal').close();
        highlightNext = true;
        await FinUtils.reloadAccounts();
        await loadTable();
    }
}

// Живое резюме расхода: суммы строк по валютам счетов
function updateExpenseRecap() {
    const el = document.getElementById('expRecap');
    if (!el) return;
    const totals = {};
    document.querySelectorAll('#expRows .exp-row').forEach(row => {
        const amount = Number(row.querySelector('.exp-amount').value);
        const cur = row.querySelector('.exp-account').selectedOptions[0]?.dataset?.currency;
        if (amount && cur) totals[cur] = (totals[cur] || 0) + amount;
    });
    const parts = Object.entries(totals).map(([cur, sum]) => FinUtils.fmtMoney(sum, cur));
    el.textContent = parts.length ? `${t('fin_total')}: ${parts.join(' · ')}` : '';
}

// ==================== ФОРМА: ПРИХОД / ПОЖЕРТВОВАНИЕ ====================
function openIncome() {
    requestIds.income = requestIds.income || FinUtils.newRequestId();
    document.getElementById('incDate').value = FinUtils.todayISO();
    document.getElementById('incAccount').innerHTML = FinUtils.accountOptions();
    document.getElementById('incObject').innerHTML = FinUtils.objectOptions();
    document.getElementById('incChannel').innerHTML = FinUtils.channelOptions('cash');
    updateIncomeCategoryList();
    document.getElementById('incAmount').value = '';
    document.getElementById('incComment').value = '';
    document.getElementById('incDonorSearch').value = '';
    document.getElementById('incDonorId').value = '';
    document.getElementById('incomeModal').showModal();
}

function updateIncomeCategoryList() {
    document.getElementById('incCategory').innerHTML = FinUtils.categoryOptions('in', null, true);
    document.getElementById('incDonorWrap').classList.toggle('hidden', !document.getElementById('incIsDonation').checked);
}

async function submitIncome(ev) {
    ev.preventDefault();
    const isDonation = document.getElementById('incIsDonation').checked;
    const payload = {
        request_id: requestIds.income,
        occurred_on: document.getElementById('incDate').value,
        comment: document.getElementById('incComment').value || null,
        rows: [{
            id: FinUtils.newRequestId(),
            account_id: document.getElementById('incAccount').value,
            amount: document.getElementById('incAmount').value,
            category_id: document.getElementById('incCategory').value,
            object_id: document.getElementById('incObject').value || null,
            payment_channel: document.getElementById('incChannel').value || null
        }]
    };
    if (isDonation && document.getElementById('incDonorId').value) {
        payload.payer_contact_id = document.getElementById('incDonorId').value;
    }
    const res = await FinUtils.rpc(isDonation ? 'fin_create_donation' : 'fin_create_income', payload);
    if (FinUtils.handleResult(res)) {
        requestIds.income = null;
        document.getElementById('incomeModal').close();
        highlightNext = true;
        await FinUtils.reloadAccounts();
        await loadTable();
    }
}

// ==================== ФОРМА: ПЕРЕВОД ====================
function openTransfer(sourceId) {
    requestIds.transfer = requestIds.transfer || FinUtils.newRequestId();
    document.getElementById('trDate').value = FinUtils.todayISO();
    document.getElementById('trSource').innerHTML = FinUtils.accountOptions(sourceId);
    rebuildTransferTarget();
    document.getElementById('trAmount').value = '';
    document.getElementById('trTargetAmount').value = '';
    document.getElementById('trComment').value = '';
    updateTransferCurrency();
    updateTransferRecap();
    document.getElementById('transferModal').showModal();
}

// Получатель никогда не совпадает с источником: источник исключён из списка
function rebuildTransferTarget() {
    const src = document.getElementById('trSource').value;
    const tgt = document.getElementById('trTarget');
    const prev = tgt.value;
    tgt.innerHTML = FinUtils.accountOptions(prev !== src ? prev : undefined, a => a.account_id !== src);
}

function accCurrency(selectId) {
    const sel = document.getElementById(selectId);
    return sel.selectedOptions[0]?.dataset?.currency || '';
}

function updateTransferCurrency() {
    const differ = accCurrency('trSource') !== accCurrency('trTarget');
    document.getElementById('trTargetAmountWrap').classList.toggle('hidden', !differ);
    document.getElementById('trTargetAmount').required = differ;
}

// Живое резюме перевода: «₹ 5 000 · Касса → Ашиш» (снимает страх ошибки)
function updateTransferRecap() {
    const el = document.getElementById('trRecap');
    if (!el) return;
    const amount = Number(document.getElementById('trAmount').value);
    const src = document.getElementById('trSource').selectedOptions[0];
    const tgt = document.getElementById('trTarget').selectedOptions[0];
    if (!amount || !src || !tgt) { el.textContent = ''; return; }
    const name = o => (o.textContent || '').replace(/\s*\(.*\)\s*$/, '');
    el.textContent = `${FinUtils.fmtMoney(amount, src.dataset.currency)} · ${name(src)} → ${name(tgt)}`;
}

async function submitTransfer(ev) {
    ev.preventDefault();
    const source = document.getElementById('trSource').value;
    const target = document.getElementById('trTarget').value;
    if (!target || source === target) {
        Layout.showNotification(t('fin_same_account_error'), 'error');
        return;
    }
    const differ = accCurrency('trSource') !== accCurrency('trTarget');
    const res = await FinUtils.rpc('fin_create_transfer', {
        request_id: requestIds.transfer,
        occurred_on: document.getElementById('trDate').value,
        source_account_id: source,
        target_account_id: target,
        source_amount: document.getElementById('trAmount').value,
        target_amount: differ ? document.getElementById('trTargetAmount').value : null,
        comment: document.getElementById('trComment').value || null
    });
    if (FinUtils.handleResult(res)) {
        requestIds.transfer = null;
        document.getElementById('transferModal').close();
        highlightNext = true;
        await FinUtils.reloadAccounts();
        await loadTable();
    }
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_dds', itemId: 'fin_dds' });
    await FinUtils.loadRefs();
    buildFilters();

    document.getElementById('expenseForm').addEventListener('submit', FinUtils.lockedSubmit(submitExpense));
    document.getElementById('incomeForm').addEventListener('submit', FinUtils.lockedSubmit(submitIncome));
    document.getElementById('transferForm').addEventListener('submit', FinUtils.lockedSubmit(submitTransfer));
    document.getElementById('reversalForm').addEventListener('submit', FinUtils.lockedSubmit(submitReversal));
    document.getElementById('analyticsForm').addEventListener('submit', FinUtils.lockedSubmit(submitAnalytics));
    document.getElementById('revNewDate').addEventListener('change', ev =>
        document.getElementById('revDateWrap').classList.toggle('hidden', !ev.target.checked));
    document.addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) FinUtils.openAttachment(att.dataset.attachmentPath);
    });
    document.getElementById('incIsDonation').addEventListener('change', updateIncomeCategoryList);
    document.getElementById('trSource').addEventListener('change', () => { rebuildTransferTarget(); updateTransferCurrency(); updateTransferRecap(); });
    document.getElementById('trTarget').addEventListener('change', () => { updateTransferCurrency(); updateTransferRecap(); });
    document.getElementById('trAmount').addEventListener('input', updateTransferRecap);
    document.getElementById('expenseModal').addEventListener('input', updateExpenseRecap);
    document.getElementById('expenseModal').addEventListener('change', updateExpenseRecap);
    FinUtils.attachPersonSearch(document.getElementById('incDonorSearch'), document.getElementById('incDonorId'));

    // Esc не должен молча терять введённые данные
    const guardDialog = (dlgId, isDirty) => document.getElementById(dlgId).addEventListener('cancel', ev => {
        if (isDirty() && !confirm(t('fin_confirm_discard'))) ev.preventDefault();
    });
    guardDialog('expenseModal', () => [...document.querySelectorAll('#expRows .exp-amount')].some(i => i.value));
    guardDialog('incomeModal', () => !!document.getElementById('incAmount').value);
    guardDialog('transferModal', () => !!document.getElementById('trAmount').value);

    const ddsBody = document.getElementById('ddsBody');
    ddsBody.addEventListener('click', ev => {
        const row = ev.target.closest('tr[data-op]');
        if (row) toggleDetails(row.dataset.op);
    });
    // Enter/Space на строке — разворот (клавиатурная навигация)
    ddsBody.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const row = ev.target.closest('tr[data-op]');
        if (row) { ev.preventDefault(); toggleDetails(row.dataset.op); }
    });

    await loadTable();

    // Переход со страницы «Счета»: ?action=transfer&source=<id>
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'transfer') openTransfer(params.get('source') || undefined);
}

window.FinDds = { openExpense, openIncome, openTransfer, addExpenseRow, openReversal, openAnalytics, attachFile, updateRecap: updateExpenseRecap };
init();
})();
