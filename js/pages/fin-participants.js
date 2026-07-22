// ==================== ФИНАНСЫ: УЧАСТНИКИ ====================
// Балансы участников ретрита (fin_list_retreat_participants), карточка
// с 5 блоками, начисления (батч), платежи по блокам, возвраты, отмена.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

const BLOCKS = ['org_fee', 'accommodation', 'meals', 'extra'];
const CHARGE_KINDS = ['org_fee', 'accommodation', 'meals', 'extra'];
const PAY_KINDS = ['org_fee', 'accommodation', 'meals', 'extra', 'general'];

let retreats = [];
let currentRetreat = null;
let currentObjectId = null;      // учётный объект текущего ретрита (для платежей)
let participants = [];           // [{participant_id, name, balance}]
let card = { id: null, name: '', payments: [] };
// request_id живёт от открытия формы до успешного сохранения
const requestIds = { payment: null, refund: null };

function blockLabel(kind) {
    return t('fin_block_' + kind);
}

function fmtNet(n) {
    const v = Number(n) || 0;
    const s = FinUtils.fmtMoney(Math.abs(v), 'INR');
    if (v > 0) return `<span class="text-error font-mono">${s}</span>`;
    if (v < 0) return `<span class="text-success font-mono">−${s}</span>`;
    return `<span class="font-mono opacity-40">—</span>`;
}

// ==================== СПИСОК ====================
async function loadRetreats() {
    const { data, error } = await Layout.db.from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date')
        .order('start_date', { ascending: false });
    if (error) { Layout.handleError(error, 'Ретриты'); return; }
    retreats = data || [];
    const sel = document.getElementById('retreatSelect');
    sel.innerHTML = `<option value="">${t('fin_select_retreat')}</option>` +
        retreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('');
    sel.addEventListener('change', () => selectRetreat(sel.value || null));
}

async function selectRetreat(retreatId) {
    currentRetreat = retreatId;
    currentObjectId = null;
    if (!retreatId) {
        // пустое состояние ведёт к действию, а не просто констатирует
        document.getElementById('participantsBody').innerHTML =
            `<tr><td colspan="7" class="text-center py-8">
                <button type="button" class="btn btn-ghost" onclick="document.getElementById('retreatSelect').focus()">
                    ↑ ${e(t('fin_select_retreat_hint'))}
                </button>
            </td></tr>`;
        return;
    }
    const url = new URL(window.location);
    url.searchParams.set('retreat', retreatId);
    history.replaceState(null, '', url);
    await loadParticipants();
}

let pFilter = 'all';                       // all | debt | advance
let pSort = { key: 'net', dir: 'desc' };   // сортировка по итогу (крупнейшие долги сверху)

async function loadParticipants() {
    const body = document.getElementById('participantsBody');
    body.innerHTML = `<tr><td colspan="7" class="text-center py-8"><span class="loading loading-spinner loading-md"></span></td></tr>`;
    const { data, error } = await Layout.db.rpc('fin_list_retreat_participants', { p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Участники'); return; }
    if (!data?.ok) {
        Layout.showNotification(data?.error?.message || 'Ошибка', 'error');
        return;
    }
    participants = data.result || [];
    const toolbar = document.getElementById('participantsToolbar');
    if (toolbar) toolbar.style.display = participants.length ? '' : 'none';
    renderParticipants();
}

// Рендер с учётом поиска по имени, фильтр-чипов (все/должники/авансы) и сортировки
function renderParticipants() {
    const body = document.getElementById('participantsBody');
    if (!participants.length) {
        body.innerHTML = `<tr><td colspan="7" class="text-center py-6 opacity-60">${t('fin_no_participants')}</td></tr>`;
        renderParticipantsSummary();
        return;
    }
    const query = (document.getElementById('pSearch')?.value || '').trim().toLowerCase();
    let list = participants.filter(p => {
        const net = Number(p.balance.net) || 0;
        if (pFilter === 'debt' && net <= 0) return false;
        if (pFilter === 'advance' && net >= 0) return false;
        if (query && !(p.name || '').toLowerCase().includes(query)) return false;
        return true;
    });
    list.sort((a, b) => {
        if (pSort.key === 'name') return (a.name || '').localeCompare(b.name || '') * (pSort.dir === 'asc' ? 1 : -1);
        return (Number(a.balance.net) - Number(b.balance.net)) * (pSort.dir === 'asc' ? 1 : -1);
    });
    body.innerHTML = list.map(p => {
        const b = p.balance;
        return `<tr class="cursor-pointer hover:bg-base-200" data-pid="${p.participant_id}" tabindex="0">
            <td class="font-medium">${e(p.name || '')}</td>
            ${BLOCKS.map(k => `<td class="text-right">${fmtNet(b.blocks[k].balance)}</td>`).join('')}
            <td class="text-right">${fmtNet(Number(b.general_debt) - Number(b.general_advance))}</td>
            <td class="text-right font-semibold">${fmtNetWord(b.net)}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="7" class="text-center py-6 opacity-60">${t('fin_nothing_found')}</td></tr>`;
    renderParticipantsSummary();
}

// Итог: сколько должников/сумма долгов, сколько с авансом/сумма авансов
function renderParticipantsSummary() {
    const el = document.getElementById('pSummary');
    if (!el) return;
    let debtCount = 0, debtSum = 0, advCount = 0, advSum = 0;
    for (const p of participants) {
        const net = Number(p.balance.net) || 0;
        if (net > 0) { debtCount++; debtSum += net; }
        else if (net < 0) { advCount++; advSum += -net; }
    }
    el.innerHTML =
        `<span class="text-error">${t('fin_debtors')}: ${debtCount} · ${FinUtils.fmtMoney(debtSum, 'INR')}</span>` +
        ` &nbsp;•&nbsp; <span class="text-success">${t('fin_advances')}: ${advCount} · ${FinUtils.fmtMoney(advSum, 'INR')}</span>`;
}

// Итог со словом: «Долг ₹N» / «Аванс ₹N» — знак и цвет не спорят друг с другом
function fmtNetWord(n) {
    const v = Number(n) || 0;
    const s = FinUtils.fmtMoney(Math.abs(v), 'INR');
    if (v > 0) return `<span class="badge badge-error badge-outline whitespace-nowrap font-mono">${t('fin_debt')} ${s}</span>`;
    if (v < 0) return `<span class="badge badge-success badge-outline whitespace-nowrap font-mono">${t('fin_advance')} ${s}</span>`;
    return `<span class="font-mono opacity-40">—</span>`;
}

// ==================== КАРТОЧКА ====================
async function openCard(pid) {
    const p = participants.find(x => x.participant_id === pid);
    if (!p) return;
    card.id = pid;
    card.name = p.name;
    document.getElementById('cardName').textContent = p.name;
    const r = retreats.find(x => x.id === currentRetreat);
    card.retreatName = r ? Layout.getName(r) : '';
    document.getElementById('cardRetreat').textContent = card.retreatName;
    renderCardBlocks(p.balance);
    document.getElementById('cardCharges').innerHTML =
        `<tr><td colspan="6" class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></td></tr>`;
    document.getElementById('cardPayments').innerHTML =
        `<tr><td colspan="7" class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></td></tr>`;
    document.getElementById('cardModal').showModal();
    await Promise.all([loadCardCharges(), loadCardPayments()]);
}

function renderCardBlocks(b) {
    const cell = (title, block) => {
        // Часть долга блока могла быть погашена «Общим» платежом (зачёт по
        // приоритету блоков, ТЗ 7) — показываем это явно, иначе «Оплачено 0 /
        // Остаток 0» при активном начислении выглядит как ошибка.
        const fromGeneral = Math.max(0, (Number(block.charged) - Number(block.paid)) - Number(block.balance));
        const balance = Number(block.balance);
        const balanceHtml = balance === 0 && Number(block.charged) > 0
            ? `<span class="font-mono">${FinUtils.fmtMoney(0, 'INR')}</span>`
            : fmtNet(balance);
        return `
        <div class="border border-base-300 rounded-lg p-2">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">${title}</div>
            <div class="text-xs flex justify-between"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(block.charged, 'INR')}</span></div>
            <div class="text-xs flex justify-between"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(block.paid, 'INR')}</span></div>
            ${fromGeneral > 0 ? `<div class="text-xs flex justify-between text-success"><span>${t('fin_from_general')}</span><span class="font-mono">${FinUtils.fmtMoney(fromGeneral, 'INR')}</span></div>` : ''}
            <div class="text-sm flex justify-between mt-1 pt-1 border-t border-base-200"><span>${t('fin_balance')}</span>${balanceHtml}</div>
        </div>`;
    };
    const totalNet = Number(b.net) || 0;
    document.getElementById('cardBlocks').innerHTML =
        BLOCKS.map(k => cell(blockLabel(k), b.blocks[k])).join('') +
        `<div class="border-2 rounded-lg p-2 ${totalNet > 0 ? 'border-error' : totalNet < 0 ? 'border-success' : 'border-base-300'}">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">${t('fin_total')}</div>
            <div class="text-xs flex justify-between"><span>${t('fin_debt')}</span><span class="font-mono">${FinUtils.fmtMoney(b.total_debt, 'INR')}</span></div>
            <div class="text-xs flex justify-between"><span>${t('fin_advance')}</span><span class="font-mono">${FinUtils.fmtMoney(b.total_advance, 'INR')}</span></div>
            <div class="text-sm flex justify-between mt-1 pt-1 border-t border-base-200"><span>${t('fin_total')}</span>${fmtNetWord(totalNet)}</div>
        </div>`;
}

async function loadCardCharges() {
    const { data, error } = await Layout.db.from('fin_v_charges').select('*')
        .eq('participant_id', card.id).eq('retreat_id', currentRetreat)
        .order('created_at');
    if (error) { Layout.handleError(error, 'Начисления'); return; }
    const isAdmin = window.hasPermission?.('fin_admin');
    document.getElementById('cardCharges').innerHTML = (data || []).map(c => `
        <tr class="${c.is_cancelled ? 'opacity-60 line-through' : ''}">
            <td>${e(blockLabel(c.kind))}</td>
            <td>${e(c.description || '')}${c.quantity != 1 ? ` <span class="opacity-70">(${c.quantity} × ${FinUtils.fmtMoney(c.unit_price, 'INR')})</span>` : ''}${c.is_cancelled ? ` <span class="badge badge-ghost badge-xs no-underline">${t('fin_cancelled')}</span>` : ''}${Number(c.discount_amount) > 0 && (c.discount_reason || c.agreed_with) ? `<div class="text-xs opacity-60">${e(c.discount_reason || '')}${c.agreed_with ? ` · ${t('fin_agreed_with').toLowerCase()}: ${e(c.agreed_with)}` : ''}</div>` : ''}</td>
            <td class="text-right font-mono">${FinUtils.fmtMoney(c.amount, 'INR')}</td>
            <td class="text-right font-mono">${Number(c.discount_amount) > 0 ? FinUtils.fmtMoney(c.discount_amount, 'INR') : '—'}</td>
            <td class="text-right font-mono font-semibold">${FinUtils.fmtMoney(c.net_amount, 'INR')}</td>
            <td class="text-right">${!c.is_cancelled && isAdmin ? `<button class="btn btn-ghost btn-xs text-error" data-cancel-charge="${c.id}" data-desc="${e(c.description || blockLabel(c.kind))}" title="${t('fin_cancel_charge')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="6" class="text-center py-3 opacity-60">${t('fin_no_charges')}</td></tr>`;
}

async function loadCardPayments() {
    const { data, error } = await Layout.db.rpc('fin_get_participant_payments', { p_participant: card.id, p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Платежи'); return; }
    card.payments = data || [];
    const isAdmin = window.hasPermission?.('fin_admin');
    const statusBadge = s => ({
        active: '',
        reversed: `<span class="badge badge-ghost badge-xs">${t('fin_reversed_badge')}</span>`,
        refunded_partially: `<span class="badge badge-warning badge-xs">${t('fin_refunded_partially')}</span>`,
        refunded_fully: `<span class="badge badge-neutral badge-xs">${t('fin_refunded_fully')}</span>`
    }[s] || '');
    document.getElementById('cardPayments').innerHTML = card.payments.map(p => `
        <tr class="${p.is_reversed ? 'opacity-60' : ''}">
            <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}</td>
            <td>${e(FinUtils.typeLabel(p.type))}</td>
            <td>${e(blockLabel(p.balance_kind))}</td>
            <td class="text-right font-mono">${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.currency_code !== 'INR' ? ` <span class="opacity-70">₹ ${Number(p.amount_base).toLocaleString('ru-RU')}</span>` : ''}</td>
            <td>${e(FinUtils.channelLabel(p.payment_channel))}</td>
            <td>${statusBadge(p.status)}</td>
            <td class="text-right">${isAdmin && p.type === 'payment' && Number(p.available_to_refund) > 0 ? `<button class="btn btn-ghost btn-xs" data-refund="${p.posting_id}" title="${t('fin_refund')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/></svg>
            </button>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="7" class="text-center py-3 opacity-60">${t('fin_no_payments')}</td></tr>`;
}

async function refreshAfterChange() {
    await loadParticipants();
    if (card.id && document.getElementById('cardModal').open) {
        const p = participants.find(x => x.participant_id === card.id);
        if (p) renderCardBlocks(p.balance);
        await Promise.all([loadCardCharges(), loadCardPayments()]);
    }
}

// ==================== ФОРМА: НАЧИСЛЕНИЯ ====================
function chargeRowHtml(idx) {
    return `
    <div class="border border-base-300 rounded-lg p-3 mb-2 chg-row" data-idx="${idx}">
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div class="form-control relative">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_participant')}</span></label>
                <input type="text" class="input input-bordered input-sm chg-person" autocomplete="off" required>
                <input type="hidden" class="chg-person-id">
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_block')}</span></label>
                <select class="select select-bordered select-sm chg-kind">${CHARGE_KINDS.map(k => `<option value="${k}">${e(blockLabel(k))}</option>`).join('')}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_description')}</span></label>
                <input type="text" class="input input-bordered input-sm chg-desc" required>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs chg-qty-label">${t('fin_quantity')}</span></label>
                <input type="number" class="input input-bordered input-sm chg-qty" value="1" min="0.01" step="any" required>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_unit_price')}</span></label>
                <input type="number" class="input input-bordered input-sm chg-price" min="0" step="0.01" required>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_discount')}</span></label>
                <input type="number" class="input input-bordered input-sm chg-discount" min="0" step="0.01" placeholder="0">
            </div>
            <div class="form-control col-span-2 md:col-span-3 hidden chg-discount-reason-wrap">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <div class="form-control">
                        <label class="label py-0"><span class="label-text text-xs">${t('fin_discount_reason')}</span></label>
                        <input type="text" class="input input-bordered input-sm chg-discount-reason">
                    </div>
                    <div class="form-control">
                        <label class="label py-0"><span class="label-text text-xs">${t('fin_agreed_with')}</span></label>
                        <input type="text" class="input input-bordered input-sm chg-agreed-with">
                    </div>
                </div>
            </div>
        </div>
        <div class="text-right text-sm mt-2 opacity-70 chg-total"></div>
        ${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm text-error mt-1" aria-label="${t('fin_remove_row')}" onclick="this.closest('.chg-row').remove()">${FinUtils.ICONS.x}</button>` : ''}
    </div>`;
}

function wireChargeRow(row) {
    FinUtils.attachPersonSearch(row.querySelector('.chg-person'), row.querySelector('.chg-person-id'));
    row.querySelector('.chg-discount').addEventListener('input', ev => {
        row.querySelector('.chg-discount-reason-wrap').classList.toggle('hidden', !(Number(ev.target.value) > 0));
    });
    // Описание не заставляет придумывать текст: автоподстановка названия блока,
    // пока пользователь не начал печатать своё
    const desc = row.querySelector('.chg-desc');
    const kindSel = row.querySelector('.chg-kind');
    const autofill = () => { if (!desc.dataset.touched) desc.value = blockLabel(kindSel.value); };
    desc.addEventListener('input', () => { desc.dataset.touched = '1'; });
    kindSel.addEventListener('change', autofill);
    autofill();

    // Проживание и питание начисляются за дни — лейбл количества говорит об этом
    // прямо (требование ВГ: при расчёте видеть число дней, а не только сумму)
    const qtyLabel = row.querySelector('.chg-qty-label');
    const relabel = () => {
        qtyLabel.textContent = ['accommodation', 'meals'].includes(kindSel.value)
            ? t('fin_days') : t('fin_quantity');
    };
    kindSel.addEventListener('change', relabel);
    relabel();

    // Живой итог строки: qty × цена − скидка
    const totalEl = row.querySelector('.chg-total');
    const recalc = () => {
        const qty = Number(row.querySelector('.chg-qty').value) || 0;
        const price = Number(row.querySelector('.chg-price').value) || 0;
        const disc = Number(row.querySelector('.chg-discount').value) || 0;
        if (!qty || !price) { totalEl.textContent = ''; return; }
        const total = Math.max(qty * price - disc, 0);
        totalEl.textContent = `${t('fin_row_total')}: ${qty} × ${FinUtils.fmtMoney(price, 'INR')}`
            + (disc > 0 ? ` − ${FinUtils.fmtMoney(disc, 'INR')}` : '')
            + ` = ${FinUtils.fmtMoney(total, 'INR')}`;
    };
    ['.chg-qty', '.chg-price', '.chg-discount'].forEach(sel =>
        row.querySelector(sel).addEventListener('input', recalc));
}

function addChargeRow(presetPerson) {
    const wrap = document.getElementById('chargeRows');
    wrap.insertAdjacentHTML('beforeend', chargeRowHtml(wrap.children.length));
    const row = wrap.lastElementChild;
    wireChargeRow(row);
    if (presetPerson) {
        row.querySelector('.chg-person').value = presetPerson.name;
        row.querySelector('.chg-person-id').value = presetPerson.id;
    }
    return row;
}

function openCharge(fromCard) {
    if (!currentRetreat) { Layout.showNotification(t('fin_select_retreat'), 'warning'); return; }
    document.getElementById('chargeRows').innerHTML = '';
    addChargeRow(fromCard && card.id ? { id: card.id, name: card.name } : null);
    document.getElementById('chargeReason').value = '';
    document.getElementById('chargeModal').showModal();
}

async function submitCharge(ev) {
    ev.preventDefault();
    const reason = document.getElementById('chargeReason').value || null;
    const rows = [...document.querySelectorAll('#chargeRows .chg-row')].map(row => ({
        id: FinUtils.newRequestId(),
        participant_id: row.querySelector('.chg-person-id').value,
        retreat_id: currentRetreat,
        kind: row.querySelector('.chg-kind').value,
        description: row.querySelector('.chg-desc').value || null,
        quantity: row.querySelector('.chg-qty').value,
        unit_price: row.querySelector('.chg-price').value,
        discount_amount: row.querySelector('.chg-discount').value || null,
        discount_reason: row.querySelector('.chg-discount-reason').value || null,
        agreed_with: row.querySelector('.chg-agreed-with').value || null,
        creation_reason: reason
    }));
    if (rows.some(r => !r.participant_id)) {
        Layout.showNotification(t('fin_participant_required'), 'warning');
        return;
    }
    const res = await FinUtils.rpc('fin_create_charge', { rows });
    if (res?.error?.code === 'post_close_reason_required') {
        // ретрит закрыт: показываем поле причины и ведём к нему фокус,
        // чтобы новое поле не осталось незамеченным под тостом ошибки
        const wrap = document.getElementById('chargeReasonWrap');
        wrap.classList.remove('hidden');
        const input = document.getElementById('chargeReason');
        input.focus();
        input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    if (FinUtils.handleResult(res)) {
        document.getElementById('chargeModal').close();
        await refreshAfterChange();
    }
}

// ==================== ФОРМА: ПЛАТЁЖ ====================
function payRowHtml(idx) {
    return `
    <div class="border border-base-300 rounded-lg p-3 mb-2 pay-row" data-idx="${idx}">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_block')}</span></label>
                <select class="select select-bordered select-sm pay-kind">${PAY_KINDS.map(k => `<option value="${k}">${e(blockLabel(k))}</option>`).join('')}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_account')}</span></label>
                <select class="select select-bordered select-sm pay-account" required>${FinUtils.accountOptions()}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_amount')}</span></label>
                <input type="number" class="input input-bordered input-sm pay-amount" min="0.01" step="0.01" required>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_channel')}</span></label>
                <select class="select select-bordered select-sm pay-channel">${FinUtils.channelOptions('cash')}</select>
            </div>
        </div>
        ${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm text-error mt-1" aria-label="${t('fin_remove_row')}" onclick="this.closest('.pay-row').remove()">${FinUtils.ICONS.x}</button>` : ''}
    </div>`;
}

function addPayRow() {
    const wrap = document.getElementById('payRows');
    wrap.insertAdjacentHTML('beforeend', payRowHtml(wrap.children.length));
}

function openPayment(fromCard) {
    if (!currentRetreat) { Layout.showNotification(t('fin_select_retreat'), 'warning'); return; }
    requestIds.payment = requestIds.payment || FinUtils.newRequestId();
    document.getElementById('payDate').value = FinUtils.todayISO();
    document.getElementById('payComment').value = '';
    const search = document.getElementById('payPayerSearch');
    const hidden = document.getElementById('payPayerId');
    if (fromCard && card.id) { search.value = card.name; hidden.value = card.id; }
    else { search.value = ''; hidden.value = ''; }
    document.getElementById('payRows').innerHTML = '';
    addPayRow();
    document.getElementById('paymentModal').showModal();
}

// объект учёта ретрита нужен каждой строке платежа
async function ensureObjectId() {
    if (currentObjectId) return currentObjectId;
    const obj = FinUtils.refs.objects.find(o => o.retreat_id === currentRetreat);
    if (obj) { currentObjectId = obj.id; return currentObjectId; }
    const { data } = await Layout.db.rpc('fin_ensure_accounting_object', { p_retreat_id: currentRetreat });
    if (data?.ok) {
        currentObjectId = data.result.object_id;
        return currentObjectId;
    }
    Layout.showNotification(data?.error?.message || 'Ошибка объекта учёта', 'error');
    return null;
}

async function submitPayment(ev) {
    ev.preventDefault();
    const payer = document.getElementById('payPayerId').value;
    if (!payer) { Layout.showNotification(t('fin_participant_required'), 'warning'); return; }
    const objectId = await ensureObjectId();
    if (!objectId) return;
    const rows = [...document.querySelectorAll('#payRows .pay-row')].map(row => ({
        id: FinUtils.newRequestId(),
        account_id: row.querySelector('.pay-account').value,
        amount: row.querySelector('.pay-amount').value,
        participant_id: payer,
        object_id: objectId,
        participant_balance_kind: row.querySelector('.pay-kind').value,
        payment_channel: row.querySelector('.pay-channel').value || null
    }));
    const res = await FinUtils.rpc('fin_create_payment', {
        request_id: requestIds.payment,
        occurred_on: document.getElementById('payDate').value,
        payer_contact_id: payer,
        comment: document.getElementById('payComment').value || null,
        rows
    });
    if (FinUtils.handleResult(res)) {
        requestIds.payment = null;
        document.getElementById('paymentModal').close();
        await FinUtils.reloadAccounts();
        await refreshAfterChange();
    }
}

// ==================== ФОРМА: ВОЗВРАТ ====================
function openRefund(postingId) {
    const p = card.payments.find(x => x.posting_id === postingId);
    if (!p) return;
    requestIds.refund = requestIds.refund || FinUtils.newRequestId();
    document.getElementById('refundPostingId').value = postingId;
    document.getElementById('refundInfo').textContent =
        `${card.name} · ${t('fin_available_to_refund')}: ${FinUtils.fmtMoney(p.available_to_refund, p.currency_code)}`;
    const amountEl = document.getElementById('refundAmount');
    amountEl.value = p.available_to_refund;
    amountEl.max = p.available_to_refund;
    document.getElementById('refundDate').value = FinUtils.todayISO();
    document.getElementById('refundAccount').innerHTML =
        FinUtils.accountOptions(undefined, a => a.currency_code === p.currency_code);
    document.getElementById('refundReason').value = '';
    document.getElementById('refundModal').showModal();
}

async function submitRefund(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_create_refund', {
        request_id: requestIds.refund,
        refund_of_posting_id: document.getElementById('refundPostingId').value,
        source_account_id: document.getElementById('refundAccount').value || null,
        amount: document.getElementById('refundAmount').value,
        occurred_on: document.getElementById('refundDate').value,
        refund_recipient_contact_id: card.id,
        reason: document.getElementById('refundReason').value || null
    });
    if (FinUtils.handleResult(res)) {
        requestIds.refund = null;
        document.getElementById('refundModal').close();
        await FinUtils.reloadAccounts();
        await refreshAfterChange();
    }
}

// ==================== ОТМЕНА НАЧИСЛЕНИЯ ====================
function openCancelCharge(chargeId, desc) {
    document.getElementById('cancelChargeId').value = chargeId;
    document.getElementById('cancelChargeInfo').textContent = desc;
    document.getElementById('cancelChargeReason').value = '';
    document.getElementById('cancelChargeModal').showModal();
}

async function submitCancelCharge(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_cancel_charge', {
        charge_id: document.getElementById('cancelChargeId').value,
        reason: document.getElementById('cancelChargeReason').value
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('cancelChargeModal').close();
        await refreshAfterChange();
    }
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_participants', itemId: 'fin_participants' });
    await FinUtils.loadRefs();
    await loadRetreats();

    document.getElementById('chargeForm').addEventListener('submit', FinUtils.lockedSubmit(submitCharge));
    document.getElementById('paymentForm').addEventListener('submit', FinUtils.lockedSubmit(submitPayment));
    document.getElementById('refundForm').addEventListener('submit', FinUtils.lockedSubmit(submitRefund));
    document.getElementById('cancelChargeForm').addEventListener('submit', FinUtils.lockedSubmit(submitCancelCharge));
    FinUtils.attachPersonSearch(document.getElementById('payPayerSearch'), document.getElementById('payPayerId'));

    // Esc не должен молча терять введённые данные
    const guardDialog = (dlgId, isDirty) => document.getElementById(dlgId).addEventListener('cancel', ev => {
        if (isDirty() && !confirm(t('fin_confirm_discard'))) ev.preventDefault();
    });
    guardDialog('chargeModal', () => [...document.querySelectorAll('#chargeRows .chg-price')].some(i => i.value));
    guardDialog('paymentModal', () => [...document.querySelectorAll('#payRows .pay-amount')].some(i => i.value));

    const pBody = document.getElementById('participantsBody');
    pBody.addEventListener('click', ev => {
        const row = ev.target.closest('tr[data-pid]');
        if (row) openCard(row.dataset.pid);
    });
    pBody.addEventListener('keydown', ev => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const row = ev.target.closest('tr[data-pid]');
        if (row) { ev.preventDefault(); openCard(row.dataset.pid); }
    });
    document.getElementById('cardModal').addEventListener('click', ev => {
        const refundBtn = ev.target.closest('[data-refund]');
        if (refundBtn) { openRefund(refundBtn.dataset.refund); return; }
        const cancelBtn = ev.target.closest('[data-cancel-charge]');
        if (cancelBtn) openCancelCharge(cancelBtn.dataset.cancelCharge, cancelBtn.dataset.desc);
    });

    // Панель: поиск, фильтр-чипы, сортировка
    document.getElementById('pSearch').addEventListener('input', Layout.debounce(renderParticipants, 200));
    document.querySelectorAll('[data-pfilter]').forEach(btn => btn.addEventListener('click', () => {
        pFilter = btn.dataset.pfilter;
        document.querySelectorAll('[data-pfilter]').forEach(b => b.classList.toggle('btn-active', b === btn));
        renderParticipants();
    }));
    document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (pSort.key === key) pSort.dir = pSort.dir === 'asc' ? 'desc' : 'asc';
        else pSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
        renderParticipants();
    }));

    // ?retreat=<id> — прямая ссылка; ?open=<pid> — сразу открыть карточку (из аналитики)
    const params = new URLSearchParams(window.location.search);
    const preset = params.get('retreat');
    if (preset && retreats.some(r => r.id === preset)) {
        document.getElementById('retreatSelect').value = preset;
        await selectRetreat(preset);
        const openPid = params.get('open');
        if (openPid && participants.some(p => p.participant_id === openPid)) openCard(openPid);
    }
}

// Скопировать текстовую сводку по участнику (для отправки гостю в WhatsApp)
async function copySummary() {
    const p = participants.find(x => x.participant_id === card.id);
    if (!p) return;
    const b = p.balance;
    const money = n => FinUtils.fmtMoney(n, 'INR');
    const lines = [`${card.name}${card.retreatName ? ' · ' + card.retreatName : ''}`];
    for (const k of BLOCKS) {
        const blk = b.blocks[k];
        if (Number(blk.charged) > 0 || Number(blk.paid) > 0) {
            lines.push(`${t('fin_block_' + k)}: ${t('fin_charged')} ${money(blk.charged)}, ${t('fin_paid')} ${money(blk.paid)}`);
        }
    }
    const net = Number(b.net) || 0;
    lines.push(net > 0 ? `${t('fin_debt')}: ${money(net)}` : net < 0 ? `${t('fin_advance')}: ${money(-net)}` : t('fin_settled'));
    const ok = await FinUtils.copyText(lines.join('\n'));
    Layout.showNotification(ok ? t('fin_copied') : t('fin_copy_failed'), ok ? 'success' : 'error');
}

window.FinParticipants = { openCharge, openPayment, addChargeRow, addPayRow, copySummary };
init();
})();
