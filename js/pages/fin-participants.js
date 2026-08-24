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
    // Начисления подтягиваются из CRM сами при открытии (ТЗ 3.1, сценарий 1);
    // кнопка «Обновить из CRM» остаётся для принудительного пересчёта
    if (window.hasPermission?.('fin_admin')) {
        const { data: res } = await Layout.db.rpc('fin_sync_charges_from_crm',
            { p_participant: card.id, p_retreat: currentRetreat });
        if (res?.ok && ((res.result?.created || 0) + (res.result?.updated || 0)) > 0) {
            await loadParticipants();
            const fresh = participants.find(x => x.participant_id === card.id);
            if (fresh) renderCardBlocks(fresh.balance);
        }
    }
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
    const деньги = vals => !vals ? '—' : [['INR','₹'],['RUB','₽'],['USD','$'],['EUR','€']]
        .filter(([c]) => vals[c] != null).map(([c, s]) => `${Number(vals[c]).toLocaleString('ru-RU')} ${s}`).join(' / ') || '—';
    const блок = (k, назв) => {
        const b = calc.blocks?.[k];
        if (!b) return '';
        const срок = b.during && Number(b.between?.nights ?? b.between?.days) > 0
            ? `<div class="text-[11px] opacity-60 pl-2">${t('fin_during_retreat')}: ${b.during.nights ?? b.during.days} · ${деньги(b.during)}<br>${t('fin_outside_retreat')}: ${b.between.nights ?? b.between.days} · ${деньги(b.between)}${b.between.discount_percent ? ` (−${b.between.discount_percent}%)` : ''}</div>` : '';
        const усл = b.term ? `<span class="badge badge-warning badge-xs ml-1" title="${e(b.term.reason || '')}">${e(b.term.type)}${b.term.percent ? ' ' + b.term.percent + '%' : ''}</span>` : '';
        return `<div class="py-0.5 border-b border-base-200/60 last:border-0">
            <div class="flex justify-between gap-2 text-xs">
                <span class="opacity-60">${назв}${усл}</span>
                <span class="font-mono text-right ${b.term ? 'text-amber-700 font-semibold' : ''}">${деньги(b.final)}</span>
            </div>${срок}${b.note ? `<div class="text-[11px] text-warning pl-2">${e(b.note)}</div>` : ''}
        </div>`;
    };
    if (el) el.innerHTML = `
        <div class="bg-base-200/40 rounded-lg px-2.5 py-1.5">
            <div class="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide opacity-50 mb-0.5">
                <span>${t('fin_crm_terms_info')} · <span class="normal-case">${DateUtils.formatShort(DateUtils.parseDate(d.check_in))} — ${DateUtils.formatShort(DateUtils.parseDate(d.check_out))}, ${d.nights_total} ноч.${d.building ? ` · ${e(d.building)}${d.room ? ' №' + e(String(d.room)) : ''}` : ''}</span></span>
            </div>
            ${блок('org_fee', blockLabel('org_fee'))}
            ${блок('accommodation', blockLabel('accommodation'))}
            ${блок('meals', blockLabel('meals'))}
            ${метки ? `<div class="mt-1">${метки}</div>` : ''}
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
    const isAdmin = window.hasPermission?.('fin_admin');
    const cell = (k, block) => {
        // Часть долга блока могла быть погашена «Общим» платежом (зачёт по
        // приоритету блоков, ТЗ 7) — показываем это явно, иначе «Оплачено 0 /
        // Остаток 0» при активном начислении выглядит как ошибка.
        const fromGeneral = Math.max(0, (Number(block.charged) - Number(block.paid)) - Number(block.balance));
        const balance = Number(block.balance);
        const balanceHtml = balance === 0 && Number(block.charged) > 0
            ? `<span class="font-mono">${FinUtils.fmtMoney(0, 'INR')}</span>`
            : fmtNet(balance);
        // Небольшой остаток долга можно простить — «Списать» (чек-лист v3, п.3)
        const списать = isAdmin && balance > 0
            ? `<button type="button" class="btn btn-ghost btn-xs text-error px-1 -mr-1" data-writeoff="${k}" title="${t('fin_write_off_title')}">${t('fin_write_off')}</button>`
            : '';
        return `
        <div class="border border-base-300 rounded-lg p-2">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1 flex justify-between items-center">${blockLabel(k)}${списать}</div>
            <div class="text-xs flex justify-between"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(block.charged, 'INR')}</span></div>
            <div class="text-xs flex justify-between"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(block.paid, 'INR')}</span></div>
            ${fromGeneral > 0 ? `<div class="text-xs flex justify-between text-success"><span>${t('fin_from_general')}</span><span class="font-mono">${FinUtils.fmtMoney(fromGeneral, 'INR')}</span></div>` : ''}
            <div class="text-sm flex justify-between mt-1 pt-1 border-t border-base-200"><span>${t('fin_balance')}</span>${balanceHtml}</div>
        </div>`;
    };
    const totalNet = Number(b.net) || 0;
    document.getElementById('cardBlocks').innerHTML =
        BLOCKS.map(k => cell(k, b.blocks[k])).join('') +
        `<div class="border-2 rounded-lg p-2 ${totalNet > 0 ? 'border-error' : totalNet < 0 ? 'border-success' : 'border-base-300'}">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1">${t('fin_total')}</div>
            <div class="text-xs flex justify-between"><span>${t('fin_debt')}</span><span class="font-mono">${FinUtils.fmtMoney(b.total_debt, 'INR')}</span></div>
            <div class="text-xs flex justify-between"><span>${t('fin_advance')}</span><span class="font-mono">${FinUtils.fmtMoney(b.total_advance, 'INR')}</span></div>
            <div class="text-sm flex justify-between mt-1 pt-1 border-t border-base-200"><span>${t('fin_total')}</span>${fmtNetWord(totalNet)}</div>
        </div>`;
}

let cardChargesById = {};
async function loadCardCharges() {
    const { data, error } = await Layout.db.from('fin_v_charges').select('*')
        .eq('participant_id', card.id).eq('retreat_id', currentRetreat)
        .order('created_at');
    if (error) { Layout.handleError(error, 'Начисления'); return; }
    cardChargesById = Object.fromEntries((data || []).map(c => [c.id, c]));
    const isAdmin = window.hasPermission?.('fin_admin');
    document.getElementById('cardCharges').innerHTML = (data || []).map(c => `
        <tr class="${c.is_cancelled ? 'opacity-60 line-through' : ''} ${!c.is_cancelled && Number(c.discount_amount) > 0 ? 'bg-amber-50' : ''}">
            <td>${e(blockLabel(c.kind))}</td>
            <td>${e(c.description || '')}${c.quantity != 1 ? ` <span class="opacity-70">(${c.quantity} × ${FinUtils.fmtMoney(c.unit_price, 'INR')})</span>` : ''}${c.is_cancelled ? ` <span class="badge badge-ghost badge-xs no-underline">${t('fin_cancelled')}</span>${c.cancelled_reason ? `<div class="text-xs opacity-60">${t('fin_reason')}: ${e(c.cancelled_reason)}</div>` : ''}` : ''}${c.creation_reason === 'crm_auto' ? ` <span class="badge badge-info badge-xs no-underline">CRM</span>` : c.creation_reason?.startsWith('Перерасчёт') ? `<div class="text-xs text-amber-700">${e(c.creation_reason)}</div>` : c.creation_reason ? `<div class="text-xs opacity-60">${t('fin_post_close_reason')}: ${e(c.creation_reason)}</div>` : ''}${Number(c.discount_amount) > 0 && (c.discount_reason || c.agreed_with) ? `<div class="text-xs opacity-60">${e(c.discount_reason || '')}${c.agreed_with ? ` · ${t('fin_agreed_with').toLowerCase()}: ${e(c.agreed_with)}` : ''}</div>` : ''}</td>
            <td class="text-right font-mono">${FinUtils.fmtMoney(c.amount, 'INR')}</td>
            <td class="text-right font-mono">${Number(c.discount_amount) > 0 ? FinUtils.fmtMoney(c.discount_amount, 'INR') : '—'}</td>
            <td class="text-right font-mono font-semibold">${FinUtils.fmtMoney(c.net_amount, 'INR')}</td>
            <td class="text-right whitespace-nowrap">${!c.is_cancelled && isAdmin ? `<button class="btn btn-ghost btn-xs" data-recalc-charge="${c.id}" title="${t('fin_recalc')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z"/></svg>
            </button>` : ''}${!c.is_cancelled && isAdmin ? `<button class="btn btn-ghost btn-xs text-error" data-cancel-charge="${c.id}" data-desc="${e(c.description || blockLabel(c.kind))}" title="${t('fin_cancel_charge')}">
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
            <td>${e(p.direction === 'out' && p.type === 'payment' ? t('fin_change') : FinUtils.typeLabel(p.type))}</td>
            <td>${e(blockLabel(p.balance_kind))}</td>
            <td class="text-right font-mono ${p.direction === 'out' ? 'text-warning' : ''}">${p.direction === 'out' ? '−' : ''}${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.currency_code !== 'INR' ? `<div class="text-xs opacity-70">${t('fin_at_rate')} ${Number(p.rate_used).toLocaleString('ru-RU', { maximumFractionDigits: 4 })} → ₹ ${Number(p.amount_base).toLocaleString('ru-RU')}</div>` : ''}</td>
            <td class="whitespace-nowrap">${e(куда(p))}</td>
            <td>${statusBadge(p.status)}</td>
            <td class="text-right">${isAdmin && p.type === 'payment' && p.direction !== 'out' && p.operation_id ? `<a class="btn btn-ghost btn-xs" href="dds.html?op=${p.operation_id}" title="${t('fin_realloc_action')}">
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
    recalcSource = null;
    document.getElementById('chargeRecalcWrap')?.classList.add('hidden');
}

// «Перерасчёт» (ТЗ 3.1, сценарий 3): не тихая замена числа, а видимая запись
// «было → стало» — старая строка отменяется с причиной, новая добавляется
let recalcSource = null;
function openRecalc(chargeId) {
    const c = cardChargesById[chargeId];
    if (!c) return;
    openCharge();
    recalcSource = c;
    const row = document.querySelector('#chargeRows .chg-row');
    row.querySelector('.chg-kind').value = c.kind;
    row.querySelector('.chg-kind').dispatchEvent(new Event('change'));
    const desc = row.querySelector('.chg-desc');
    desc.value = c.description || ''; desc.dataset.touched = '1';
    row.querySelector('.chg-qty').value = c.quantity;
    row.querySelector('.chg-price').value = c.unit_price;
    row.querySelector('.chg-discount').value = Number(c.discount_amount) > 0 ? c.discount_amount : '';
    row.querySelector('.chg-discount').dispatchEvent(new Event('input'));
    row.querySelector('.chg-discount-reason').value = c.discount_reason || '';
    row.querySelector('.chg-qty').dispatchEvent(new Event('input'));
    const wrap = document.getElementById('chargeRecalcWrap');
    wrap.classList.remove('hidden');
    document.getElementById('chargeRecalcReason').value = '';
    document.getElementById('chargeRecalcWas').textContent =
        `${t('fin_recalc')}: ${e(c.description || blockLabel(c.kind))} — ${FinUtils.fmtMoney(c.net_amount, 'INR')}`;
    document.getElementById('chargeRecalcReason').focus();
}

async function submitCharge(ev) {
    ev.preventDefault();
    let reason = document.getElementById('chargeReason').value || null;
    let причинаПерерасчёта = null;
    if (recalcSource) {
        причинаПерерасчёта = document.getElementById('chargeRecalcReason').value.trim();
        if (!причинаПерерасчёта) {
            Layout.showNotification(t('fin_recalc_reason'), 'warning');
            document.getElementById('chargeRecalcReason').focus();
            return;
        }
        // Кто и почему — в самой строке, видно в истории без раскопок
        reason = `Перерасчёт: ${причинаПерерасчёта} (было ${FinUtils.fmtMoney(recalcSource.net_amount, 'INR')})`;
    }
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
    if (res?.ok && recalcSource) {
        // Новая строка уже есть — теперь отменяем старую с записью «было → стало»
        const новая = rows[0];
        const стало = Math.max(Number(новая.quantity) * Number(новая.unit_price) - Number(новая.discount_amount || 0), 0);
        await FinUtils.rpc('fin_cancel_charge', {
            charge_id: recalcSource.id,
            reason: `Перерасчёт: было ${FinUtils.fmtMoney(recalcSource.net_amount, 'INR')} → стало ${FinUtils.fmtMoney(стало, 'INR')}. ${причинаПерерасчёта}`
        });
    }
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

// Приоритет счетов по каналу (чек-лист v3, п.4): наличные — кассы первыми,
// безналичные — наоборот, сначала счета по выпискам
function счетаДляСтроки(валюта, канал) {
    const наличные = (канал || 'cash') === 'cash';
    return FinUtils.accountOptions(undefined, a => a.currency_code === валюта,
        a => (a.reconciliation_mode === 'cash_count') === наличные);
}

function payRowHtml(idx) {
    const валюта = document.getElementById('payBaseCurrency')?.value || 'INR';
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
                <select class="select select-bordered select-sm pay-account" required>${счетаДляСтроки(валюта, 'cash')}</select>
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

// Смена валюты/канала пересобирает список счетов: показываем только те, куда эти
// деньги физически можно принять, кассы или онлайн-счета первыми — по каналу.
function onPayCurrencyChange(row) {
    const валюта = row.querySelector('.pay-currency').value;
    const канал = row.querySelector('.pay-channel').value;
    const счета = row.querySelector('.pay-account');
    счета.innerHTML = счетаДляСтроки(валюта, канал);
    const пусто = !счета.options.length;
    счета.disabled = пусто;
    if (пусто) row.querySelector('.pay-hint').textContent = t('fin_no_account_in_currency');
}

function addPayRow() {
    const wrap = document.getElementById('payRows');
    wrap.insertAdjacentHTML('beforeend', payRowHtml(wrap.children.length));
    // Строки добавляются на лету — слушатель вешаем один раз на контейнер
    if (!wrap.dataset.delegated) {
        wrap.dataset.delegated = '1';
        wrap.addEventListener('change', ev => {
            const row = ev.target.closest('.pay-row');
            if (ev.target.classList.contains('pay-currency') || ev.target.classList.contains('pay-channel')) onPayCurrencyChange(row);
            // Блок или валюта сменились — пересчитать подсказку остатка (п.5/6)
            if (row && (ev.target.classList.contains('pay-currency') || ev.target.classList.contains('pay-kind'))) updateRowHint(row);
            updatePayRunningTotal();
        });
        wrap.addEventListener('input', ev => {
            if (ev.target.classList.contains('pay-amount')) {
                ev.target.dataset.touched = '1';
                updatePayRunningTotal();
            }
        });
    }
    updateRowHint(wrap.lastElementChild);
}

// ==================== ОСТАТОК БЛОКА В ВАЛЮТЕ (чек-лист v3, п.5–6) ====================
// Балансы и CRM-расчёты добавленных участников кэшируются на время формы
const pidData = { balance: {}, calc: {} };

async function ensurePidData(pid) {
    if (!pidData.balance[pid]) {
        const p = participants.find(x => x.participant_id === pid);
        if (p) pidData.balance[pid] = p.balance;
        else {
            const { data } = await Layout.db.rpc('fin_get_participant_balance', { p_participant: pid, p_retreat: currentRetreat });
            pidData.balance[pid] = data || null;
        }
    }
    if (pidData.calc[pid] === undefined) {
        if (pid === card.id && cardCalc) pidData.calc[pid] = cardCalc;
        else {
            const { data: deal } = await Layout.db.from('crm_deals')
                .select('id').eq('vaishnava_id', pid).eq('retreat_id', currentRetreat)
                .neq('status', 'cancelled').order('updated_at', { ascending: false }).limit(1).maybeSingle();
            if (deal) {
                const { data: calc } = await Layout.db.rpc('crm_calc_participation', { p_deal: deal.id });
                pidData.calc[pid] = calc?.ok ? calc : null;
            } else pidData.calc[pid] = null;
        }
    }
    return { balance: pidData.balance[pid], calc: pidData.calc[pid] };
}

function rowPid(row) {
    return row.querySelector('.pay-person-id')?.value || card.id;
}

// Курс строки для пересчёта в ₹: цена CRM (полная сумма блока в «своей» валюте)
// или курс ретрита (остаток/другая валюта) — ровно та же логика, что на сервере
function rowRateInr(row) {
    const cur = row.querySelector('.pay-currency').value;
    if (cur === 'INR') return 1;
    const kind = row.querySelector('.pay-kind').value;
    const calc = pidData.calc[rowPid(row)];
    const b = calc?.blocks?.[kind]?.final;
    if (row.dataset.rateMode !== 'retreat' && b && Number(b[cur]) > 0 && Number(b.INR) > 0) {
        return Number(b.INR) / Number(b[cur]);
    }
    return retreatRates[cur] || 1;
}

// Подсказка «Остаток по блоку: N ₽ (по прайсу CRM)» + автоподстановка суммы.
// Значение берётся из уже посчитанного CRM-расчёта, не пересчитывается заново (п.5)
async function updateRowHint(row) {
    if (!row || !row.classList.contains('pay-row')) return;
    const pid = rowPid(row);
    if (!pid) return;
    const kind = row.querySelector('.pay-kind').value;
    const cur = row.querySelector('.pay-currency').value;
    const { balance, calc } = await ensurePidData(pid);
    const hint = row.querySelector('.pay-hint');
    if (row.querySelector('.pay-account').disabled) return;   // приоритет у «нет счёта в валюте»
    const блок = balance?.blocks?.[kind];
    if (!блок) { if (hint) hint.textContent = ''; delete row.dataset.rateMode; return; }
    // Остаток блока в ₹ минус то, что уже введено в предыдущих строках формы
    let остатокInr = Math.max(Number(блок.balance) || 0, 0);
    // «Другая валюта» появляется, когда часть блока уже вносится в иной валюте
    // (не в текущей и не в ₹) — только тогда остаток идёт по курсу ретрита (п.6);
    // доплата той же валютой всегда сверяется с её собственной ценой CRM (п.1)
    let былаДругаяВалюта = false;
    for (const прежняя of document.querySelectorAll('#payRows .pay-row')) {
        if (прежняя === row) break;
        if (rowPid(прежняя) !== pid || прежняя.querySelector('.pay-kind').value !== kind) continue;
        const валютаПрежней = прежняя.querySelector('.pay-currency').value;
        if (валютаПрежней !== cur && валютаПрежней !== 'INR') былаДругаяВалюта = true;
        остатокInr = Math.max(остатокInr - (Number(прежняя.querySelector('.pay-amount').value) || 0) * rowRateInr(прежняя), 0);
    }
    const ценаБлока = calc?.blocks?.[kind]?.final;
    let сумма, режим;
    if (cur === 'INR') {
        сумма = Math.round(остатокInr * 100) / 100;
        режим = 'crm_price';
    } else if (!былаДругаяВалюта && ценаБлока && Number(ценаБлока[cur]) > 0 && Number(ценаБлока.INR) > 0) {
        // своя цена валюты из CRM: полный блок = ровно цена, часть — пропорция (п.1)
        сумма = Math.round(Number(ценаБлока[cur]) * остатокInr / Number(ценаБлока.INR) * 100) / 100;
        режим = 'crm_price';
    } else {
        // остаток после другой валюты или валюта без цены — курс ретрита (п.6)
        сумма = retreatRates[cur] ? Math.round(остатокInr / retreatRates[cur] * 100) / 100 : 0;
        режим = 'retreat';
    }
    row.dataset.rateMode = режим;
    if (hint) hint.innerHTML = сумма > 0
        ? `${t('fin_block_remaining')}: <b class="font-mono">${FinUtils.fmtMoney(сумма, cur)}</b> <span class="opacity-60">(${режим === 'crm_price' ? t('fin_rate_by_crm') : t('fin_rate_by_retreat')})</span>`
        : '';
    const поле = row.querySelector('.pay-amount');
    if (сумма > 0 && !поле.dataset.touched) {
        поле.value = сумма;
        updatePayRunningTotal();
    }
}

function openPayment() {
    if (!currentRetreat || !card.id) { Layout.showNotification(t('fin_select_retreat'), 'warning'); return; }
    requestIds.payment = requestIds.payment || FinUtils.newRequestId();
    document.getElementById('payDate').value = FinUtils.todayISO();
    document.getElementById('payComment').value = '';
    document.getElementById('payPayerId').value = card.id;
    document.getElementById('payPayerName').textContent = card.name;
    const base = document.getElementById('payBaseCurrency');
    if (base) { base.innerHTML = payCurrencyOptions('INR'); base.value = 'INR'; }
    document.getElementById('payRows').innerHTML = '';
    pidData.balance = {}; pidData.calc = {};
    removeChange(); removeDonation();
    addPayRow();
    updatePayRunningTotal();
    closeCharge();
    document.getElementById('paySection').classList.remove('hidden');
    document.getElementById('paySection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closePayment() {
    document.getElementById('paySection')?.classList.add('hidden');
}

// «Засчитать другому участнику» (ТЗ 3.1 + чек-лист v3, п.7): своя строка платежа
// плюс такая же полная разбивка по блокам и собственная история платежей —
// не только цифра остатка. Оплата закрывается в секции каждого человека отдельно.
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
        </div>
        <div class="pay-other-blocks grid grid-cols-2 md:grid-cols-4 gap-1 mb-2"></div>
        <details class="pay-other-history hidden mb-2">
            <summary class="text-xs opacity-70 cursor-pointer">${t('fin_own_history')}</summary>
            <div class="overflow-x-auto"><table class="table table-xs"><tbody></tbody></table></div>
        </details>`);
    FinUtils.attachPersonSearch(row.querySelector('.pay-person'), row.querySelector('.pay-person-id'));
    // Разбивка подгружается при выборе человека.
    // attachPersonSearch пишет в hidden без события — следим за сменой значения сами
    const hid = row.querySelector('.pay-person-id');
    let прежний = '';
    const наблюдатель = setInterval(async () => {
        if (!document.body.contains(hid)) { clearInterval(наблюдатель); return; }
        if (hid.value && hid.value !== прежний) {
            прежний = hid.value;
            delete pidData.balance[hid.value]; delete pidData.calc[hid.value];
            const { balance } = await ensurePidData(hid.value);
            row.querySelector('.pay-person-balance').innerHTML = fmtNet(Number(balance?.net) || 0);
            renderOtherBreakdown(row, balance);
            loadOtherHistory(row, hid.value);
            delete row.querySelector('.pay-amount').dataset.touched;
            updateRowHint(row);
        }
    }, 500);
}

// Мини-версия сводки по блокам добавленного участника (Начислено/Оплачено/Остаток)
function renderOtherBreakdown(row, balance) {
    const el = row.querySelector('.pay-other-blocks');
    if (!el || !balance?.blocks) return;
    el.innerHTML = BLOCKS.map(k => {
        const b = balance.blocks[k];
        if (!(Number(b.charged) || Number(b.paid))) return '';
        return `<div class="border border-base-300 rounded p-1.5 text-[11px]">
            <div class="font-semibold uppercase opacity-60">${e(blockLabel(k))}</div>
            <div class="flex justify-between"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(b.charged, 'INR')}</span></div>
            <div class="flex justify-between"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(b.paid, 'INR')}</span></div>
            <div class="flex justify-between border-t border-base-200 mt-0.5 pt-0.5"><span>${t('fin_balance')}</span>${fmtNet(b.balance)}</div>
        </div>`;
    }).join('');
}

// Собственная история платежей добавленного участника — свёрнутая, но полная
async function loadOtherHistory(row, pid) {
    const details = row.querySelector('.pay-other-history');
    if (!details) return;
    const { data } = await Layout.db.rpc('fin_get_participant_payments', { p_participant: pid, p_retreat: currentRetreat });
    const список = data || [];
    details.classList.toggle('hidden', !список.length);
    details.querySelector('tbody').innerHTML = список.map(p => `
        <tr class="${p.is_reversed ? 'opacity-50' : ''}">
            <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}</td>
            <td>${e(p.direction === 'out' ? t('fin_change') : FinUtils.typeLabel(p.type))}</td>
            <td>${e(blockLabel(p.balance_kind))}</td>
            <td class="text-right font-mono">${p.direction === 'out' ? '−' : ''}${FinUtils.fmtMoney(p.amount, p.currency_code)}</td>
        </tr>`).join('');
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
        payment_channel: row.querySelector('.pay-channel').value || null,
        // Курс строки: цена CRM для «своей» валюты блока или курс ретрита для остатка (п.1/6)
        rate_mode: row.dataset.rateMode || null
    }));
    if (rows.some(r => !r.participant_id)) {
        Layout.showNotification(t('fin_participant_required'), 'warning');
        return;
    }

    // Сдача (п.2): out-проводка той же операции — наличные вернулись гостю
    let change = null;
    const changeWrap = document.getElementById('payChangeWrap');
    if (changeWrap && !changeWrap.classList.contains('hidden')) {
        const сумма = Number(document.getElementById('payChangeAmount').value) || 0;
        if (сумма > 0) {
            change = {
                id: FinUtils.newRequestId(),
                account_id: document.getElementById('payChangeAccount').value,
                amount: сумма,
                participant_id: payer,
                object_id: objectId,
                participant_balance_kind: rows[0].participant_balance_kind,
                payment_channel: 'cash'
            };
            if (!change.account_id) { Layout.showNotification(t('fin_no_account_in_currency'), 'warning'); return; }
        }
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
        (change ? `\n${t('fin_change')}: ${FinUtils.fmtMoney(change.amount, document.getElementById('payChangeCurrency').value)}` : '') +
        (payDonation ? `\n${t('fin_donation_excess')}: ${FinUtils.fmtMoney(payDonation.amount, payDonation.currency)}` : '') +
        `\n${t('fin_pay_confirm_q')}`;
    if (!confirm(вопрос)) return;

    const res = await FinUtils.rpc('fin_create_payment', {
        request_id: requestIds.payment,
        occurred_on: document.getElementById('payDate').value,
        payer_contact_id: payer,
        comment: document.getElementById('payComment').value || null,
        rows,
        change
    });
    if (FinUtils.handleResult(res)) {
        // Излишек, оставленный как пожертвование (п.3): отдельная операция на тот же
        // счёт — платёж закрывает ровно долг, разница проведена как пожертвование
        if (payDonation) {
            const статья = FinUtils.refs.categories.find(c => c.code === 'participant_donation');
            const донат = await FinUtils.rpc('fin_create_donation', {
                request_id: FinUtils.newRequestId(),
                occurred_on: document.getElementById('payDate').value,
                payer_contact_id: payer,
                comment: `Излишек при оплате (${card.name}) — оставлен как пожертвование по просьбе гостя`,
                rows: [{
                    id: FinUtils.newRequestId(),
                    account_id: payDonation.account_id,
                    amount: payDonation.amount,
                    category_id: статья?.id,
                    object_id: objectId,
                    participant_id: payer,
                    payment_channel: payDonation.channel || 'cash'
                }]
            });
            if (!донат?.ok) Layout.showNotification(`${t('fin_donation_excess')}: ${донат?.error?.message || 'ошибка'}`, 'error');
        }
        requestIds.payment = null;
        removeChange(); removeDonation();
        closePayment();
        await FinUtils.reloadAccounts();
        await refreshAfterChange();
    }
}

// ==================== СДАЧА И ИЗЛИШЕК (чек-лист v3, п.2–3) ====================
let payDonation = null;   // {amount, currency, account_id, channel, rowEl}

function openChangeBlock() {
    removeDonation();
    const wrap = document.getElementById('payChangeWrap');
    wrap.classList.remove('hidden');
    const валютаSel = document.getElementById('payChangeCurrency');
    if (!валютаSel.options.length) {
        валютаSel.innerHTML = payCurrencyOptions('INR');
        валютаSel.addEventListener('change', () => {
            document.getElementById('payChangeAccount').innerHTML =
                счетаДляСтроки(валютаSel.value, 'cash');
            подставитьСдачу();
        });
    }
    валютаSel.value = 'INR';
    document.getElementById('payChangeAccount').innerHTML = счетаДляСтроки('INR', 'cash');
    подставитьСдачу();
    updatePayRunningTotal();
}

// Prefill: переплата, пересчитанная по курсу ретрита в валюту сдачи
function подставитьСдачу() {
    const валюта = document.getElementById('payChangeCurrency').value;
    const переплатаInr = текущаяПереплатаInr();
    if (переплатаInr > 0) {
        document.getElementById('payChangeAmount').value =
            Math.round(переплатаInr / (retreatRates[валюта] || 1) * 100) / 100;
    }
    updatePayRunningTotal();
}

function removeChange() {
    document.getElementById('payChangeWrap')?.classList.add('hidden');
    const поле = document.getElementById('payChangeAmount');
    if (поле) поле.value = '';
    updatePayRunningTotal();
}

// «Оставить как пожертвование»: сумма последней строки уменьшается на излишек,
// излишек проводится пожертвованием на тот же счёт — деньги гостя сходятся 1:1
function keepAsDonation() {
    removeChange();
    // Излишек посчитан против остатка участника карточки — вычитаем из его же
    // последней строки, а не из строки «за другого» (чек-лист v3, п.3/7)
    const rows = [...document.querySelectorAll('#payRows .pay-row')].filter(r => rowPid(r) === card.id);
    const row = rows[rows.length - 1];
    if (!row) return;
    const валюта = row.querySelector('.pay-currency').value;
    const переплатаInr = текущаяПереплатаInr();
    if (переплатаInr <= 0) return;
    const курс = rowRateInr(row);
    const излишек = Math.round(переплатаInr / курс * 100) / 100;
    const поле = row.querySelector('.pay-amount');
    const было = Number(поле.value) || 0;
    if (излишек >= было) return;
    поле.value = Math.round((было - излишек) * 100) / 100;
    поле.dataset.touched = '1';
    payDonation = {
        amount: излишек, currency: валюта,
        account_id: row.querySelector('.pay-account').value,
        channel: row.querySelector('.pay-channel').value || 'cash'
    };
    const инфо = document.getElementById('payDonationInfo');
    if (инфо) инфо.textContent = FinUtils.fmtMoney(излишек, валюта);
    document.getElementById('payDonationWrap')?.classList.remove('hidden');
    updatePayRunningTotal();
}

function removeDonation() {
    if (payDonation) {
        // вернуть излишек в строку, из которой он был вычтен
        const rows = [...document.querySelectorAll('#payRows .pay-row')].filter(r => rowPid(r) === card.id);
        const row = rows.find(r => r.querySelector('.pay-account').value === payDonation.account_id) || rows[rows.length - 1];
        if (row) {
            const поле = row.querySelector('.pay-amount');
            поле.value = Math.round(((Number(поле.value) || 0) + payDonation.amount) * 100) / 100;
        }
    }
    payDonation = null;
    document.getElementById('payDonationWrap')?.classList.add('hidden');
    updatePayRunningTotal();
}

// Переплата против остатка участника карточки, в ₹ (для prefill сдачи/пожертвования)
function текущаяПереплатаInr() {
    let итогInr = 0;
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        if (rowPid(row) !== card.id) return;
        итогInr += (Number(row.querySelector('.pay-amount').value) || 0) * rowRateInr(row);
    });
    const p = participants.find(x => x.participant_id === card.id);
    const остаток = Math.max(Number(p?.balance?.net) || 0, 0);
    return Math.max(итогInr - остаток, 0);
}

// Опорная валюта всего платежа: «сегодня гость платит в долларах» — новые
// строки и остаток считаются в ней; строку можно перевести в другую валюту точечно
function onBaseCurrencyChange() {
    const cur = document.getElementById('payBaseCurrency').value;
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        row.querySelector('.pay-currency').value = cur;
        onPayCurrencyChange(row);
        updateRowHint(row);
    });
    updatePayRunningTotal();
}

// Живой пересчёт строк в опорную валюту (ТЗ 3.3). Курс строки — тот же, каким
// платёж и будет проведён: цена CRM или курс ретрита (чек-лист v3, п.1/6).
function updatePayRunningTotal() {
    const el = document.getElementById('payRunningTotal');
    if (!el) return;
    const rows = [...document.querySelectorAll('#payRows .pay-row')];
    if (!rows.length) { el.innerHTML = ''; return; }
    const опорная = document.getElementById('payBaseCurrency')?.value || rows[0].querySelector('.pay-currency').value;
    const изInr = v => v / (retreatRates[опорная] || 1);
    let итогInr = 0;
    let главногоInr = 0;   // строки участника карточки — против его остатка
    const поВалютам = {};
    rows.forEach(row => {
        const c = row.querySelector('.pay-currency').value;
        const v = Number(row.querySelector('.pay-amount').value) || 0;
        if (!v) return;
        поВалютам[c] = (поВалютам[c] || 0) + v;
        const вInr = v * rowRateInr(row);
        итогInr += вInr;
        if (rowPid(row) === card.id) главногоInr += вInr;
    });
    if (!итогInr) { el.innerHTML = ''; return; }
    // Сдача уменьшает то, что реально засчитывается участнику
    let сдачаInr = 0;
    const changeWrap = document.getElementById('payChangeWrap');
    if (changeWrap && !changeWrap.classList.contains('hidden')) {
        const сумма = Number(document.getElementById('payChangeAmount').value) || 0;
        сдачаInr = сумма * (retreatRates[document.getElementById('payChangeCurrency').value] || 1);
        главногоInr -= сдачаInr;
        итогInr -= сдачаInr;
    }
    const детали = Object.entries(поВалютам).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ');
    const p = participants.find(x => x.participant_id === card.id);
    const остаток = Number(p?.balance?.net) || 0;
    const после = изInr(Math.max(остаток, 0) - главногоInr);
    const хвост = после > 0.01
        ? ` · ${t('fin_remaining_after')}: <b class="text-error">${FinUtils.fmtMoney(после, опорная)}</b>`
        : после < -0.01
            ? ` · ${t('fin_overpaid')}: <b class="text-success">${FinUtils.fmtMoney(-после, опорная)}</b>`
            : ` · <b class="text-success">0</b>`;
    // Переплата — не тупик: тут же выдать сдачу или оставить пожертвованием (п.2–3)
    const переплата = после < -0.01 && !payDonation && (!changeWrap || changeWrap.classList.contains('hidden'));
    const кнопки = переплата
        ? ` <button type="button" class="btn btn-xs btn-outline btn-warning ml-2" data-payact="change">${t('fin_change_give')}</button>
           <button type="button" class="btn btn-xs btn-outline btn-success" data-payact="donate">${t('fin_keep_as_donation')}</button>`
        : '';
    const строкаСдачи = сдачаInr > 0 ? ` · ${t('fin_change')}: <b class="text-warning">−${FinUtils.fmtMoney(изInr(сдачаInr), опорная)}</b>` : '';
    // Зачёт показываем в ₹ — валюте учёта: платёж по цене CRM зачитывается не по
    // курсу ретрита, и «₽ 21 500 ≈ ₽ 20 455» только путал бы (чек-лист v3, п.1)
    el.innerHTML = `${t('fin_running_total')}: <b>${детали}</b> ≈ ${FinUtils.fmtMoney(итогInr, 'INR')}${строкаСдачи}${хвост}${кнопки}`;
    // Та же сводка видна над кнопкой «Сохранить» — глазами, до подтверждения (п. 8)
    const чек = document.getElementById('paySummaryLine');
    if (чек) chек_set(чек, детали, итогInr, 'INR');
}
function chек_set(el, детали, итог, опорная) {
    const людей = new Set([...document.querySelectorAll('#payRows .pay-row')].map(r => r.querySelector('.pay-person-id')?.value || 'me')).size;
    el.textContent = `${t('fin_pay_total_check')}: ${детали}${людей > 1 ? ' ' + t('fin_for_n_people').replace('{n}', людей) : ''}`;
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

// ==================== СПИСАНИЕ ОСТАТКА ДОЛГА (чек-лист v3, п.3) ====================
// Не тихое обнуление: та же механика, что «Перерасчёт» — старое начисление
// отменяется с записью «было → стало», новое несёт увеличенную скидку с причиной.
function openWriteOff(kind) {
    const p = participants.find(x => x.participant_id === card.id);
    const остаток = Number(p?.balance?.blocks?.[kind]?.balance) || 0;
    if (остаток <= 0) return;
    document.getElementById('writeOffKind').value = kind;
    document.getElementById('writeOffInfo').textContent =
        `${card.name} · ${blockLabel(kind)} · ${t('fin_balance')}: ${FinUtils.fmtMoney(остаток, 'INR')}`;
    const поле = document.getElementById('writeOffAmount');
    поле.value = остаток;
    поле.max = остаток;
    document.getElementById('writeOffReason').value = '';
    document.getElementById('writeOffModal').showModal();
}

async function submitWriteOff(ev) {
    ev.preventDefault();
    const kind = document.getElementById('writeOffKind').value;
    const сумма = Number(document.getElementById('writeOffAmount').value) || 0;
    const причина = document.getElementById('writeOffReason').value.trim();
    if (сумма <= 0 || !причина) return;
    // Новейшее активное начисление блока, чей «К оплате» покрывает списание
    const кандидат = Object.values(cardChargesById)
        .filter(c => c.kind === kind && !c.is_cancelled && Number(c.net_amount) >= сумма)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!кандидат) {
        Layout.showNotification(t('fin_write_off_no_charge'), 'warning');
        return;
    }
    const новаяСкидка = Math.round((Number(кандидат.discount_amount || 0) + сумма) * 100) / 100;
    const стало = Number(кандидат.net_amount) - сумма;
    const res = await FinUtils.rpc('fin_create_charge', { rows: [{
        id: FinUtils.newRequestId(),
        participant_id: card.id,
        retreat_id: currentRetreat,
        kind,
        description: кандидат.description,
        quantity: кандидат.quantity,
        unit_price: кандидат.unit_price,
        discount_amount: новаяСкидка,
        discount_reason: `${t('fin_write_off_title')}: ${причина}`,
        agreed_with: кандидат.agreed_with || null,
        creation_reason: `Списание остатка долга ${FinUtils.fmtMoney(сумма, 'INR')} — ${причина}`
    }]});
    if (res?.ok) {
        await FinUtils.rpc('fin_cancel_charge', {
            charge_id: кандидат.id,
            reason: `Списание остатка долга: было ${FinUtils.fmtMoney(кандидат.net_amount, 'INR')} → стало ${FinUtils.fmtMoney(стало, 'INR')}. ${причина}`
        });
    }
    if (FinUtils.handleResult(res)) {
        document.getElementById('writeOffModal').close();
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
        if (cancelBtn) { openCancelCharge(cancelBtn.dataset.cancelCharge, cancelBtn.dataset.desc); return; }
        const recalcBtn = ev.target.closest('[data-recalc-charge]');
        if (recalcBtn) { openRecalc(recalcBtn.dataset.recalcCharge); return; }
        const writeOffBtn = ev.target.closest('[data-writeoff]');
        if (writeOffBtn) { openWriteOff(writeOffBtn.dataset.writeoff); return; }
        // Кнопки «Выдать сдачу» / «Оставить как пожертвование» при переплате (п.2–3)
        const payAct = ev.target.closest('[data-payact]');
        if (payAct) payAct.dataset.payact === 'change' ? openChangeBlock() : keepAsDonation();
    });
    document.getElementById('writeOffForm').addEventListener('submit', FinUtils.lockedSubmit(submitWriteOff));
    document.getElementById('payChangeAmount').addEventListener('input', updatePayRunningTotal);

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

window.FinParticipants = { openCharge, closeCharge, openPayment, closePayment, addChargeRow, addPayRow, addOtherParticipantRow, syncFromCrm, copySummary, openRecalc, onBaseCurrencyChange, removeChange, removeDonation };
init();
})();
