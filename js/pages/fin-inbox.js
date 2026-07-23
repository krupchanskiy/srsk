// ==================== ФИНАНСЫ: ВХОДЯЩИЕ ====================
// Согласование операций департаментов: pending → approved/disputed.
// Инвариант 4: согласование не влияет на деньги; disputed требует причины.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let currentTab = 'pending';
let opsById = {};

async function loadUnpostedCount() {
    // Платежи, подтверждённые в CRM, но не разнесённые в финмодуль
    const { count } = await Layout.db.from('fin_v_unposted_crm_payments')
        .select('*', { count: 'exact', head: true });
    const el = document.getElementById('unpostedTabCount');
    el.textContent = count || 0;
    el.classList.toggle('badge-error', (count || 0) > 0);
    el.classList.toggle('badge-ghost', (count || 0) === 0);
}

async function loadCounts() {
    const { data } = await Layout.db.from('fin_v_operations')
        .select('operation_id, approval')
        .in('approval', ['pending', 'disputed']);
    const pending = (data || []).filter(o => o.approval === 'pending').length;
    const disputed = (data || []).filter(o => o.approval === 'disputed').length;
    document.getElementById('pendingTabCount').textContent = pending;
    document.getElementById('disputedTabCount').textContent = disputed;
    await loadUnpostedCount();
}

// Карточка неразнесённого платежа: сумма, дата, причина сбоя, ссылка на сделку.
// Действия нет — платёж чинится либо в CRM (сменить счёт/валюту), либо
// перезаходом подтверждения; здесь только видимость проблемы.
function unpostedCardHtml(p) {
    return `
    <div class="card bg-base-100 shadow-sm border-l-4 border-error">
        <div class="card-body py-4">
            <div class="flex flex-wrap items-center gap-3">
                <span class="whitespace-nowrap opacity-70">${DateUtils.formatShort(DateUtils.parseDate((p.received_at || '').slice(0,10)))}</span>
                <span class="font-mono font-semibold">${FinUtils.fmtMoney(p.amount, p.currency)}</span>
                <span class="badge badge-ghost badge-sm">${e(p.payment_method || '—')}</span>
                <span class="text-error truncate max-w-md">${e(p.last_error_message || p.last_error_code || '')}</span>
                <a href="../crm/deal.html?id=${p.deal_id}" class="btn btn-ghost btn-sm ml-auto">${t('fin_open_deal')}</a>
            </div>
        </div>
    </div>`;
}

function opCardHtml(op) {
    const isPending = op.approval === 'pending';
    return `
    <div class="card bg-base-100 shadow-sm cursor-pointer" data-op="${op.operation_id}" tabindex="0" title="${t('fin_expand_details')}">
        <div class="card-body py-4">
            <div class="flex flex-wrap items-center gap-3">
                <span class="whitespace-nowrap opacity-70">${DateUtils.formatShort(DateUtils.parseDate(op.occurred_on))}</span>
                <span class="font-medium">${e(FinUtils.typeLabel(op.type))}</span>
                <span class="font-mono font-semibold">${FinUtils.fmtAmountsByCurrencyColored(op.amounts_by_currency)}</span>
                ${op.has_attachments ? `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4 opacity-60"><path stroke-linecap="round" stroke-linejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13"/></svg>` : ''}
                <span class="opacity-60 truncate max-w-md">${e([op.payer_name, op.comment].filter(Boolean).join(' · '))}</span>
                <div class="ml-auto flex gap-2">
                    <button class="btn btn-success btn-sm" data-action="approve" data-expected="${op.approval}">${t('fin_approve')}</button>
                    ${isPending
                        ? `<button class="btn btn-outline btn-error btn-sm" data-action="dispute" data-expected="pending">${t('fin_dispute')}</button>`
                        : `<button class="btn btn-outline btn-sm" data-action="repending" data-expected="disputed">${t('fin_return_pending')}</button>`}
                    <button class="btn btn-ghost btn-sm text-error" data-action="reverse">${t('fin_reverse')}</button>
                </div>
            </div>
            ${op.approval === 'disputed' && op.reason ? `<div class="text-sm text-error mt-1">${t('fin_dispute_reason')}: ${e(op.reason)}</div>` : ''}
            <div class="details-slot hidden mt-2 border-t border-base-200 pt-2 text-sm"></div>
        </div>
    </div>`;
}

async function loadList() {
    const list = document.getElementById('inboxList');
    list.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;

    if (currentTab === 'unposted') {
        const { data, error } = await Layout.db.from('fin_v_unposted_crm_payments')
            .select('*').order('received_at', { ascending: false }).limit(200);
        if (error) { Layout.handleError(error, 'Входящие'); return; }
        if (!data?.length) {
            const icon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mx-auto"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
            list.innerHTML = `<div class="text-center py-14">
                <div class="fin-icon-chip mx-auto mb-3" style="width:3.5rem;height:3.5rem">${icon}</div>
                <div class="opacity-70">${t('fin_no_unposted')}</div>
            </div>`;
            await loadCounts();
            return;
        }
        list.innerHTML = data.map(unpostedCardHtml).join('');
        await loadCounts();
        return;
    }

    const { data, error } = await Layout.db.from('fin_v_operations')
        .select('*')
        .eq('approval', currentTab)
        .order('created_at', { ascending: false })
        .limit(200);
    if (error) { Layout.handleError(error, 'Входящие'); return; }
    opsById = Object.fromEntries((data || []).map(op => [op.operation_id, op]));
    if (!data?.length) {
        // Пустое «Входящих» — хорошая новость: всё согласовано
        const icon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mx-auto"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
        list.innerHTML = `<div class="text-center py-14">
            <div class="fin-icon-chip mx-auto mb-3" style="width:3.5rem;height:3.5rem">${icon}</div>
            <div class="opacity-70">${t(currentTab === 'pending' ? 'fin_no_pending' : 'fin_no_disputed')}</div>
        </div>`;
        await loadCounts();
        return;
    }
    list.innerHTML = data.map(opCardHtml).join('');
    await loadCounts();
}

// Разворот: проводки + вложения
async function toggleDetails(card, opId) {
    const slot = card.querySelector('.details-slot');
    if (!slot.classList.contains('hidden')) { slot.classList.add('hidden'); return; }
    slot.classList.remove('hidden');
    slot.innerHTML = `<span class="loading loading-spinner loading-sm"></span>`;
    const [{ data: postings }, { data: atts }] = await Promise.all([
        Layout.db.from('fin_v_account_ledger').select('*').eq('operation_id', opId).order('ledger_seq'),
        Layout.db.from('fin_v_attachments').select('*').eq('parent_type', 'operation').eq('parent_id', opId)
    ]);
    slot.innerHTML = (postings || []).map(p => `
        <div class="flex flex-wrap gap-3 py-0.5">
            <span class="font-medium">${e(p.account_name)}</span>
            <span class="font-mono ${Number(p.signed_amount) < 0 ? 'text-error' : 'text-success'}">${FinUtils.fmtMoney(p.signed_amount, p.currency_code)}</span>
            ${p.category_name ? `<span class="opacity-70">${e(p.category_name)}</span>` : ''}
            ${p.cost_center_name ? `<span class="badge badge-ghost badge-sm">${e(p.cost_center_name)}</span>` : ''}
            ${p.object_name ? `<span class="opacity-70">${e(p.object_name)}</span>` : ''}
            ${p.contractor_name ? `<span class="opacity-70">${e(p.contractor_name)}</span>` : ''}
        </div>`).join('') + FinUtils.attachmentsHtml(atts || []);
}

async function setApproval(opId, expected, target, reason) {
    const res = await FinUtils.rpc('fin_set_approval', {
        operation_id: opId,
        expected_approval: expected,
        target_approval: target,
        reason: reason || null,
        audit_request_id: FinUtils.newRequestId()
    });
    if (FinUtils.handleResult(res)) await loadList();
    else if (res?.error?.code === 'approval_state_conflict') await loadList();
}

function openDispute(opId) {
    const op = opsById[opId];
    document.getElementById('disputeOpId').value = opId;
    document.getElementById('disputeExpected').value = op.approval;
    document.getElementById('disputeInfo').textContent =
        `${FinUtils.typeLabel(op.type)} · ${FinUtils.fmtAmountsByCurrency(op.amounts_by_currency)}`;
    document.getElementById('disputeReason').value = '';
    document.getElementById('disputeModal').showModal();
}

async function submitDispute(ev) {
    ev.preventDefault();
    await setApproval(
        document.getElementById('disputeOpId').value,
        document.getElementById('disputeExpected').value,
        'disputed',
        document.getElementById('disputeReason').value
    );
    document.getElementById('disputeModal').close();
}

function openReversal(opId) {
    const op = opsById[opId];
    document.getElementById('revOpId').value = opId;
    document.getElementById('revInfo').textContent =
        `${FinUtils.typeLabel(op.type)} · ${DateUtils.formatShort(DateUtils.parseDate(op.occurred_on))} · ${FinUtils.fmtAmountsByCurrency(op.amounts_by_currency)}`;
    document.getElementById('revReason').value = '';
    document.getElementById('reversalModal').showModal();
}

async function submitReversal(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_create_reversal', {
        request_id: FinUtils.newRequestId(),
        original_operation_id: document.getElementById('revOpId').value,
        occurred_on_policy: 'same_as_original',
        occurred_on: null,
        reason: document.getElementById('revReason').value
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('reversalModal').close();
        await loadList();
    }
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_inbox', itemId: 'fin_inbox' });
    await FinUtils.loadRefs();

    document.querySelectorAll('[data-tab]').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('tab-active'));
            tab.classList.add('tab-active');
            currentTab = tab.dataset.tab;
            loadList();
        }));

    document.getElementById('disputeForm').addEventListener('submit', submitDispute);
    document.getElementById('reversalForm').addEventListener('submit', submitReversal);

    document.getElementById('inboxList').addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) { FinUtils.openAttachment(att.dataset.attachmentPath); return; }
        const btn = ev.target.closest('[data-action]');
        const card = ev.target.closest('[data-op]');
        if (!card) return;
        const opId = card.dataset.op;
        if (!btn) { toggleDetails(card, opId); return; }
        switch (btn.dataset.action) {
            case 'approve': setApproval(opId, btn.dataset.expected, 'approved'); break;
            case 'repending': setApproval(opId, btn.dataset.expected, 'pending'); break;
            case 'dispute': openDispute(opId); break;
            case 'reverse': openReversal(opId); break;
        }
    });
    // Enter/Space на карточке — разворот (не перехватываем фокус на кнопках)
    document.getElementById('inboxList').addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.target.closest('[data-action]')) return;
        const card = ev.target.closest('[data-op]');
        if (card) { ev.preventDefault(); toggleDetails(card, card.dataset.op); }
    });

    const params = new URLSearchParams(window.location.search);
    if (params.get('tab') === 'disputed') {
        document.querySelector('[data-tab="disputed"]').classList.add('tab-active');
        document.querySelector('[data-tab="pending"]').classList.remove('tab-active');
        currentTab = 'disputed';
    }
    await loadList();
}

init();
})();
