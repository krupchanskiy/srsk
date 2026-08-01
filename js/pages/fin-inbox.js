// ==================== ФИНАНСЫ: ВХОДЯЩИЕ ====================
// Согласование операций департаментов: pending → approved/disputed.
// Инвариант 4: согласование не влияет на деньги; disputed требует причины.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

let currentTab = 'pending';
let opsById = {};
let chatDrafts = [];   // заявки из чатов текущей выдачи — нужны модалке статей
let departments = [];  // справочник для выбора департамента-получателя

async function loadUnpostedCount() {
    // Платежи, подтверждённые в CRM, но не разнесённые в финмодуль
    const { count } = await Layout.db.from('fin_v_unposted_crm_payments')
        .select('*', { count: 'exact', head: true });
    const el = document.getElementById('unpostedTabCount');
    el.textContent = count || 0;
    el.classList.toggle('badge-error', (count || 0) > 0);
    el.classList.toggle('badge-ghost', (count || 0) === 0);
}

async function loadChatDraftsCount() {
    // Заявки из чатов департаментов, ждущие проведения
    const { count } = await Layout.db.from('fin_v_chat_drafts')
        .select('*', { count: 'exact', head: true });
    const el = document.getElementById('chatDraftsTabCount');
    el.textContent = count || 0;
    el.classList.toggle('badge-warning', (count || 0) > 0);
    el.classList.toggle('badge-ghost', (count || 0) === 0);
}

async function loadUnfinishedCount() {
    const { count } = await Layout.db.from('fin_v_chat_drafts_unfinished')
        .select('*', { count: 'exact', head: true });
    const el = document.getElementById('unfinishedTabCount');
    if (!el) return;
    el.textContent = count || 0;
    el.classList.toggle('badge-warning', (count || 0) > 0);
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
    await loadChatDraftsCount();
    await loadUnfinishedCount();
}

// Заявка, на которой диалог с ботом оборвался. Действие тут не за казначеем,
// поэтому кнопок проведения нет — только видно, кому напомнить и чего не хватает.
function unfinishedCardHtml(d) {
    return `
    <div class="card bg-base-100 shadow-sm border-l-4 border-base-300">
        <div class="card-body py-3">
            <div class="flex flex-wrap items-center gap-3">
                <span class="badge badge-ghost badge-sm">${e(d.department)}</span>
                <span class="font-mono font-semibold">${FinUtils.fmtMoney(d.amount, d.currency || 'INR')}</span>
                ${d.purpose ? `<span class="truncate max-w-md">${e(d.purpose)}</span>` : ''}
                <span class="badge badge-warning badge-sm">${t('fin_unfinished_' + d.missing)}</span>
                <span class="ml-auto text-xs opacity-60">${t('fin_unfinished_days')}: ${d.days_waiting}</span>
            </div>
            <div class="text-xs opacity-60 mt-1">${e([d.author, d.raw_text].filter(Boolean).join(' · '))}</div>
        </div>
    </div>`;
}

// Карточка заявки из чата департамента: тип, сумма, автор, исходный текст.
// «Провести» создаёт настоящий расход/перевод; «Отклонить» закрывает заявку.
function chatDraftCardHtml(d) {
    const isTransfer = d.kind === 'transfer';
    const head = isTransfer
        ? `${t('fin_chat_transfer')} → ${e(d.target_department || '—')}`
        : t('fin_chat_expense');
    return `
    <div class="card bg-base-100 shadow-sm border-l-4 border-warning" data-draft="${d.id}">
        <div class="card-body py-4">
            <div class="flex flex-wrap items-center gap-3">
                <span class="badge badge-ghost badge-sm">${e(d.department)}</span>
                <span class="font-medium">${e(head)}</span>
                <span class="font-mono font-semibold">${FinUtils.fmtMoney(d.amount, d.currency)}</span>
                ${d.category ? `<span class="badge badge-outline badge-sm">${e(d.category)}</span>` : ''}
                ${d.source_account ? `<span class="badge badge-outline badge-sm">${t('fin_from')}: ${e(d.source_account)}</span>` : ''}
                ${d.purpose ? `<span class="truncate max-w-md">${e(d.purpose)}</span>` : ''}
                <div class="ml-auto flex gap-2">
                    ${isTransfer
                      ? `<button class="btn btn-outline btn-sm" data-action="refine-draft">${t('fin_refine')}</button>`
                      : `<button class="btn btn-outline btn-sm" data-action="split-draft">${t('fin_split')}</button>`}
                    <button class="btn btn-success btn-sm" data-action="post-draft">${t('fin_post_draft')}</button>
                    <button class="btn btn-ghost btn-sm" data-action="dismiss-draft">${t('fin_dismiss_draft')}</button>
                </div>
            </div>
            <div class="text-xs opacity-60 mt-1">${e([d.author, d.raw_text].filter(Boolean).join(' · '))}</div>
        </div>
    </div>`;
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

    if (currentTab === 'chat_drafts') {
        const { data, error } = await Layout.db.from('fin_v_chat_drafts')
            .select('*').order('created_at', { ascending: true }).limit(200);
        if (error) { Layout.handleError(error, 'Входящие'); return; }
        chatDrafts = data || [];   // модалка статей берёт заявку отсюда
        if (!data?.length) {
            const icon = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mx-auto"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
            list.innerHTML = `<div class="text-center py-14">
                <div class="fin-icon-chip mx-auto mb-3" style="width:3.5rem;height:3.5rem">${icon}</div>
                <div class="opacity-70">${t('fin_no_chat_drafts')}</div>
            </div>`;
            await loadCounts();
            return;
        }
        list.innerHTML = data.map(chatDraftCardHtml).join('');
        await loadCounts();
        return;
    }

    // Бот спросил — человек не ответил. Такие заявки не ждут казначея, они ждут
    // автора, но раньше их не видел никто: в «Входящих» показывались только pending.
    if (currentTab === 'unfinished') {
        const { data, error } = await Layout.db.from('fin_v_chat_drafts_unfinished')
            .select('*').order('days_waiting', { ascending: false }).limit(200);
        if (error) { Layout.handleError(error, 'Входящие'); return; }
        list.innerHTML = data?.length
            ? data.map(unfinishedCardHtml).join('')
            : `<div class="text-center py-14 opacity-70">${t('fin_no_unfinished')}</div>`;
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

// Провести заявку из чата: fin-админ создаёт настоящий расход/перевод,
// на исходное сообщение в чате бот ставит 👍
async function postDraft(id) {
    const { data, error } = await Layout.db.rpc('tg_post_draft', { p_id: id });
    if (error) { Layout.handleError(error, t('fin_post_draft')); return; }
    if (data?.ok) { Layout.showNotification(t('fin_saved'), 'success'); await loadList(); }
    else Layout.showNotification(data?.error || t('error'), 'error');
}

// ==================== СТАТЬИ ЗАЯВКИ (замечание ВГ, 26.07.2026) ====================
// Одна строка с другой статьёй — «поменять статью», несколько — «разбить чек».
// Отдельной правки статьи нет намеренно: два пути к одному результату только
// путают. Сумма строк обязана сойтись с суммой заявки — иначе в учёт попадёт
// не то, что человек написал в чате, и расхождение всплывёт только на сверке.
let splitDraft = null;

function outCategoryOptions(selected) {
    return FinUtils.refs.categories
        .filter(c => c.is_active && c.direction === 'out')
        .map(c => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${e(c.name)}</option>`)
        .join('');
}

// Департаменты, кроме автора заявки: передавать самому себе нечего, сервер
// такую строку и не примет.
function deptOptions() {
    return `<option value="">${t('fin_split_dept_own')}</option>` + departments
        .filter(d => d.id !== splitDraft?.department_id)
        .map(d => `<option value="${d.id}">${e(d.name)}</option>`)
        .join('');
}

function splitRowHtml(amount, categoryId, objectId) {
    return `<div class="flex flex-col gap-1 border-b border-base-200 pb-2" data-split-row>
        <div class="flex items-center gap-2">
            <input type="number" class="input input-bordered input-sm w-28 font-mono" step="0.01" min="0.01"
                   value="${amount ?? ''}" data-split-amount>
            <select class="select select-bordered select-sm flex-1" data-split-cat>${outCategoryOptions(categoryId)}</select>
            <select class="select select-bordered select-sm flex-1" data-split-object>${FinUtils.objectOptions(objectId)}</select>
            <button type="button" class="btn btn-ghost btn-sm text-error" data-split-remove
                    aria-label="${t('delete')}">✕</button>
        </div>
        <div class="flex items-center gap-2 pl-1">
            <select class="select select-bordered select-sm flex-1" data-split-dept
                    title="${t('fin_split_dept_hint')}">${deptOptions()}</select>
            <label class="label cursor-pointer gap-2 hidden" data-split-expense-box>
                <input type="checkbox" class="checkbox checkbox-sm" checked data-split-as-expense>
                <span class="label-text text-sm">${t('fin_split_as_expense')}</span>
            </label>
        </div>
        <div class="text-xs text-warning hidden" data-split-warn>⚠️ ${t('fin_split_no_expense_warn')}</div>
    </div>`;
}

// Департамент выбран — показываем галочку; галочка снята — говорим, чем это
// обернётся: у получателя повиснет остаток, которого нет в кассе.
function syncRowState(row) {
    const dept = row.querySelector('[data-split-dept]').value;
    const box = row.querySelector('[data-split-expense-box]');
    const asExpense = row.querySelector('[data-split-as-expense]');
    box.classList.toggle('hidden', !dept);
    row.querySelector('[data-split-warn]').classList.toggle('hidden', !dept || asExpense.checked);
}

// Делим поровну в целых рупиях, остаток отдаём последней строке: иначе на
// 1000/3 сумма строк не сойдётся с заявкой и сервер откажет (правило ВГ:
// «копейки можно округлять до целых, главное чтобы сошлась итоговая сумма»).
function splitEvenly() {
    const rows = [...document.querySelectorAll('[data-split-row]')];
    if (!rows.length) return;
    const total = Math.round(Number(splitDraft.amount));
    const base = Math.floor(total / rows.length);
    rows.forEach((r, i) => {
        const amount = i === rows.length - 1 ? total - base * (rows.length - 1) : base;
        r.querySelector('[data-split-amount]').value = amount;
    });
    renderRemainder();
}

function renderRemainder() {
    const total = Number(splitDraft.amount);
    const sum = [...document.querySelectorAll('[data-split-amount]')]
        .reduce((acc, i) => acc + (Number(i.value) || 0), 0);
    const left = Math.round((total - sum) * 100) / 100;
    const el = document.getElementById('splitRemainder');
    const ok = left === 0;
    el.innerHTML = ok
        ? `<span class="text-success">${t('fin_split_ok')}</span>`
        : `<span class="text-error">${t('fin_split_left')}: ${FinUtils.fmtMoney(left, splitDraft.currency)}</span>`;
    document.getElementById('splitSubmit').disabled = !ok;
}

function openSplit(id) {
    splitDraft = chatDrafts.find(d => d.id === id);
    if (!splitDraft) return;
    document.getElementById('splitDraftId').value = id;
    document.getElementById('splitInfo').textContent =
        `${FinUtils.fmtMoney(splitDraft.amount, splitDraft.currency)} · ${splitDraft.purpose || splitDraft.raw_text || ''}`;
    // Стартуем с одной строки на всю сумму: самый частый случай — просто
    // поправить статью, а не делить.
    document.getElementById('splitRows').innerHTML =
        splitRowHtml(splitDraft.amount, splitDraft.category_id || null);
    renderRemainder();
    document.getElementById('splitModal').showModal();
}

async function submitSplit(ev) {
    ev.preventDefault();
    const rows = [...document.querySelectorAll('[data-split-row]')].map(r => {
        const dept = r.querySelector('[data-split-dept]').value || null;
        return {
            amount: Number(r.querySelector('[data-split-amount]').value),
            category_id: r.querySelector('[data-split-cat]').value,
            object_id: r.querySelector('[data-split-object]').value || null,
            department_id: dept,
            as_expense: dept ? r.querySelector('[data-split-as-expense]').checked : null
        };
    });
    const { data, error } = await Layout.db.rpc('tg_post_draft', {
        p_id: document.getElementById('splitDraftId').value, p_rows: rows
    });
    if (error) { Layout.handleError(error, t('fin_post_draft')); return; }
    if (data?.ok) {
        document.getElementById('splitModal').close();
        Layout.showNotification(t('fin_saved'), 'success');
        await loadList();
    } else Layout.showNotification(data?.error || t('error'), 'error');
}

// ==================== УТОЧНЕНИЕ ВЫДАЧИ (замечание ВГ, 01.08.2026) ====================
// Бот угадывает получателя по тексту сообщения и ошибается. Раньше при ошибке
// заявку оставалось только отклонить и просить переписать; теперь получателя и
// счёт-источник правит казначей. Сумма и текст заявки неприкосновенны.
let refineDraft = null;

function openRefine(id) {
    refineDraft = chatDrafts.find(d => d.id === id);
    if (!refineDraft) return;
    document.getElementById('refineDraftId').value = id;
    document.getElementById('refineInfo').textContent =
        `${FinUtils.fmtMoney(refineDraft.amount, refineDraft.currency)} · ${refineDraft.raw_text || ''}`;
    document.getElementById('refineTarget').innerHTML =
        `<option value="">—</option>` + departments
            .filter(d => d.id !== refineDraft.department_id)
            .map(d => `<option value="${d.id}" ${d.id === refineDraft.target_department_id ? 'selected' : ''}>${e(d.name)}</option>`)
            .join('');
    // счета только в валюте заявки: иначе сервер откажет уже после нажатия
    document.getElementById('refineSource').innerHTML =
        `<option value="">${t('fin_split_dept_own')}</option>` +
        FinUtils.accountOptions(refineDraft.source_account_id,
                                a => a.currency_code === refineDraft.currency);
    document.getElementById('refineModal').showModal();
}

async function submitRefine(ev) {
    ev.preventDefault();
    const { data, error } = await Layout.db.rpc('tg_refine_draft', {
        p_id: document.getElementById('refineDraftId').value,
        p_target_department: document.getElementById('refineTarget').value || null,
        p_source_account: document.getElementById('refineSource').value || null
    });
    if (error) { Layout.handleError(error, t('fin_refine')); return; }
    if (data?.ok) {
        document.getElementById('refineModal').close();
        Layout.showNotification(t('fin_saved'), 'success');
        await loadList();
    } else Layout.showNotification(data?.error || t('error'), 'error');
}

async function dismissDraft(id) {
    // Автор заявки увидит отказ в своём чате, поэтому спрашиваем причину: без неё
    // человек не поймёт, переписать заявку или деньги уже учли иначе.
    // Запасной текст на случай, если кэш переводов ещё не обновился.
    const label = Layout.translations?.['fin_dismiss_reason_prompt']
        ? t('fin_dismiss_reason_prompt')
        : 'Причина отказа (необязательно) — её увидит автор в чате';
    const reason = prompt(label);
    if (reason === null) return;   // передумал

    const { data, error } = await Layout.db.rpc('tg_dismiss_draft', { p_id: id, p_reason: reason || null });
    if (error) { Layout.handleError(error, t('fin_dismiss_draft')); return; }
    if (data?.ok) await loadList();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_inbox', itemId: 'fin_inbox' });
    await FinUtils.loadRefs();

    const { data: depts } = await Layout.db.from('fin_v_departments').select('id, name').order('name');
    departments = depts || [];

    document.querySelectorAll('[data-tab]').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('tab-active'));
            tab.classList.add('tab-active');
            currentTab = tab.dataset.tab;
            loadList();
        }));

    document.getElementById('disputeForm').addEventListener('submit', submitDispute);
    document.getElementById('splitForm').addEventListener('submit', submitSplit);
    document.getElementById('refineForm').addEventListener('submit', submitRefine);
    document.getElementById('splitEven').addEventListener('click', splitEvenly);
    document.getElementById('splitAddRow').addEventListener('click', () => {
        document.getElementById('splitRows').insertAdjacentHTML('beforeend', splitRowHtml(null, null));
        renderRemainder();
    });
    document.getElementById('splitRows').addEventListener('input', renderRemainder);
    document.getElementById('splitRows').addEventListener('change', ev => {
        const row = ev.target.closest('[data-split-row]');
        if (row) syncRowState(row);
    });
    document.getElementById('splitRows').addEventListener('click', ev => {
        const rm = ev.target.closest('[data-split-remove]');
        if (!rm) return;
        // последнюю строку не удаляем: пустой список нечего проводить
        if (document.querySelectorAll('[data-split-row]').length > 1) rm.closest('[data-split-row]').remove();
        renderRemainder();
    });
    document.getElementById('reversalForm').addEventListener('submit', submitReversal);

    document.getElementById('inboxList').addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) { FinUtils.openAttachment(att.dataset.attachmentPath); return; }
        const btn = ev.target.closest('[data-action]');
        // Заявки из чатов — своя карточка (data-draft), без разворота деталей
        const draftCard = ev.target.closest('[data-draft]');
        if (draftCard && btn) {
            const id = draftCard.dataset.draft;
            if (btn.dataset.action === 'post-draft') postDraft(id);
            else if (btn.dataset.action === 'split-draft') openSplit(id);
            else if (btn.dataset.action === 'refine-draft') openRefine(id);
            else if (btn.dataset.action === 'dismiss-draft') dismissDraft(id);
            return;
        }
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

    // Раньше распознавался только ?tab=disputed, поэтому ссылка ?tab=unposted
    // из сигнальной карточки на главной молча открывала «Не проверено».
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab');
    if (wanted && wanted !== 'pending' && document.querySelector(`[data-tab="${wanted}"]`)) {
        document.querySelector('[data-tab="pending"]').classList.remove('tab-active');
        document.querySelector(`[data-tab="${wanted}"]`).classList.add('tab-active');
        currentTab = wanted;
    }
    await loadList();
}

init();
})();
