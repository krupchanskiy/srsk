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
    await Promise.all([loadParticipants(), loadRetreatRates()]);
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
    closeCharge(); closePayment();
    renderCardRates();
    loadCardCrmInfo();
    await Promise.all([loadCardCharges(), loadCardPayments()]);
}

// Кросс-курсы ретрита в шапке: 1$ = X₹ и т.д. (ТЗ 3.1)
let retreatRates = {};   // currency -> rate к INR
async function loadRetreatRates() {
    retreatRates = { INR: 1 };
    const { data } = await Layout.db.rpc('fin_get_retreat_rates', { p_retreat: currentRetreat });
    (data || []).forEach(r => { retreatRates[r.currency_code] = Number(r.rate); });
}

function renderCardRates() {
    const el = document.getElementById('cardRates');
    if (!el) return;
    const parts = Object.entries(retreatRates)
        .filter(([c]) => c !== 'INR')
        .map(([c, r]) => `1 ${FinUtils.symbol(c)} = ${Number(r).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₹`);
    el.textContent = parts.length ? `${t('fin_rates_header')}: ${parts.join(' · ')}` : '';
}

// Условия и даты из CRM — администратор видит договорённость в момент приёма денег (ТЗ 4.5)
let cardCalc = null;
async function loadCardCrmInfo() {
    const el = document.getElementById('cardCrmInfo');
    if (el) el.innerHTML = '';
    cardCalc = null;
    const { data: deal } = await Layout.db.from('crm_deals')
        .select('id').eq('vaishnava_id', card.id).eq('retreat_id', currentRetreat)
        .neq('status', 'cancelled').order('updated_at', { ascending: false }).limit(1).maybeSingle();
    if (!deal) return;
    const { data: calc } = await Layout.db.rpc('crm_calc_participation', { p_deal: deal.id });
    if (!calc?.ok) return;
    cardCalc = calc;
    const условия = ['org_fee', 'accommodation', 'meals']
        .map(k => ({ k, term: calc.blocks?.[k]?.term })).filter(x => x.term);
    const метки = условия.map(x =>
        `<span class="badge badge-warning badge-sm gap-1" title="${e(x.term.reason || '')}">
            ${e(blockLabel(x.k))}: ${e(x.term.type)}${x.term.percent ? ' ' + x.term.percent + '%' : ''}${x.term.reason ? ` · ${e(x.term.reason)}` : ''}
        </span>`).join(' ');
    const d = calc.dates;
    if (el) el.innerHTML = `
        <div class="flex flex-wrap items-center gap-2 text-xs">
            <span class="opacity-60">${t('fin_calc_dates')}: <b>${DateUtils.formatShort(DateUtils.parseDate(d.check_in))} — ${DateUtils.formatShort(DateUtils.parseDate(d.check_out))}</b>
                (${d.nights_total} ноч.${Number(d.nights_between) > 0 ? `, из них ${d.nights_between} вне ретрита` : ''})${d.building ? ` · ${e(d.building)}` : ''}</span>
            ${метки}
        </div>`;
}

// «Подтянуть из CRM»: материализация расчёта в начисления (ТЗ 3.1, сценарий 1)
async function syncFromCrm() {
    if (!card.id) return;
    const { data: res, error } = await Layout.db.rpc('fin_sync_charges_from_crm',
        { p_participant: card.id, p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'CRM'); return; }
    if (FinUtils.handleResult(res)) {
        const r = res.result || {};
        if (r.no_deal) Layout.showNotification(t('fin_no_deal_in_crm'), 'warning');
        else Layout.showNotification(`CRM → ${t('fin_charges')}: +${r.created || 0} / ~${r.updated || 0}`, 'success');
        await refreshAfterChange();
    }
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
            <td>${e(c.description || '')}${c.quantity != 1 ? ` <span class="opacity-70">(${c.quantity} × ${FinUtils.fmtMoney(c.unit_price, 'INR')})</span>` : ''}${c.is_cancelled ? ` <span class="badge badge-ghost badge-xs no-underline">${t('fin_cancelled')}</span>${c.cancelled_reason ? `<div class="text-xs opacity-60">${t('fin_reason')}: ${e(c.cancelled_reason)}</div>` : ''}` : ''}${c.creation_reason ? `<div class="text-xs opacity-60">${t('fin_post_close_reason')}: ${e(c.creation_reason)}</div>` : ''}${Number(c.discount_amount) > 0 && (c.discount_reason || c.agreed_with) ? `<div class="text-xs opacity-60">${e(c.discount_reason || '')}${c.agreed_with ? ` · ${t('fin_agreed_with').toLowerCase()}: ${e(c.agreed_with)}` : ''}</div>` : ''}</td>
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
        refunded_fully: `<span class="badge badge-neutral badge-xs">${t('fin_refunded_fully')}</span>`,
        // Платёж принят до переезда: в журнале его нет, он свёрнут в начальный остаток
        pre_cutover: `<span class="badge badge-ghost badge-xs">${t('fin_before_cutover')}</span>`
    }[s] || '');
    // Куда пришли деньги: счёт, если известен, иначе способ оплаты или канал.
    // У платежей до переезда счёт часто не заполнялся — тогда виден хотя бы способ.
    const куда = p => [p.account_name, p.payment_system, FinUtils.channelLabel(p.payment_channel)]
        .filter(Boolean).join(' · ') || '—';
    document.getElementById('cardPayments').innerHTML = card.payments.map(p => `
        <tr class="${p.is_reversed ? 'opacity-60' : ''}">
            <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}</td>
            <td>${e(FinUtils.typeLabel(p.type))}</td>
            <td>${e(blockLabel(p.balance_kind))}</td>
            <td class="text-right font-mono">${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.currency_code !== 'INR' ? `<div class="text-xs opacity-70">${t('fin_at_rate')} ${Number(p.rate_used).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} → ₹ ${Number(p.amount_base).toLocaleString('ru-RU')}</div>` : ''}</td>
            <td class="whitespace-nowrap">${e(куда(p))}</td>
            <td>${statusBadge(p.status)}</td>
            <td class="text-right">${isAdmin && p.type === 'payment' && p.operation_id ? `<a class="btn btn-ghost btn-xs" href="dds.html?op=${p.operation_id}" title="${t('fin_realloc_action')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
            </a>` : ''}${isAdmin && p.type === 'payment' && Number(p.available_to_refund) > 0 ? `<button class="btn btn-ghost btn-xs" data-refund="${p.posting_id}" title="${t('fin_refund')}">
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
            <!-- Дни правятся через даты, сумма пересчитывается сама (ТЗ 3.4) -->
            <div class="form-control chg-dates-wrap hidden">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_dates_from')} — ${t('fin_dates_to')}</span></label>
                <div class="flex gap-1">
                    <input type="date" class="input input-bordered input-sm chg-date-from w-full">
                    <input type="date" class="input input-bordered input-sm chg-date-to w-full">
                </div>
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
    const datesWrap = row.querySelector('.chg-dates-wrap');
    const relabel = () => {
        const поДням = ['accommodation', 'meals'].includes(kindSel.value);
        qtyLabel.textContent = поДням ? t('fin_days') : t('fin_quantity');
        datesWrap.classList.toggle('hidden', !поДням);
    };
    kindSel.addEventListener('change', relabel);
    relabel();
    // Даты → количество дней: расчёт остаётся объяснимым (ТЗ 3.4)
    const по_датам = () => {
        const a = row.querySelector('.chg-date-from').value;
        const b = row.querySelector('.chg-date-to').value;
        if (!a || !b) return;
        const дней = Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 86400000);
        if (дней > 0) {
            row.querySelector('.chg-qty').value = дней;
            row.querySelector('.chg-qty').dispatchEvent(new Event('input'));
        }
    };
    row.querySelector('.chg-date-from').addEventListener('change', по_датам);
    row.querySelector('.chg-date-to').addEventListener('change', по_датам);

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

function openCharge() {
    if (!currentRetreat) { Layout.showNotification(t('fin_select_retreat'), 'warning'); return; }
    document.getElementById('chargeRows').innerHTML = '';
    addChargeRow(card.id ? { id: card.id, name: card.name } : null);
    document.getElementById('chargeReason').value = '';
    // Форма раскрывается внутри карточки: сводка выше остаётся видна (ТЗ 3.1)
    closePayment();
    document.getElementById('chargeSection').classList.remove('hidden');
    document.getElementById('chargeSection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeCharge() {
    document.getElementById('chargeSection')?.classList.add('hidden');
}

async function submitCharge(ev) {
    ev.preventDefault();
    const reason = document.getElementById('chargeReason').value || null;
    const rows = [...document.querySelectorAll('#chargeRows .chg-row')].map(row => ({
        id: FinUtils.newRequestId(),
        participant_id: row.querySelector('.chg-person-id').value,
        retreat_id: currentRetreat,
        kind: row.querySelector('.chg-kind').value,
        description: (row.querySelector('.chg-desc').value || '') + (
            row.querySelector('.chg-date-from')?.value && row.querySelector('.chg-date-to')?.value
                ? ` (${DateUtils.formatShort(DateUtils.parseDate(row.querySelector('.chg-date-from').value))} — ${DateUtils.formatShort(DateUtils.parseDate(row.querySelector('.chg-date-to').value))})`
                : '') || null,
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
        closeCharge();
        await refreshAfterChange();
    }
}

// ==================== ФОРМА: ПЛАТЁЖ ====================
// Валюта платежа задаётся явно и первой: человек вносит «560 долларов», а не
// «платёж на долларовый счёт». Счета фильтруются по выбранной валюте — принять
// евро на рупиевую кассу всё равно нельзя (ВГ, 08.08).
function payCurrencyOptions(selected) {
    const active = FinUtils.refs.currencies.filter(c => c.is_active !== false);
    const list = active.length ? active : [{ code: 'INR' }];
    return list.map(c => `<option value="${e(c.code)}" ${c.code === selected ? 'selected' : ''}>
        ${e(FinUtils.symbol(c.code))} ${e(c.code)}</option>`).join('');
}

function payRowHtml(idx) {
    const валюта = 'INR';
    return `
    <div class="border border-base-300 rounded-lg p-3 mb-2 pay-row" data-idx="${idx}">
        <!-- Три колонки, а не пять: в модалке пять полей сжимаются и подписи обрезаются -->
        <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_block')}</span></label>
                <select class="select select-bordered select-sm pay-kind">${PAY_KINDS.map(k => `<option value="${k}">${e(blockLabel(k))}</option>`).join('')}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_currency')}</span></label>
                <select class="select select-bordered select-sm pay-currency">${payCurrencyOptions(валюта)}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_account')}</span></label>
                <select class="select select-bordered select-sm pay-account" required>${FinUtils.accountOptions(undefined, a => a.currency_code === валюта)}</select>
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
        <div class="text-xs opacity-70 mt-1 pay-hint"></div>
        ${idx > 0 ? `<button type="button" class="btn btn-ghost btn-sm text-error mt-1" aria-label="${t('fin_remove_row')}" onclick="this.closest('.pay-row').remove()">${FinUtils.ICONS.x}</button>` : ''}
    </div>`;
}

// Смена валюты пересобирает список счетов: показываем только те, куда эти деньги
// физически можно принять. Если счёта в такой валюте нет — говорим об этом прямо.
function onPayCurrencyChange(row) {
    const валюта = row.querySelector('.pay-currency').value;
    const счета = row.querySelector('.pay-account');
    счета.innerHTML = FinUtils.accountOptions(undefined, a => a.currency_code === валюта);
    const пусто = !счета.options.length;
    счета.disabled = пусто;
    row.querySelector('.pay-hint').textContent = пусто ? t('fin_no_account_in_currency') : '';
}

function addPayRow() {
    const wrap = document.getElementById('payRows');
    wrap.insertAdjacentHTML('beforeend', payRowHtml(wrap.children.length));
    // Строки добавляются на лету — слушатель вешаем один раз на контейнер
    if (!wrap.dataset.delegated) {
        wrap.dataset.delegated = '1';
        wrap.addEventListener('change', ev => {
            if (ev.target.classList.contains('pay-currency')) onPayCurrencyChange(ev.target.closest('.pay-row'));
            updatePayRunningTotal();
        });
        wrap.addEventListener('input', ev => {
            if (ev.target.classList.contains('pay-amount')) updatePayRunningTotal();
        });
    }
}

function openPayment() {
    if (!currentRetreat || !card.id) { Layout.showNotification(t('fin_select_retreat'), 'warning'); return; }
    requestIds.payment = requestIds.payment || FinUtils.newRequestId();
    document.getElementById('payDate').value = FinUtils.todayISO();
    document.getElementById('payComment').value = '';
    document.getElementById('payPayerId').value = card.id;
    document.getElementById('payPayerName').textContent = card.name;
    document.getElementById('payRows').innerHTML = '';
    addPayRow();
    updatePayRunningTotal();
    closeCharge();
    document.getElementById('paySection').classList.remove('hidden');
    document.getElementById('paySection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closePayment() {
    document.getElementById('paySection')?.classList.add('hidden');
}

// «Засчитать другому участнику» (ТЗ 3.1): компактная строка — человек, его
// остаток главной цифрой, своя сумма в удобной валюте. Стопкой друг под другом.
function addOtherParticipantRow() {
    const wrap = document.getElementById('payRows');
    const idx = wrap.children.length;
    wrap.insertAdjacentHTML('beforeend', payRowHtml(idx));
    const row = wrap.lastElementChild;
    row.classList.add('pay-other');
    row.insertAdjacentHTML('afterbegin', `
        <div class="grid grid-cols-2 gap-2 mb-2">
            <div class="form-control relative">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_participant')}</span></label>
                <input type="text" class="input input-bordered input-sm pay-person" autocomplete="off" required>
                <input type="hidden" class="pay-person-id">
            </div>
            <div class="form-control justify-end">
                <div class="text-xs opacity-60">${t('fin_balance')}</div>
                <div class="font-mono font-semibold pay-person-balance">—</div>
            </div>
        </div>`);
    FinUtils.attachPersonSearch(row.querySelector('.pay-person'), row.querySelector('.pay-person-id'));
    // Остаток подгружается при выборе человека — главная видимая цифра строки
    // attachPersonSearch пишет в hidden без события — следим за сменой значения сами
    const hid = row.querySelector('.pay-person-id');
    let прежний = '';
    const наблюдатель = setInterval(async () => {
        if (!document.body.contains(hid)) { clearInterval(наблюдатель); return; }
        if (hid.value && hid.value !== прежний) {
            прежний = hid.value;
            const { data } = await Layout.db.rpc('fin_get_participant_balance', { p_participant: hid.value, p_retreat: currentRetreat });
            const net = Number(data?.net) || 0;
            row.querySelector('.pay-person-balance').innerHTML = fmtNet(net);
        }
    }, 500);
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
        // Строка «за другого» несёт своего участника; оплата закрывается по каждому отдельно
        participant_id: row.querySelector('.pay-person-id')?.value || payer,
        object_id: objectId,
        participant_balance_kind: row.querySelector('.pay-kind').value,
        payment_channel: row.querySelector('.pay-channel').value || null
    }));
    if (rows.some(r => !r.participant_id)) {
        Layout.showNotification(t('fin_participant_required'), 'warning');
        return;
    }

    // Финальная сверка перед записью (ТЗ 3.1): итог по валютам и людям
    const поВалютам = {};
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        const c = row.querySelector('.pay-currency').value;
        поВалютам[c] = (поВалютам[c] || 0) + (Number(row.querySelector('.pay-amount').value) || 0);
    });
    const людей = new Set(rows.map(r => r.participant_id)).size;
    const итог = Object.entries(поВалютам).filter(([, v]) => v > 0)
        .map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ');
    const вопрос = `${t('fin_running_total')}: ${итог}` +
        (людей > 1 ? ` ${t('fin_for_n_people').replace('{n}', людей)}` : '') +
        `\n${t('fin_pay_confirm_q')}`;
    if (!confirm(вопрос)) return;

    const res = await FinUtils.rpc('fin_create_payment', {
        request_id: requestIds.payment,
        occurred_on: document.getElementById('payDate').value,
        payer_contact_id: payer,
        comment: document.getElementById('payComment').value || null,
        rows
    });
    if (FinUtils.handleResult(res)) {
        requestIds.payment = null;
        closePayment();
        await FinUtils.reloadAccounts();
        await refreshAfterChange();
    }
}

// Живой пересчёт строк в опорную валюту (первой строки) по курсу ретрита (ТЗ 3.3)
function updatePayRunningTotal() {
    const el = document.getElementById('payRunningTotal');
    if (!el) return;
    const rows = [...document.querySelectorAll('#payRows .pay-row')];
    if (!rows.length) { el.innerHTML = ''; return; }
    const опорная = rows[0].querySelector('.pay-currency').value;
    const кОпорной = c => (retreatRates[c] || 1) / (retreatRates[опорная] || 1);
    let итог = 0;
    const поВалютам = {};
    rows.forEach(row => {
        const c = row.querySelector('.pay-currency').value;
        const v = Number(row.querySelector('.pay-amount').value) || 0;
        if (!v) return;
        поВалютам[c] = (поВалютам[c] || 0) + v;
        итог += v * кОпорной(c);
    });
    if (!итог) { el.innerHTML = ''; return; }
    const детали = Object.entries(поВалютам).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ');
    // Против остатка участника карточки — видно, закрывает ли внесённое долг
    const p = participants.find(x => x.participant_id === card.id);
    const остаток = Number(p?.balance?.net) || 0;
    const остатокОпорной = остаток * кОпорной('INR');
    const после = остатокОпорной - итог;
    el.innerHTML = `${t('fin_running_total')}: <b>${детали}</b> ≈ ${FinUtils.fmtMoney(итог, опорная)}`
        + (остаток > 0 ? ` · ${t('fin_remaining_after')}: <b class="${после > 0.01 ? 'text-error' : 'text-success'}">${FinUtils.fmtMoney(Math.max(после, 0), опорная)}</b>` : '');
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
    // Плательщик задаётся открытой карточкой участника — отдельного поиска больше нет.
    // Esc в карточке не должен молча терять заполняемые формы
    document.getElementById('cardModal').addEventListener('cancel', ev => {
        const занято = [...document.querySelectorAll('#chargeRows .chg-price, #payRows .pay-amount')].some(i => i.value);
        if (занято && !confirm(t('fin_confirm_discard'))) ev.preventDefault();
    });

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

window.FinParticipants = { openCharge, closeCharge, openPayment, closePayment, addChargeRow, addPayRow, addOtherParticipantRow, syncFromCrm, copySummary };
init();
})();
