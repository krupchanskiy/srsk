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
    // сдача не относится к блоку — в истории у неё прочерк (ВГ, 25.08)
    if (!kind || kind === 'none') return '—';
    return t('fin_block_' + kind);
}

function fmtNet(n, cur = 'INR') {
    const v = Number(n) || 0;
    const s = FinUtils.fmtMoney(Math.abs(v), cur);
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
        if (pFilter === 'paid') {
            const начислено = BLOCKS.reduce((a, k) => a + (Number(p.balance.blocks?.[k]?.charged) || 0), 0);
            if (Math.abs(net) > 0.005 || начислено <= 0) return false;
        }
        if (query && !(p.name || '').toLowerCase().includes(query)) return false;
        return true;
    });
    list.sort((a, b) => {
        if (pSort.key === 'name') return (a.name || '').localeCompare(b.name || '') * (pSort.dir === 'asc' ? 1 : -1);
        return (Number(a.balance.net) - Number(b.balance.net)) * (pSort.dir === 'asc' ? 1 : -1);
    });
    body.innerHTML = list.map(p => {
        const b = p.balance;
        // Закрытый блок отмечаем галочкой, а не прочерком: прочерк одинаково
        // выглядит и у оплаченного, и у того, кому ничего не начисляли (ВГ, 26.08)
        const ячейка = k => {
            const блок = b.blocks[k];
            if (Math.abs(Number(блок.balance)) < 0.005 && Number(блок.charged) > 0) {
                return `<span class="text-success" title="${t('fin_paid')}">${FinUtils.ICONS.check}</span>`;
            }
            return fmtNet(блок.balance);
        };
        return `<tr class="cursor-pointer hover:bg-base-200" data-pid="${p.participant_id}" tabindex="0">
            <td class="font-medium">${e(p.name || '')}</td>
            ${BLOCKS.map(k => `<td class="text-right">${ячейка(k)}</td>`).join('')}
            <td class="text-right">${fmtNet(Number(b.general_debt) - Number(b.general_advance))}</td>
            <td class="text-right font-semibold">${fmtNetWord(b.net, 'INR', b)}</td>
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

// Итог со словом: «Долг ₹N» / «Аванс ₹N» — знак и цвет не спорят друг с другом.
// Ноль при наличии начислений — это «Оплачено», а не пустота (ВГ, 26.08)
function fmtNetWord(n, cur = 'INR', balance) {
    const v = Number(n) || 0;
    const s = FinUtils.fmtMoney(Math.abs(v), cur);
    if (v > 0) return `<span class="badge badge-error badge-outline whitespace-nowrap font-mono">${t('fin_debt')} ${s}</span>`;
    if (v < 0) return `<span class="badge badge-success badge-outline whitespace-nowrap font-mono">${t('fin_advance')} ${s}</span>`;
    const начислено = balance
        ? BLOCKS.reduce((a, k) => a + (Number(balance.blocks?.[k]?.charged) || 0), 0)
        : 0;
    if (начислено > 0) {
        return `<span class="badge badge-success badge-outline whitespace-nowrap gap-1">${FinUtils.ICONS.check} ${t('fin_paid')}</span>`;
    }
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
    renderCardCurrencyBtns();
    // Баланс тянем с сервера: список мог устареть после платежей, и карточка
    // показывала нули при живых начислениях (ВГ, 28.08)
    const { data: свежий } = await Layout.db.rpc('fin_get_participant_balance',
        { p_participant: card.id, p_retreat: currentRetreat });
    if (свежий) {
        const inList = participants.find(x => x.participant_id === card.id);
        if (inList) inList.balance = свежий;
        renderCardBlocks(свежий);
    }
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
    loadCardCompanions();
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
    // Сводка в валюте пересчитывается по ценам CRM — теперь, когда расчёт загружен
    if (cardCurrency !== 'INR') {
        const p = participants.find(x => x.participant_id === card.id);
        if (p) renderCardBlocks(p.balance);
    }
    // и расшифровка курсов в истории платежей: она опирается на цены из расчёта
    if (card.payments?.length) renderCardPayments();
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

// Валюта сводных карточек блоков (замечание ВГ 24.08): «в той валюте, в которой
// человек хочет оплатить». Пересчёт по цене CRM каждого блока (не по курсу
// ретрита) — тогда цифры сводки совпадают с подстановкой в форме платежа.
let cardCurrency = 'INR';

function renderCardCurrencyBtns() {
    const el = document.getElementById('cardCurrencyBtns');
    if (!el) return;
    const active = FinUtils.refs.currencies.filter(c => c.is_active !== false);
    const list = active.length ? active : [{ code: 'INR' }];
    el.innerHTML = list.map(c =>
        `<button type="button" class="join-item btn btn-xs ${c.code === cardCurrency ? 'btn-active' : ''}" data-cardcur="${e(c.code)}">${e(FinUtils.symbol(c.code))}</button>`
    ).join('');
}

// Автовалюта блока (ВГ, 24.08): строка платежа участника задаёт валюту его
// блока в сводке — «Николай вносит проживание в рублях → блок в рублях».
// Блоки без строки показываются в валюте переключателя.
let blockFormCurrency = {};
let формСлепок = '';
function syncBlockCurrencies() {
    blockFormCurrency = {};
    const части = [];
    const секция = document.getElementById('paySection');
    if (секция && !секция.classList.contains('hidden')) {
        document.querySelectorAll('#payRows .pay-row').forEach(row => {
            const pid = rowPid(row);
            const kind = row.querySelector('.pay-kind').value;
            const cur = row.querySelector('.pay-currency').value;
            // сумма входит в слепок: «доп сумма» в блоке пересчитывается по ходу ввода
            части.push(`${pid}|${kind}|${cur}|${row.querySelector('.pay-amount').value}`);
            if (pid === card.id) blockFormCurrency[kind] = cur;
        });
    }
    const слепок = части.join(';');
    if (слепок === формСлепок) return;
    формСлепок = слепок;
    const p = participants.find(x => x.participant_id === card.id);
    if (p) renderCardBlocks(p.balance);
    // мини-разбивки добавленных участников — в валютах их строк
    document.querySelectorAll('#payRows .pay-row.pay-other').forEach(row => {
        const pid = row.querySelector('.pay-person-id')?.value;
        if (pid && pidData.balance[pid]) renderOtherBreakdown(row, pidData.balance[pid]);
    });
}

// Коэффициент пересчёта блока участника в валюту: цена CRM, иначе курс ретрита
function блокКоэф(pid, kind, cur) {
    if (!cur || cur === 'INR') return 1;
    const calc = pid === card.id ? cardCalc : pidData.calc[pid];
    const f = calc?.blocks?.[kind]?.final;
    if (f && Number(f.INR) > 0 && Number(f[cur]) > 0) return Number(f[cur]) / Number(f.INR);
    return retreatRates[cur] ? 1 / retreatRates[cur] : 1;
}

// Валюта, выбранная в форме для блока данного участника (последняя строка)
function формнаяВалютаБлока(pid, kind) {
    let cur = null;
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        if (rowPid(row) === pid && row.querySelector('.pay-kind').value === kind) {
            cur = row.querySelector('.pay-currency').value;
        }
    });
    return cur;
}

// Разложение остатка блока по валютам (ВГ, 24.08): «сумма к оплате в рублях, а
// доплата в другой валюте — доп суммой». Введённые строки формы идут своими
// валютами, непокрытый хвост — в валюте последней строки блока.
// Без формы — одна часть в валюте блока.
function разложениеБлока(pid, kind, balanceInr, валютаПоУмолчанию) {
    const части = [];
    let остатокInr = balanceInr;
    let последняя = null;
    const секция = document.getElementById('paySection');
    if (секция && !секция.classList.contains('hidden')) {
        document.querySelectorAll('#payRows .pay-row').forEach(row => {
            if (rowPid(row) !== pid || row.querySelector('.pay-kind').value !== kind) return;
            последняя = row.querySelector('.pay-currency').value;
            const v = Number(row.querySelector('.pay-amount').value) || 0;
            if (v <= 0) return;
            части.push({ cur: последняя, v });
            остатокInr -= v * rowRateInr(row);
        });
    }
    const cur = последняя || валютаПоУмолчанию;
    if (Math.abs(остатокInr) > 0.005 || !части.length) {
        части.push({ cur, v: остатокInr * блокКоэф(pid, kind, cur) });
    }
    // одинаковые валюты складываем: «₽ 100 + ₽ 50» читается как ошибка
    const свёрнуто = [];
    for (const ч of части) {
        const есть = свёрнуто.find(x => x.cur === ч.cur);
        if (есть) есть.v += ч.v; else свёрнуто.push({ ...ч });
    }
    return свёрнуто.filter(x => Math.abs(x.v) > 0.005);
}

function фмтЧасти(части, валютаЕслиПусто) {
    if (!части.length) return FinUtils.fmtMoney(0, валютаЕслиПусто);
    return части.map(x => FinUtils.fmtMoney(x.v, x.cur)).join(' + ');
}

// Несколько валют — столбиком, друг под другом: в линейку они слипаются и
// последние суммы не видны (ВГ, 24.08)
function фмтЧастиHtml(части, валютаЕслиПусто, cls = '') {
    if (!части.length) return `<span class="font-mono ${cls}">${FinUtils.fmtMoney(0, валютаЕслиПусто)}</span>`;
    if (части.length === 1) return `<span class="font-mono ${cls}">${FinUtils.fmtMoney(части[0].v, части[0].cur)}</span>`;
    return `<span class="font-mono ${cls} flex flex-col items-end leading-tight">${
        части.map(x => `<span class="whitespace-nowrap">${FinUtils.fmtMoney(x.v, x.cur)}</span>`).join('')}</span>`;
}

// То же для карты «валюта → сумма» (итоговые долг/аванс)
function фмтВалHtml(m, валютаЕслиПусто, cls = '') {
    return фмтЧастиHtml(Object.entries(m).map(([cur, v]) => ({ cur, v })), валютаЕслиПусто, cls);
}

function renderCardBlocks(b) {
    const isAdmin = window.hasPermission?.('fin_admin');
    const валютаБлока = k => blockFormCurrency[k] || cardCurrency;
    // Коэффициент блока: своя цена CRM в его валюте; без цены — курс ретрита
    const кБлоку = k => {
        const cur = валютаБлока(k);
        if (cur === 'INR') return 1;
        const f = cardCalc?.blocks?.[k]?.final;
        if (f && Number(f.INR) > 0 && Number(f[cur]) > 0) return Number(f[cur]) / Number(f.INR);
        return retreatRates[cur] ? 1 / retreatRates[cur] : 1;
    };
    const cell = (k, block) => {
        const kx = кБлоку(k);
        const cardCur = валютаБлока(k);
        // Часть долга блока могла быть погашена «Общим» платежом (зачёт по
        // приоритету блоков, ТЗ 7) — показываем это явно, иначе «Оплачено 0 /
        // Остаток 0» при активном начислении выглядит как ошибка.
        // «зачтено из общего» — платежи без блока; «из аванса» — переплата
        // соседнего блока, погасившая долг этого (ВГ, 25.08)
        const fromOffset = Number(block.offset) || 0;
        const fromGeneral = Math.max(0, (Number(block.charged) - Number(block.paid)) - Number(block.balance) - fromOffset);
        const balance = Number(block.balance);
        // Остаток блока с разложением по валютам: основная сумма + доплата (ВГ, 24.08)
        const части = разложениеБлока(card.id, k, balance, cardCur);
        const мульти = части.length > 1;
        const balanceHtml = balance === 0 && Number(block.charged) > 0
            ? `<span class="font-mono">${FinUtils.fmtMoney(0, cardCur)}</span>`
            : мульти
                ? фмтЧастиHtml(части, cardCur, 'text-error')
                : fmtNet(balance * kx, cardCur);
        // Небольшой остаток долга можно простить — «Списать»; переплату по блоку —
        // оставить пожертвованием пост-фактум (чек-лист v3, п.3; ВГ 24.08)
        const списать = isAdmin && balance > 0
            ? `<button type="button" class="btn btn-ghost btn-xs text-error px-1 -mr-1" data-writeoff="${k}" title="${t('fin_write_off_title')}">${t('fin_write_off')}</button>`
            : isAdmin && balance < 0
            ? `<button type="button" class="btn btn-ghost btn-xs text-success px-1 -mr-1" data-donate-advance="${k}" title="${t('fin_keep_as_donation')}">${t('fin_type_donation')}</button>`
            : '';
        return `
        <div class="border border-base-300 rounded-lg p-2">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1 flex justify-between items-center gap-1">${blockLabel(k)}${списать}</div>
            <div class="text-xs flex justify-between gap-2"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(Number(block.charged) * kx, cardCur)}</span></div>
            <div class="text-xs flex justify-between gap-2"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(Number(block.paid) * kx, cardCur)}</span></div>
            ${fromGeneral > 0 ? `<div class="text-xs flex justify-between gap-2 text-success"><span>${t('fin_from_general')}</span><span class="font-mono">${FinUtils.fmtMoney(fromGeneral * kx, cardCur)}</span></div>` : ''}
            ${fromOffset > 0 ? `<div class="text-xs flex justify-between gap-2 text-success"><span>${t('fin_from_advance')}</span><span class="font-mono">${FinUtils.fmtMoney(fromOffset * kx, cardCur)}</span></div>` : ''}
            <div class="text-sm flex justify-between gap-2 mt-1 pt-1 border-t border-base-200 items-start"><span>${t('fin_balance')}</span>${balanceHtml}</div>
        </div>`;
    };
    // Итог собирает долг по валютам блоков — «сколько человек должен в конкретных
    // валютах» (ВГ, 24.08): проживание в ₽, питание в ₹ → «₽ 24 366,67 + ₹ 11 900»
    const kОбщ = cardCurrency === 'INR' ? 1 : (retreatRates[cardCurrency] ? 1 / retreatRates[cardCurrency] : 1);
    const долгВал = {}, авансВал = {};
    BLOCKS.forEach(k => {
        // итог собирается из тех же частей, что показаны в блоке — включая доплаты
        разложениеБлока(card.id, k, Number(b.blocks[k].balance), валютаБлока(k)).forEach(({ cur, v }) => {
            if (v > 0.005) долгВал[cur] = (долгВал[cur] || 0) + v;
            else if (v < -0.005) авансВал[cur] = (авансВал[cur] || 0) - v;
        });
    });
    if (Number(b.general_debt) > 0) долгВал[cardCurrency] = (долгВал[cardCurrency] || 0) + Number(b.general_debt) * kОбщ;
    if (Number(b.general_advance) > 0) авансВал[cardCurrency] = (авансВал[cardCurrency] || 0) + Number(b.general_advance) * kОбщ;
    const totalNet = Number(b.net) || 0;
    // Итог — чистая позиция: долг одного блока гасится авансом другого. Раньше
    // показывался только аванс целиком, и «Долг ₹1 900 + Аванс ₹2 251 = Аванс
    // ₹2 251» выглядело как потерянный долг (ВГ, 24.08).
    const неттоВал = {};
    const плюс = (cur, v) => { неттоВал[cur] = (неттоВал[cur] || 0) + v; };
    Object.entries(долгВал).forEach(([cur, v]) => плюс(cur, v));
    Object.entries(авансВал).forEach(([cur, v]) => плюс(cur, -v));
    Object.keys(неттоВал).forEach(cur => { if (Math.abs(неттоВал[cur]) < 0.005) delete неттоВал[cur]; });
    const частиИтога = Object.entries(неттоВал).map(([cur, v]) => ({ cur, v }));
    const всеДолг = частиИтога.length && частиИтога.every(x => x.v > 0);
    const всеАванс = частиИтога.length && частиИтога.every(x => x.v < 0);
    const подпись = всеДолг ? t('fin_debt') : всеАванс ? t('fin_advance') : t('fin_total');
    const цвет = всеДолг ? 'text-error' : всеАванс ? 'text-success' : '';
    // при чистом авансе показываем модуль — знак и слово не должны спорить
    const показИтога = частиИтога.map(x => ({ cur: x.cur, v: всеАванс ? -x.v : x.v }));
    const начисленоВсего = BLOCKS.reduce((a, k) => a + (Number(b.blocks[k].charged) || 0), 0);
    const итогHtml = !частиИтога.length
        ? (начисленоВсего > 0
            ? `<span class="badge badge-success badge-outline whitespace-nowrap gap-1">${FinUtils.ICONS.check} ${t('fin_paid')}</span>`
            : `<span class="font-mono opacity-40">—</span>`)
        : частиИтога.length > 1
            ? `<span class="text-right"><span class="text-[11px] uppercase opacity-60 ${цвет}">${подпись}</span>
               ${фмтЧастиHtml(показИтога, cardCurrency, `${цвет} font-semibold`)}</span>`
            : `<span class="badge ${всеДолг ? 'badge-error' : 'badge-success'} badge-outline whitespace-nowrap font-mono">${подпись} ${фмтЧасти(показИтога, cardCurrency)}</span>`;
    // «Факт списания долга» одной операцией из итога (ВГ, 24.08): долги блоков
    // списываются, авансы оформляются пожертвованием — карточка закрывается в ноль
    const списатьВсё = isAdmin && totalNet > 0
        ? `<button type="button" class="btn btn-ghost btn-xs text-error px-1 -mr-1" data-writeoff-all="1" title="${t('fin_write_off_title')}">${t('fin_write_off')}</button>`
        // Аванс тоже закрывается из итога — раньше кнопка была только в блоке,
        // и её искали здесь (ВГ, 28.08)
        : isAdmin && totalNet < 0
        ? `<button type="button" class="btn btn-ghost btn-xs text-success px-1 -mr-1" data-donate-all="1" title="${t('fin_keep_as_donation')}">${t('fin_type_donation')}</button>`
        : '';
    document.getElementById('cardBlocks').innerHTML =
        BLOCKS.map(k => cell(k, b.blocks[k])).join('') +
        `<div class="border-2 rounded-lg p-2 ${totalNet > 0 ? 'border-error' : totalNet < 0 ? 'border-success' : 'border-base-300'}">
            <div class="text-xs font-semibold uppercase opacity-60 mb-1 flex justify-between items-center gap-1">${t('fin_total')}${списатьВсё}</div>
            <div class="text-xs flex justify-between gap-2 items-start"><span>${t('fin_debt')}</span>${фмтВалHtml(долгВал, cardCurrency)}</div>
            <div class="text-xs flex justify-between gap-2 items-start"><span>${t('fin_advance')}</span>${фмтВалHtml(авансВал, cardCurrency)}</div>
            <div class="text-sm flex justify-between gap-2 mt-1 pt-1 border-t border-base-200 items-start"><span>${t('fin_total')}</span>${итогHtml}</div>
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
            <td class="whitespace-nowrap">${e(blockLabel(c.kind))}<div class="text-xs opacity-50">${c.occurred_on ? DateUtils.formatShort(DateUtils.parseDate(c.occurred_on)) : ''}</div></td>
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

// «Откуда он эти курсы берёт?» (ВГ, 24.08): курс платежа — не из справочника,
// а следствие прайса CRM: питание $128 = ₹11 200 даёт 87,5. Пишем это словами,
// иначе дробное число выглядит взятым с потолка.
function объяснитьКурс(p) {
    const cur = p.currency_code;
    const rate = Number(p.rate_used);
    const число = n => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 4 });
    const f = cardCalc?.blocks?.[p.balance_kind]?.final;
    if (f && Number(f[cur]) > 0 && Number(f.INR) > 0
        && Math.abs(rate - Number(f.INR) / Number(f[cur])) < 0.01) {
        return `${t('fin_rate_by_crm')}: ${FinUtils.fmtMoney(f[cur], cur)} = ${FinUtils.fmtMoney(f.INR, 'INR')}`;
    }
    if (retreatRates[cur] && Math.abs(rate - Number(retreatRates[cur])) < 0.0001) {
        return `${t('fin_rate_by_retreat')} ${число(rate)}`;
    }
    if (p.source === 'crm') return `${t('fin_rate_crm_historic')} ${число(rate)}`;
    return `${t('fin_at_rate')} ${число(rate)}`;
}

async function loadCardPayments() {
    const { data, error } = await Layout.db.rpc('fin_get_participant_payments', { p_participant: card.id, p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Платежи'); return; }
    card.payments = data || [];
    renderCardPayments();
}

function renderCardPayments() {
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
            <td class="text-right font-mono ${p.direction === 'out' ? 'text-warning' : ''}">${p.direction === 'out' ? '−' : ''}${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.currency_code !== 'INR' ? `<div class="text-xs opacity-70">${объяснитьКурс(p)} → ₹ ${Number(p.amount_base).toLocaleString('ru-RU')}</div>` : ''}</td>
            <td class="whitespace-nowrap">${e(куда(p))}</td>
            <td>${statusBadge(p.status)}</td>
            <td class="text-right">${isAdmin && p.type === 'payment' && p.direction !== 'out' && p.operation_id ? `<a class="btn btn-ghost btn-xs" href="dds.html?op=${p.operation_id}" title="${t('fin_realloc_action')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/></svg>
            </a>` : ''}${isAdmin && p.type === 'payment' && Number(p.available_to_refund) > 0 ? `<button class="btn btn-ghost btn-xs" data-refund="${p.posting_id}" title="${t('fin_refund')}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/></svg>
            </button>` : ''}</td>
        </tr>`).join('') || `<tr><td colspan="7" class="text-center py-3 opacity-60">${t('fin_no_payments')}</td></tr>`;
}

// «Платили вместе» (ВГ, 25.08): в карточке не было видно спутника, за которого
// шла общая оплата, и его долг оставался незамеченным
async function loadCardCompanions() {
    const el = document.getElementById('cardCompanions');
    if (!el) return;
    el.innerHTML = '';
    const операции = [...new Set((card.payments || []).map(p => p.operation_id).filter(Boolean))];
    if (!операции.length) return;
    const { data } = await Layout.db.from('fin_v_account_ledger')
        .select('participant_id, participant_name, operation_id')
        .in('operation_id', операции)
        .not('participant_id', 'is', null);
    const другие = [...new Map((data || [])
        .filter(x => x.participant_id !== card.id)
        .map(x => [x.participant_id, x])).values()];
    if (!другие.length) return;
    const балансы = await Promise.all(другие.map(async x => {
        const { data: b } = await Layout.db.rpc('fin_get_participant_balance',
            { p_participant: x.participant_id, p_retreat: currentRetreat });
        return { ...x, net: Number(b?.net) || 0, balance: b };
    }));
    // Парная оплата: долги и история спутников видны прямо здесь, без ухода
    // из карточки — «чтобы видеть всю историю платежа и задолженности за двоих»
    // (ВГ, 28.08)
    const мойNet = Number(participants.find(x => x.participant_id === card.id)?.balance?.net) || 0;
    const итогПары = балансы.reduce((a, x) => a + x.net, мойNet);
    const деньги = v => v > 0.005
        ? `<span class="text-error">${t('fin_debt')} ${FinUtils.fmtMoney(v, 'INR')}</span>`
        : v < -0.005
            ? `<span class="text-success">${t('fin_advance')} ${FinUtils.fmtMoney(-v, 'INR')}</span>`
            : `<span class="opacity-60">0</span>`;
    el.innerHTML = `
        <div class="border border-base-300 rounded-lg p-2 mb-2">
            <div class="flex flex-wrap items-center gap-2 text-xs mb-1">
                <span class="opacity-70">${t('fin_paid_together')}</span>
                <span class="ml-auto">${t('fin_pair_total')}: <b>${деньги(итогПары)}</b></span>
            </div>
            ${балансы.map(x => `
                <details class="companion" data-cid="${x.participant_id}">
                    <summary class="text-sm cursor-pointer flex flex-wrap items-center gap-2">
                        <span class="font-medium">${e(x.participant_name || '')}</span>
                        ${деньги(x.net)}
                        <span class="ml-auto flex gap-1">
                            ${x.net < -0.005 && мойNet > 0.005
                                ? `<button type="button" class="btn btn-xs btn-outline btn-success" data-offset-from="${x.participant_id}" title="${t('fin_offset_hint')}">${t('fin_offset_advance')}</button>` : ''}
                            ${x.net > 0.005
                                ? `<button type="button" class="btn btn-xs btn-outline" data-pay-for="${x.participant_id}">${t('fin_pay_for_him')}</button>` : ''}
                            <button type="button" class="btn btn-ghost btn-xs" data-open-participant="${x.participant_id}">${t('fin_open_card')}</button>
                        </span>
                    </summary>
                    <div class="companion-body pt-1"></div>
                </details>`).join('')}
        </div>`;
    // содержимое подгружаем при раскрытии — карточка не должна тормозить
    el.querySelectorAll('details.companion').forEach(det => {
        det.addEventListener('toggle', async () => {
            const тело = det.querySelector('.companion-body');
            if (!det.open || тело.dataset.loaded) return;
            тело.dataset.loaded = '1';
            const данные = балансы.find(x => x.participant_id === det.dataset.cid);
            const блоки = BLOCKS.map(k => {
                const b = данные?.balance?.blocks?.[k];
                if (!b || !(Number(b.charged) || Number(b.paid))) return '';
                return `<div class="border border-base-300 rounded p-1.5 text-[11px]">
                    <div class="font-semibold uppercase opacity-60">${e(blockLabel(k))}</div>
                    <div class="flex justify-between"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(b.charged, 'INR')}</span></div>
                    <div class="flex justify-between"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(b.paid, 'INR')}</span></div>
                    <div class="flex justify-between border-t border-base-200 mt-0.5 pt-0.5"><span>${t('fin_balance')}</span>${fmtNet(b.balance)}</div>
                </div>`;
            }).join('');
            const { data: платежи } = await Layout.db.rpc('fin_get_participant_payments',
                { p_participant: det.dataset.cid, p_retreat: currentRetreat });
            тело.innerHTML =
                `<div class="grid grid-cols-2 md:grid-cols-4 gap-1 mb-1">${блоки}</div>` +
                `<div class="overflow-x-auto"><table class="table table-xs"><tbody>${
                    (платежи || []).map(pp => `<tr class="${pp.is_reversed ? 'opacity-50' : ''}">
                        <td class="whitespace-nowrap">${DateUtils.formatShort(DateUtils.parseDate(pp.occurred_on))}</td>
                        <td>${e(pp.direction === 'out' ? t('fin_change') : FinUtils.typeLabel(pp.type))}</td>
                        <td>${e(blockLabel(pp.balance_kind))}</td>
                        <td class="text-right font-mono">${pp.direction === 'out' ? '−' : ''}${FinUtils.fmtMoney(pp.amount, pp.currency_code)}</td>
                    </tr>`).join('') || `<tr><td class="opacity-60">${t('fin_no_payments')}</td></tr>`
                }</tbody></table></div>`;
        });
    });
}

// Открыть форму платежа сразу со строками спутника: «пишет остаток, но куда
// вносить — этого нет» (ВГ, 28.08)
async function openPaymentFor(pid) {
    openPayment();
    await new Promise(r => setTimeout(r, 150));
    addOtherParticipantRow();
    const row = [...document.querySelectorAll('#payRows .pay-row')].pop();
    const { data } = await Layout.db.from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name').eq('id', pid).maybeSingle();
    if (!data) return;
    row.querySelector('.pay-person').value =
        data.spiritual_name || `${data.first_name || ''} ${data.last_name || ''}`.trim();
    row.querySelector('.pay-person-id').value = pid;
    document.getElementById('paySection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Зачесть аванс спутника в долг владельца карточки: деньги пары уже в кассе,
// поэтому переносим не деньги, а их принадлежность — штатным перераспределением
// платежа (сторно + новый платёж с исправленным распределением)
async function offsetFromCompanion(pid) {
    const мой = Number(participants.find(x => x.participant_id === card.id)?.balance?.net) || 0;
    if (мой <= 0.005) return;
    const { data: b } = await Layout.db.rpc('fin_get_participant_balance',
        { p_participant: pid, p_retreat: currentRetreat });
    const донорNet = Number(b?.net) || 0;
    if (донорNet >= -0.005) return;

    // строки платежей донора по блокам, где у него переплата
    const авансБлоки = BLOCKS.filter(k => Number(b.blocks[k].balance) < -0.005);
    const { data: строки } = await Layout.db.from('fin_v_account_ledger')
        .select('posting_id, operation_id, participant_id, participant_balance_kind, amount, amount_base, account_id, is_reversed, type')
        .eq('participant_id', pid).eq('type', 'payment');
    const годные = (строки || []).filter(x => !x.is_reversed && авансБлоки.includes(x.participant_balance_kind));
    if (!годные.length) { Layout.showNotification(t('fin_offset_no_rows'), 'warning'); return; }

    // берём строки одной операции, пока не покроем долг
    const поОперациям = {};
    годные.forEach(x => (поОперациям[x.operation_id] = поОперациям[x.operation_id] || []).push(x));
    // переносим не больше, чем есть у донора и чем нужно получателю —
    // иначе донор ушёл бы в долг на ровном месте
    const лимит = Math.min(мой, -донорNet);
    let выбор = null;
    for (const [opId, список] of Object.entries(поОперациям)) {
        const набор = [];
        let сумма = 0;
        for (const x of список.sort((a, c) => Number(c.amount_base) - Number(a.amount_base))) {
            if (сумма >= лимит - 0.005) break;
            if (сумма + Number(x.amount_base) > лимит + 0.005) continue;
            набор.push(x); сумма += Number(x.amount_base);
        }
        if (набор.length) { выбор = { opId, набор, сумма }; break; }
    }
    if (!выбор) { Layout.showNotification(t('fin_offset_no_rows'), 'warning'); return; }

    // на какие блоки владельца зачесть — по его долгам, по порядку
    const мойБаланс = participants.find(x => x.participant_id === card.id)?.balance;
    const долги = BLOCKS.map(k => ({ k, v: Number(мойБаланс.blocks[k].balance) || 0 })).filter(x => x.v > 0.005);

    // полное новое распределение операции: чужие строки не трогаем
    const { data: всеСтроки } = await Layout.db.from('fin_v_account_ledger')
        .select('posting_id, participant_id, participant_balance_kind, amount, amount_base')
        .eq('operation_id', выбор.opId);
    const переносимые = new Set(выбор.набор.map(x => x.posting_id));
    let остатокДолга = долги.slice();
    const rows = (всеСтроки || []).map(x => {
        if (!переносимые.has(x.posting_id)) {
            return { participant_id: x.participant_id, participant_balance_kind: x.participant_balance_kind, amount: x.amount };
        }
        // строка уезжает владельцу карточки — на первый непокрытый блок долга
        const цель = остатокДолга.find(d => d.v > 0.005) || { k: долги[0]?.k || 'org_fee', v: 0 };
        цель.v -= Number(x.amount_base);
        return { participant_id: card.id, participant_balance_kind: цель.k, amount: x.amount };
    });

    const сумма = выбор.набор.reduce((a, x) => a + Number(x.amount_base), 0);
    if (!confirm(`${t('fin_offset_advance')}: ${FinUtils.fmtMoney(сумма, 'INR')}\n${t('fin_offset_confirm')}`)) return;
    const res = await FinUtils.rpc('fin_reallocate_payment', {
        operation_id: выбор.opId,
        rows,
        reason: `Зачёт аванса: ${FinUtils.fmtMoney(сумма, 'INR')} с одного участника пары на долг другого`
    });
    if (FinUtils.handleResult(res)) {
        await refreshAfterChange();
        loadCardCompanions();
    }
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
                <div class="flex gap-1">
                    <input type="number" class="input input-bordered input-sm chg-price w-full" min="0" step="0.01" required>
                    <!-- Цена вводится в любой валюте, в учёт идёт ₹ по прайсу CRM (ВГ, 25.08) -->
                    <select class="select select-bordered select-sm chg-currency w-20">${payCurrencyOptions('INR')}</select>
                </div>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_occurred_on')}</span></label>
                <input type="date" class="input input-bordered input-sm chg-date" value="${FinUtils.todayISO()}">
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
        const cur = row.querySelector('.chg-currency').value;
        if (!qty || !price) { totalEl.textContent = ''; return; }
        const total = Math.max(qty * price - disc, 0);
        const вInr = total * ценаВInr(row, 1);
        totalEl.innerHTML = `${t('fin_row_total')}: ${qty} × ${FinUtils.fmtMoney(price, cur)}`
            + (disc > 0 ? ` − ${FinUtils.fmtMoney(disc, cur)}` : '')
            + ` = ${FinUtils.fmtMoney(total, cur)}`
            + (cur !== 'INR' ? ` <span class="opacity-70">≈ ${FinUtils.fmtMoney(вInr, 'INR')}</span>` : '');
    };
    ['.chg-qty', '.chg-price', '.chg-discount'].forEach(sel =>
        row.querySelector(sel).addEventListener('input', recalc));
    row.querySelector('.chg-currency').addEventListener('change', recalc);
    row.querySelector('.chg-kind').addEventListener('change', recalc);
}

// Во сколько рупий обходится единица введённой валюты для этого блока:
// сперва цена блока в прайсе CRM, иначе курс ретрита (ВГ, 25.08)
function ценаВInr(row, единиц) {
    const cur = row.querySelector('.chg-currency').value;
    if (cur === 'INR') return 1;
    const kind = row.querySelector('.chg-kind').value;
    const f = cardCalc?.blocks?.[kind]?.final;
    if (f && Number(f[cur]) > 0 && Number(f.INR) > 0) return Number(f.INR) / Number(f[cur]);
    return retreatRates[cur] || 1;
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
    row.querySelector('.chg-currency').value = 'INR';
    if (c.occurred_on) row.querySelector('.chg-date').value = c.occurred_on;
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
        description: (row.querySelector('.chg-desc').value || '')
            + (row.querySelector('.chg-currency').value !== 'INR'
                ? ` (${row.querySelector('.chg-qty').value} × ${FinUtils.fmtMoney(row.querySelector('.chg-price').value, row.querySelector('.chg-currency').value)})` : '')
            + (
            row.querySelector('.chg-date-from')?.value && row.querySelector('.chg-date-to')?.value
                ? ` (${DateUtils.formatShort(DateUtils.parseDate(row.querySelector('.chg-date-from').value))} — ${DateUtils.formatShort(DateUtils.parseDate(row.querySelector('.chg-date-to').value))})`
                : '') || null,
        quantity: row.querySelector('.chg-qty').value,
        // в учёте рупия: цену из другой валюты пересчитываем по прайсу CRM
        unit_price: Math.round(Number(row.querySelector('.chg-price').value || 0) * ценаВInr(row, 1) * 100) / 100,
        occurred_on: row.querySelector('.chg-date').value || null,
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
    // Новая строка наследует валюту первой строки формы — ту, в которой реально
    // платит гость (ВГ, 24.08). Пока строк нет, берём опорную валюту.
    const первая = document.querySelector('#payRows .pay-row .pay-currency');
    const валюта = первая?.value || document.getElementById('payBaseCurrency')?.value || 'INR';
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

// Когда в форме несколько человек, у каждой строки подписываем, за кого она:
// строка в рупиях ушла владельцу карточки вместо спутника, и деньги легли
// не тому (ВГ, 28.08)
function подписатьСтроки() {
    const строки = [...document.querySelectorAll('#payRows .pay-row')];
    const людей = new Set(строки.map(r => rowPid(r))).size;
    строки.forEach(row => {
        const прежняя = row.querySelector('.pay-owner');
        if (людей < 2 || row.classList.contains('pay-other') || row.classList.contains('pay-child')) {
            прежняя?.remove();
            return;
        }
        if (!прежняя) {
            row.insertAdjacentHTML('afterbegin',
                `<div class="pay-owner text-xs opacity-60 mb-1">${e(card.name || '')}</div>`);
        }
    });
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
    // Если часть блока уже оплачена, показываем разложение «цена − оплачено»:
    // иначе 24 175,56 при цене 24 366,67 выглядит как ошибка (ВГ, 24.08)
    let расшифровка = режим === 'crm_price' ? t('fin_rate_by_crm') : t('fin_rate_by_retreat');
    if (режим === 'crm_price' && cur !== 'INR' && ценаБлока && Number(ценаБлока[cur]) - сумма > 0.01) {
        расшифровка += `: ${FinUtils.fmtMoney(ценаБлока[cur], cur)} − ${t('fin_paid').toLowerCase()} ${FinUtils.fmtMoney(Math.round((Number(ценаБлока[cur]) - сумма) * 100) / 100, cur)}`;
    }
    if (hint) hint.innerHTML = сумма > 0
        ? `${t('fin_block_remaining')}: <b class="font-mono">${FinUtils.fmtMoney(сумма, cur)}</b> <span class="opacity-60">(${расшифровка})</span>`
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
    document.getElementById('payReceivedRows').innerHTML = '';
    pidData.balance = {}; pidData.calc = {};
    removeChange(); removeDonation();
    // Все блоки с долгом сразу: в 99% случаев платят за всё разом (v4, п.9).
    // Закрытые блоки не показываем — пустая строка только мешает; нужен ещё
    // один блок или доплата другой валютой — «+ Добавить» на месте.
    const баланс = participants.find(x => x.participant_id === card.id)?.balance;
    const долги = BLOCKS.filter(k => Number(баланс?.blocks?.[k]?.balance) > 0.005);
    if (долги.length) {
        долги.forEach((k, i) => {
            if (i) addPayRow();
            else addPayRow();
            const row = [...document.querySelectorAll('#payRows .pay-row')].pop();
            row.querySelector('.pay-kind').value = k;
            onPayCurrencyChange(row);
            updateRowHint(row);
        });
    } else {
        addPayRow();
    }
    updatePayRunningTotal();
    closeCharge();
    document.getElementById('paySection').classList.remove('hidden');
    document.getElementById('paySection').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closePayment() {
    document.getElementById('paySection')?.classList.add('hidden');
    // форма закрыта — сводка возвращается к валюте переключателя
    syncBlockCurrencies();
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
            // Начисления добавленного подтягиваются из CRM сразу — иначе у человека,
            // чью карточку ещё не открывали, разбивка пуста (ВГ, 24.08)
            if (window.hasPermission?.('fin_admin')) {
                await Layout.db.rpc('fin_sync_charges_from_crm',
                    { p_participant: hid.value, p_retreat: currentRetreat });
            }
            // после синка баланс берём свежий с сервера, а не из списка страницы
            const { data: свежий } = await Layout.db.rpc('fin_get_participant_balance',
                { p_participant: hid.value, p_retreat: currentRetreat });
            if (свежий) pidData.balance[hid.value] = свежий;
            const { balance } = await ensurePidData(hid.value);
            row.querySelector('.pay-person-balance').innerHTML = fmtNet(Number(balance?.net) || 0);
            renderOtherBreakdown(row, balance);
            loadOtherHistory(row, hid.value);
            delete row.querySelector('.pay-amount').dataset.touched;
            // все блоки с долгом сразу: первый — в эту строку, остальные — своими
            const долги = BLOCKS.filter(k => Number(balance?.blocks?.[k]?.balance) > 0.005);
            const валюта = row.querySelector('.pay-currency').value;
            if (долги.length) {
                row.querySelector('.pay-kind').value = долги[0];
                onPayCurrencyChange(row);
            }
            updateRowHint(row);
            const имя = row.querySelector('.pay-person')?.value || '';
            долги.slice(1).forEach(k => добавитьДочернююСтроку(hid.value, имя, k, валюта));
            updatePayRunningTotal();
        }
    }, 500);
}

// Строка платежа для уже выбранного участника: тот же человек, другой блок.
// Нужна, чтобы за второго гостя заполнялись все его блоки, а не один (ВГ, 24.08)
function добавитьДочернююСтроку(pid, имя, kind, валюта) {
    const wrap = document.getElementById('payRows');
    wrap.insertAdjacentHTML('beforeend', payRowHtml(wrap.children.length));
    const row = wrap.lastElementChild;
    row.classList.add('pay-child');
    row.dataset.personName = имя;
    row.insertAdjacentHTML('afterbegin',
        `<input type="hidden" class="pay-person-id" value="${e(pid)}">
         <div class="text-xs opacity-60 mb-1">${e(имя)}</div>`);
    row.querySelector('.pay-kind').value = kind;
    row.querySelector('.pay-currency').value = валюта;
    onPayCurrencyChange(row);
    updateRowHint(row);
    return row;
}

// Мини-версия сводки по блокам добавленного участника (Начислено/Оплачено/Остаток).
// Валюта блока подхватывается из его строк формы — та же автологика, что у
// главного участника (ВГ, 24.08)
function renderOtherBreakdown(row, balance) {
    const el = row.querySelector('.pay-other-blocks');
    if (!el || !balance?.blocks) return;
    const pid = row.querySelector('.pay-person-id')?.value;
    el.innerHTML = BLOCKS.map(k => {
        const b = balance.blocks[k];
        if (!(Number(b.charged) || Number(b.paid))) return '';
        const cur = формнаяВалютаБлока(pid, k) || 'INR';
        const kx = блокКоэф(pid, k, cur);
        const части = разложениеБлока(pid, k, Number(b.balance), cur);
        const остатокHtml = части.length > 1
            ? фмтЧастиHtml(части, cur, 'text-error')
            : fmtNet(Number(b.balance) * kx, cur);
        return `<div class="border border-base-300 rounded p-1.5 text-[11px]">
            <div class="font-semibold uppercase opacity-60">${e(blockLabel(k))}</div>
            <div class="flex justify-between"><span>${t('fin_charged')}</span><span class="font-mono">${FinUtils.fmtMoney(Number(b.charged) * kx, cur)}</span></div>
            <div class="flex justify-between"><span>${t('fin_paid')}</span><span class="font-mono">${FinUtils.fmtMoney(Number(b.paid) * kx, cur)}</span></div>
            <div class="flex justify-between gap-1 border-t border-base-200 mt-0.5 pt-0.5"><span>${t('fin_balance')}</span>${остатокHtml}</div>
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
    details.open = список.length > 0;   // история видна сразу, не спрятана (ВГ, 24.08)
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

    // В кассу проводим ровно принятое: если денег принесли меньше расчёта,
    // строки урезаются, а разница остаётся долгом участника (ВГ, 25.08)
    const { правки, долг } = урезкаПоПолученному();
    if (правки.size) {
        const текст = Object.entries(долг)
            .map(([k, x]) => `${blockLabel(k)} ${FinUtils.fmtMoney(x.v, x.cur)}`).join(' + ');
        if (!confirm(`${t('fin_will_credit')}: ${Object.entries(полученоПоВалютам())
            .map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}\n${t('fin_will_remain_debt')}: ${текст}\n${t('fin_pay_confirm_q')}`)) return;
        правки.forEach((сумма, row) => { row.querySelector('.pay-amount').value = сумма; });
    }

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

    // Сдача (v3 п.2; v4 п.11): сколько угодно строк, разные валюты
    const change = [...document.querySelectorAll('#payChangeRows .chg-line')].map(line => ({
        id: FinUtils.newRequestId(),
        account_id: line.querySelector('.chgline-account').value,
        amount: Number(line.querySelector('.chgline-amount').value) || 0,
        participant_id: payer,
        object_id: objectId,
        participant_balance_kind: 'none',   // сдача возвращает деньги, не зачтённые на блок
        payment_channel: 'cash'
    })).filter(x => x.amount > 0);
    if (change.some(x => !x.account_id)) {
        Layout.showNotification(t('fin_no_account_in_currency'), 'warning');
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
    const поИменам = собратьРазбивку().текст;
    const вопрос = `${t('fin_running_total')}: ${итог}` +
        (людей > 1 ? ` ${t('fin_for_n_people').replace('{n}', людей)}` : '') +
        (поИменам.length > 1 ? `\n${поИменам.join('\n')}` : '') +
        `\n${t('fin_received_from_guest')}: ${Object.entries(полученоПоВалютам()).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ') || '—'}` +
        (change.length ? `\n${t('fin_change')}: ${change.map(x => FinUtils.fmtMoney(x.amount, [...document.querySelectorAll('#payChangeRows .chgline-currency')][change.indexOf(x)]?.value || 'INR')).join(' + ')}` : '') +
        (payDonation ? `\n${t('fin_donation_excess')}: ${Object.entries(payDonation).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}` : '') +
        `\n${t('fin_pay_confirm_q')}`;
    if (!confirm(вопрос)) return;

    const res = await FinUtils.rpc('fin_create_payment', {
        request_id: requestIds.payment,
        occurred_on: document.getElementById('payDate').value,
        payer_contact_id: payer,
        comment: document.getElementById('payComment').value || null,
        rows,
        change: change.length ? change : null
    });
    if (FinUtils.handleResult(res)) {
        // Излишек, оставленный как пожертвование (п.3): отдельная операция на тот же
        // счёт — платёж закрывает ровно долг, разница проведена как пожертвование
        if (payDonation) {
            const статья = FinUtils.refs.categories.find(c => c.code === 'participant_donation');
            // по строке на каждую валюту излишка, счёт — та же касса, что в платеже
            const строкиДара = Object.entries(payDonation).map(([cur, сумма]) => {
                const строка = [...document.querySelectorAll('#payRows .pay-row')]
                    .find(r => r.querySelector('.pay-currency').value === cur);
                return {
                    id: FinUtils.newRequestId(),
                    account_id: строка?.querySelector('.pay-account').value,
                    amount: сумма,
                    category_id: статья?.id,
                    object_id: objectId,
                    participant_id: payer,
                    payment_channel: 'cash'
                };
            }).filter(x => x.account_id);
            if (строкиДара.length) {
                const донат = await FinUtils.rpc('fin_create_donation', {
                    request_id: FinUtils.newRequestId(),
                    occurred_on: document.getElementById('payDate').value,
                    payer_contact_id: payer,
                    comment: `Излишек при оплате (${card.name}) — оставлен как пожертвование`,
                    rows: строкиДара
                });
                if (!донат?.ok) Layout.showNotification(`${t('fin_donation_excess')}: ${донат?.error?.message || 'ошибка'}`, 'error');
            }
        }
        requestIds.payment = null;
        removeChange(); removeDonation();
        closePayment();
        await FinUtils.reloadAccounts();
        await refreshAfterChange();
    }
}

// ==================== ОКРУГЛЕНИЕ И «ПОЛУЧЕНО ОТ ГОСТЯ» (чек-лист v4) ====================
// Дробную сумму нельзя ни принять, ни выдать наличными, поэтому к оплате
// предлагается округлённая вверх (в пользу ашрама), а разница идёт в дар (п.8).
// Шаг задан здесь одним местом — менять при необходимости.
const ШАГ_ОКРУГЛЕНИЯ = { INR: 100, RUB: 100, USD: 1, EUR: 1 };

function округлитьВверх(v, cur) {
    const шаг = ШАГ_ОКРУГЛЕНИЯ[cur] || 1;
    return Math.ceil((Number(v) || 0) / шаг) * шаг;
}

// Сколько распределено по блокам, в разрезе валют
function распределеноПоВалютам() {
    const m = {};
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        const v = Number(row.querySelector('.pay-amount').value) || 0;
        if (!v) return;
        const c = row.querySelector('.pay-currency').value;
        m[c] = Math.round(((m[c] || 0) + v) * 100) / 100;
    });
    return m;
}

function сдачаПоВалютам() {
    const m = {};
    document.querySelectorAll('#payChangeRows .chg-line').forEach(row => {
        const v = Number(row.querySelector('.chgline-amount').value) || 0;
        if (!v) return;
        const c = row.querySelector('.chgline-currency').value;
        m[c] = Math.round(((m[c] || 0) + v) * 100) / 100;
    });
    return m;
}

// Строки «Получено от гостя» появляются сами под каждую валюту платежа;
// сумма предзаполняется округлением вверх и правится администратором (п.10)
function syncReceivedRows() {
    const wrap = document.getElementById('payReceivedRows');
    if (!wrap) return;
    const распределено = распределеноПоВалютам();
    const валюты = Object.keys(распределено);
    // убрать строки валют, которых в платеже больше нет
    [...wrap.querySelectorAll('.rcv-line')].forEach(line => {
        if (!валюты.includes(line.dataset.cur)) line.remove();
    });
    валюты.forEach(cur => {
        let line = wrap.querySelector(`.rcv-line[data-cur="${cur}"]`);
        if (!line) {
            wrap.insertAdjacentHTML('beforeend', `
                <label class="rcv-line flex items-center gap-1" data-cur="${e(cur)}">
                    <span class="text-sm opacity-70">${e(FinUtils.symbol(cur))}</span>
                    <input type="number" class="input input-bordered input-sm w-28 rcv-amount" min="0" step="0.01">
                </label>`);
            line = wrap.lastElementChild;
            line.querySelector('.rcv-amount').addEventListener('input', ev => {
                ev.target.dataset.touched = '1';
                updatePayRunningTotal();
            });
        }
        const поле = line.querySelector('.rcv-amount');
        if (!поле.dataset.touched) поле.value = округлитьВверх(распределено[cur], cur);
    });
}

function полученоПоВалютам() {
    const m = {};
    document.querySelectorAll('#payReceivedRows .rcv-line').forEach(line => {
        const v = Number(line.querySelector('.rcv-amount').value) || 0;
        if (v) m[line.dataset.cur] = v;
    });
    return m;
}

// Гость принёс меньше, чем посчитали: в кассу идёт принятое, разница остаётся
// долгом — расчёт не переделываем, деньги на руках не зависают (ВГ, 25.08).
// Урезаем с наименее приоритетных блоков, чтобы долг собрался в одном месте,
// а не размазался копейками по всем трём.
const ПОРЯДОК_УРЕЗКИ = ['extra', 'meals', 'accommodation', 'org_fee'];

function урезкаПоПолученному() {
    const получено = полученоПоВалютам();
    const распределено = распределеноПоВалютам();
    const правки = new Map();      // строка → сколько зачесть
    const долг = {};               // блок → сколько останется долгом (в валюте)
    for (const [cur, надо] of Object.entries(распределено)) {
        const есть = получено[cur];
        if (есть === undefined || есть <= 0) continue;   // поле не заполнено — не трогаем
        let нехватка = Math.round((надо - есть) * 100) / 100;
        if (нехватка <= 0.005) continue;
        for (const kind of ПОРЯДОК_УРЕЗКИ) {
            if (нехватка <= 0.005) break;
            const строки = [...document.querySelectorAll('#payRows .pay-row')]
                .filter(r => r.querySelector('.pay-currency').value === cur
                          && r.querySelector('.pay-kind').value === kind);
            for (const row of строки) {
                if (нехватка <= 0.005) break;
                const было = Number(row.querySelector('.pay-amount').value) || 0;
                if (было <= 0) continue;
                const снять = Math.min(было, нехватка);
                правки.set(row, Math.round((было - снять) * 100) / 100);
                долг[kind] = { cur, v: Math.round(((долг[kind]?.v || 0) + снять) * 100) / 100 };
                нехватка = Math.round((нехватка - снять) * 100) / 100;
            }
        }
    }
    return { правки, долг };
}

// Излишек = получено − распределено по блокам, отдельно по каждой валюте
function излишекПоВалютам() {
    const получено = полученоПоВалютам();
    const распределено = распределеноПоВалютам();
    const m = {};
    Object.keys(получено).forEach(cur => {
        const d = Math.round((получено[cur] - (распределено[cur] || 0)) * 100) / 100;
        if (d > 0.005) m[cur] = d;
    });
    return m;
}

// Сдача гасит излишек через рупии: сначала свою валюту, потом остальные.
// Возвращает {остаток: {валюта: сумма} — в дар, перебор: ₹ сверх излишка}
function распределитьСдачу(излишек, сдача) {
    const курс = c => retreatRates[c] || 1;
    const остаток = {};
    Object.entries(излишек).forEach(([c, v]) => { остаток[c] = v; });
    let перебор = 0;
    for (const [curС, сумма] of Object.entries(сдача)) {
        let нужноInr = сумма * курс(curС);
        // сперва та же валюта — гостю удобнее получить сдачу тем же, чем платил
        const порядок = [curС, ...Object.keys(остаток).filter(c => c !== curС)];
        for (const c of порядок) {
            if (нужноInr <= 0.005) break;
            const естьInr = (остаток[c] || 0) * курс(c);
            if (естьInr <= 0.005) continue;
            const беремInr = Math.min(естьInr, нужноInr);
            остаток[c] = Math.round((остаток[c] - беремInr / курс(c)) * 100) / 100;
            нужноInr -= беремInr;
        }
        перебор += Math.max(нужноInr, 0);
    }
    Object.keys(остаток).forEach(c => { if (остаток[c] <= 0.005) delete остаток[c]; });
    return { остаток, перебор };
}

// Сколько излишка ещё не покрыто сдачей — в валюте cur (для подстановки в строку)
function непокрытыйОстаток(cur, кромеСтроки) {
    const сдача = {};
    document.querySelectorAll('#payChangeRows .chg-line').forEach(line => {
        if (line === кромеСтроки) return;
        const v = Number(line.querySelector('.chgline-amount').value) || 0;
        if (!v) return;
        const c = line.querySelector('.chgline-currency').value;
        сдача[c] = (сдача[c] || 0) + v;
    });
    const { остаток } = распределитьСдачу(излишекПоВалютам(), сдача);
    const вInr = Object.entries(остаток).reduce((a, [c, v]) => a + v * (retreatRates[c] || 1), 0);
    return Math.round(вInr / (retreatRates[cur] || 1) * 100) / 100;
}

// ==================== СДАЧА И ИЗЛИШЕК (v3 п.2–3; v4 п.10–11) ====================
// Излишек = получено от гостя − распределено по блокам. Часть можно вернуть
// сдачей (сколько угодно строк, любые валюты), остальное остаётся в дар.
let payDonation = null;   // {валюта: сумма} — считается автоматически

function openChangeBlock() {
    const wrap = document.getElementById('payChangeWrap');
    wrap.classList.remove('hidden');
    const rows = document.getElementById('payChangeRows');
    if (!rows.children.length) {
        // первая строка — на весь излишек в его же валюте
        const излишек = излишекПоВалютам();
        const валюты = Object.keys(излишек);
        if (валюты.length) валюты.forEach(cur => addChangeRow(cur, излишек[cur]));
        else addChangeRow();
    }
    updatePayRunningTotal();
}

function addChangeRow(валюта, сумма) {
    const rows = document.getElementById('payChangeRows');
    const cur = валюта || Object.keys(излишекПоВалютам())[0]
        || document.querySelector('#payRows .pay-currency')?.value || 'INR';
    if (сумма == null) {
        const надо = непокрытыйОстаток(cur);
        if (надо > 0) сумма = надо;
    }
    rows.insertAdjacentHTML('beforeend', `
        <div class="chg-line flex flex-wrap items-end gap-2">
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_currency')}</span></label>
                <select class="select select-bordered select-sm chgline-currency">${payCurrencyOptions(cur)}</select>
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_amount')}</span></label>
                <input type="number" class="input input-bordered input-sm w-28 chgline-amount" min="0.01" step="0.01" value="${сумма != null ? Number(сумма) : ''}">
            </div>
            <div class="form-control">
                <label class="label py-0"><span class="label-text text-xs">${t('fin_account')}</span></label>
                <select class="select select-bordered select-sm chgline-account">${счетаДляСтроки(cur, 'cash')}</select>
            </div>
            <button type="button" class="btn btn-ghost btn-sm text-error chgline-del">${FinUtils.ICONS.x}</button>
        </div>`);
    const line = rows.lastElementChild;
    line.querySelector('.chgline-currency').addEventListener('change', ev => {
        line.querySelector('.chgline-account').innerHTML = счетаДляСтроки(ev.target.value, 'cash');
        // сумма пересчитывается в новую валюту: «дал рублями, сдача рупиями» (ВГ, 25.08)
        const поле = line.querySelector('.chgline-amount');
        const надо = непокрытыйОстаток(ev.target.value, line);
        if (надо > 0) поле.value = надо;
        updatePayRunningTotal();
    });
    line.querySelector('.chgline-amount').addEventListener('input', updatePayRunningTotal);
    line.querySelector('.chgline-del').addEventListener('click', () => {
        line.remove();
        if (!rows.children.length) removeChange();
        updatePayRunningTotal();
    });
    updatePayRunningTotal();
    return line;
}

function removeChange() {
    document.getElementById('payChangeWrap')?.classList.add('hidden');
    const rows = document.getElementById('payChangeRows');
    if (rows) rows.innerHTML = '';
    updatePayRunningTotal();
}

// «Оставить как пожертвование» — просто не возвращать сдачу: весь излишек
// автоматически уйдёт в дар (см. расчёт в updatePayRunningTotal)
function keepAsDonation() {
    removeChange();
}

function removeDonation() {
    payDonation = null;
    document.getElementById('payDonationWrap')?.classList.add('hidden');
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
    // Валюта итога — та, в которой платит человек (ВГ, 24.08): показывать остаток
    // и переплату в рупиях, когда гость даёт доллары, бессмысленно. Если строки
    // в разных валютах — считаем в опорной.
    const валютыСтрок = new Set(rows.map(r => r.querySelector('.pay-currency').value));
    const опорная = валютыСтрок.size === 1
        ? [...валютыСтрок][0]
        : (document.getElementById('payBaseCurrency')?.value || rows[0].querySelector('.pay-currency').value);
    const изInr = v => v / (retreatRates[опорная] || 1);
    let итогInr = 0;
    const поЛюдям = {};   // pid → внесено в ₹: остаток считается по каждому человеку формы (п.7, ВГ 24.08)
    const поВалютам = {};
    rows.forEach(row => {
        // добавленный человек входит в «останется закрыть» сразу, ещё до суммы
        const pid = rowPid(row);
        if (pid) поЛюдям[pid] = поЛюдям[pid] || 0;
        const c = row.querySelector('.pay-currency').value;
        const v = Number(row.querySelector('.pay-amount').value) || 0;
        if (!v) return;
        поВалютам[c] = (поВалютам[c] || 0) + v;
        const вInr = v * rowRateInr(row);
        итогInr += вInr;
        поЛюдям[pid] = поЛюдям[pid] + вInr;
    });
    if (!итогInr) { el.innerHTML = ''; syncReceivedRows(); return; }
    // «Получено от гостя» подстраивается под валюты платежа (v4, п.10)
    syncReceivedRows();
    const сдача = сдачаПоВалютам();
    const сдачаInr = Object.entries(сдача).reduce((a, [c, v]) => a + v * (retreatRates[c] || 1), 0);
    const детали = Object.entries(поВалютам).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ');
    // «Останется закрыть» — по всем людям формы: остаток каждого минус его строки
    let остатокВсехInr = 0;
    for (const [pid, внесено] of Object.entries(поЛюдям)) {
        const бал = pid === card.id
            ? participants.find(x => x.participant_id === card.id)?.balance
            : pidData.balance[pid];
        остатокВсехInr += Math.max(Number(бал?.net) || 0, 0) - внесено;
    }
    const после = изInr(остатокВсехInr);
    const хвост = после > 0.01
        ? ` · ${t('fin_remaining_after')}: <b class="text-error">${FinUtils.fmtMoney(после, опорная)}</b>`
        : после < -0.01
            ? ` · ${t('fin_overpaid')}: <b class="text-success">${FinUtils.fmtMoney(-после, опорная)}</b>`
            : ` · <b class="text-success">0</b>`;
    // Дар = излишек минус возвращённая сдача. Сдачу можно выдать другой валютой,
    // поэтому гасим излишки через рупии — валюту учёта (ВГ, 25.08)
    const излишек = излишекПоВалютам();
    const разбор = распределитьСдачу(излишек, сдача);
    payDonation = Object.keys(разбор.остаток).length ? разбор.остаток : null;
    const переборСдачи = разбор.перебор > 0.005
        ? [FinUtils.fmtMoney(разбор.перебор / (retreatRates[опорная] || 1), опорная)] : [];
    const донатEl = document.getElementById('payDonationWrap');
    const донатИнфо = document.getElementById('payDonationInfo');
    if (донатEl) донатEl.classList.toggle('hidden', !payDonation);
    if (донатИнфо && payDonation) {
        донатИнфо.textContent = Object.entries(payDonation)
            .map(([cur, v]) => FinUtils.fmtMoney(v, cur)).join(' + ');
    }
    // Получено меньше распределённого — деньги не сходятся: зачли больше, чем взяли.
    // Именно так у пары матаджи «потерялись» $32 (ВГ, 25.08)
    const получено = полученоПоВалютам();
    const распределено = распределеноПоВалютам();
    const недостача = Object.entries(распределено)
        .map(([cur, v]) => [cur, Math.round((v - (получено[cur] || 0)) * 100) / 100])
        .filter(([, d]) => d > 0.005);
    const подсказка = document.getElementById('payReceivedHint');
    if (подсказка) {
        const остатокДолга = недостача.length ? урезкаПоПолученному().долг : {};
        подсказка.innerHTML = недостача.length
            ? `<span class="text-warning font-medium">${t('fin_will_credit')}: ${Object.entries(получено).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}</span>`
              + ` · <span class="text-error">${t('fin_will_remain_debt')}: ${Object.entries(остатокДолга).map(([k, x]) => `${blockLabel(k)} ${FinUtils.fmtMoney(x.v, x.cur)}`).join(' + ')}</span>`
            : переборСдачи.length
                ? `<span class="text-error">${t('fin_change_exceeds_excess')}: ${переборСдачи.join(' + ')}</span>`
                : Object.keys(излишек).length
                    // цепочка «излишек → сдача → в дар»: без неё непонятно, почему
                    // дар меньше излишка, и кажется, что сдача не учтена (ВГ, 25.08)
                    ? `${t('fin_excess')}: ${Object.entries(излишек).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}`
                      + (сдачаInr > 0 ? ` − ${t('fin_change').toLowerCase()} ${Object.entries(сдача).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}` : '')
                      + (payDonation ? ` → ${t('fin_to_donation')} <b>${Object.entries(payDonation).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}</b>` : ` → 0`)
                    : `<span class="opacity-60">${t('fin_received_hint')}</span>`;
    }
    // Переплата — не тупик: тут же выдать сдачу или оставить пожертвованием (п.2–3).
    // После частичной сдачи остаток тоже можно оставить в дар — кнопка остаётся
    // видимой при открытом блоке сдачи (ВГ, 24.08)
    const changeWrap = document.getElementById('payChangeWrap');
    const сдачаОткрыта = changeWrap && !changeWrap.classList.contains('hidden');
    const переплата = Object.keys(излишек).length > 0;
    const кнопки = переплата
        ? (сдачаОткрыта ? '' : ` <button type="button" class="btn btn-xs btn-outline btn-warning ml-2" data-payact="change">${t('fin_change_give')}</button>`)
           + ` <button type="button" class="btn btn-xs btn-outline btn-success ml-1" data-payact="donate">${t('fin_keep_as_donation')}</button>`
        : '';
    const строкаСдачи = сдачаInr > 0
        ? ` · ${t('fin_change')}: <b class="text-warning">${Object.entries(сдача).map(([c, v]) => '−' + FinUtils.fmtMoney(v, c)).join(' ')}</b>` : '';
    // Зачёт показываем в ₹ — валюте учёта: платёж по цене CRM зачитывается не по
    // курсу ретрита, и «₽ 21 500 ≈ ₽ 20 455» только путал бы (чек-лист v3, п.1)
    el.innerHTML = `${t('fin_running_total')}: <b>${детали}</b> ≈ ${FinUtils.fmtMoney(итогInr, 'INR')}${строкаСдачи}${хвост}${кнопки}`;
    // Та же сводка видна над кнопкой «Сохранить» — глазами, до подтверждения (п. 8)
    const чек = document.getElementById('paySummaryLine');
    if (чек) chек_set(чек, детали, итогInr, 'INR');
    // Разбивка «по блокам и по именам, кто за кого и в какой валюте» (ВГ, 24.08)
    const разбивка = document.getElementById('payBreakdown');
    if (разбивка) разбивка.innerHTML = собратьРазбивку().html;
    // Валюта строк формы автоматически задаёт валюту сводных блоков (ВГ, 24.08)
    syncBlockCurrencies();
    подписатьСтроки();
}

// Введённое в форме, сгруппированное по блокам (общие суммы в валютах) и по
// людям («что за кого было оплачено и в какой валюте»)
function собратьРазбивку() {
    const поБлокам = {};   // kind -> cur -> v
    const поЛюдям = new Map();   // имя -> [«Оргвзнос ₽ 25 000»]
    document.querySelectorAll('#payRows .pay-row').forEach(row => {
        const v = Number(row.querySelector('.pay-amount').value) || 0;
        if (!v) return;
        const kind = row.querySelector('.pay-kind').value;
        const cur = row.querySelector('.pay-currency').value;
        (поБлокам[kind] = поБлокам[kind] || {})[cur] = (поБлокам[kind]?.[cur] || 0) + v;
        const имя = row.dataset.personName || row.querySelector('.pay-person')?.value || card.name;
        if (!поЛюдям.has(имя)) поЛюдям.set(имя, []);
        поЛюдям.get(имя).push(`${blockLabel(kind)} ${FinUtils.fmtMoney(v, cur)}`);
    });
    const блоки = Object.entries(поБлокам).map(([k, m]) =>
        `${blockLabel(k)}: ${Object.entries(m).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}`);
    const люди = [...поЛюдям.entries()].map(([имя, части]) => `${имя} — ${части.join(' · ')}`);
    return {
        html: (блоки.length ? `<div>${блоки.map(e).join(' &nbsp;·&nbsp; ')}</div>` : '') +
              (люди.length > 1 ? люди.map(x => `<div>${e(x)}</div>`).join('') : ''),
        текст: люди
    };
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
// mode 'debt' — простить остаток долга блока; mode 'advance' — оставить переплату
// блока пожертвованием; mode 'all' — закрыть весь итог карточки одной операцией:
// долги блоков списываются, авансы оформляются пожертвованием (ВГ, 24.08)
function openWriteOff(kind, mode = 'debt') {
    const p = participants.find(x => x.participant_id === card.id);
    const поле = document.getElementById('writeOffAmount');
    поле.disabled = false;
    if (mode === 'advance_all') {
        // весь аванс участника — в дар, одной причиной на все блоки (ВГ, 28.08)
        const b = p?.balance;
        const авансы = BLOCKS.map(k => ({ k, v: -(Number(b?.blocks?.[k]?.balance) || 0) })).filter(x => x.v > 0.005);
        if (!авансы.length) return;
        document.getElementById('writeOffKind').value = '';
        document.getElementById('writeOffMode').value = 'advance_all';
        document.getElementById('writeOffTitle').textContent = t('fin_keep_as_donation');
        document.getElementById('writeOffInfo').textContent =
            `${card.name} · ${авансы.map(x => `${blockLabel(x.k)}: ${FinUtils.fmtMoney(x.v, 'INR')}`).join(' · ')} → ${t('fin_total')}: 0`;
        поле.value = авансы.reduce((a, x) => a + x.v, 0);
        поле.disabled = true;
        document.getElementById('writeOffReason').value = '';
        document.getElementById('writeOffModal').showModal();
        return;
    }

    if (mode === 'all') {
        const b = p?.balance;
        const totalNet = Number(b?.net) || 0;
        if (totalNet <= 0) return;
        const части = [];
        for (const k of BLOCKS) {
            const v = Number(b.blocks[k].balance) || 0;
            if (v > 0) части.push(`${blockLabel(k)}: ${t('fin_write_off').toLowerCase()} ${FinUtils.fmtMoney(v, 'INR')}`);
            if (v < 0) части.push(`${blockLabel(k)}: ${t('fin_donation_excess').toLowerCase()} ${FinUtils.fmtMoney(-v, 'INR')}`);
        }
        document.getElementById('writeOffKind').value = '';
        document.getElementById('writeOffMode').value = 'all';
        document.getElementById('writeOffTitle').textContent = t('fin_write_off_title');
        document.getElementById('writeOffInfo').textContent =
            `${card.name} · ${части.join(' · ')} → ${t('fin_total')}: 0`;
        поле.value = totalNet;
        поле.disabled = true;   // сумма — весь итог, разложение показано выше
        document.getElementById('writeOffReason').value = '';
        document.getElementById('writeOffModal').showModal();
        return;
    }
    const баланс = Number(p?.balance?.blocks?.[kind]?.balance) || 0;
    const остаток = mode === 'advance' ? -баланс : баланс;
    if (остаток <= 0) return;
    document.getElementById('writeOffKind').value = kind;
    document.getElementById('writeOffMode').value = mode;
    document.getElementById('writeOffTitle').textContent =
        mode === 'advance' ? t('fin_keep_as_donation') : t('fin_write_off_title');
    document.getElementById('writeOffInfo').textContent =
        `${card.name} · ${blockLabel(kind)} · ${mode === 'advance' ? t('fin_overpaid') : t('fin_balance')}: ${FinUtils.fmtMoney(остаток, 'INR')}`;
    поле.value = остаток;
    поле.max = остаток;
    document.getElementById('writeOffReason').value = '';
    document.getElementById('writeOffModal').showModal();
}

// Списание долга одного блока через механику перерасчёта: старое начисление
// отменяется с записью «было → стало», новое несёт увеличенную скидку
async function writeOffBlockDebt(kind, сумма, причина) {
    const кандидат = Object.values(cardChargesById)
        .filter(c => c.kind === kind && !c.is_cancelled && Number(c.net_amount) >= сумма)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!кандидат) return { ok: false, error: { message: t('fin_write_off_no_charge') } };
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
    return res;
}

// Переплата блока → пожертвование: компенсирующее начисление, деньги уже в кассе
async function donateBlockAdvance(kind, сумма, причина) {
    return await FinUtils.rpc('fin_create_charge', { rows: [{
        id: FinUtils.newRequestId(),
        participant_id: card.id,
        retreat_id: currentRetreat,
        kind,
        description: t('fin_donation_excess'),
        quantity: 1,
        unit_price: сумма,
        discount_amount: null,
        discount_reason: null,
        agreed_with: null,
        creation_reason: `Излишек оставлен как пожертвование — ${причина}`
    }]});
}

async function submitWriteOff(ev) {
    ev.preventDefault();
    const kind = document.getElementById('writeOffKind').value;
    const mode = document.getElementById('writeOffMode').value || 'debt';
    const сумма = Number(document.getElementById('writeOffAmount').value) || 0;
    const причина = document.getElementById('writeOffReason').value.trim();
    if (сумма <= 0 || !причина) return;

    if (mode === 'advance_all') {
        const b = participants.find(x => x.participant_id === card.id)?.balance;
        if (!b) return;
        const авансы = BLOCKS.map(k => ({ k, v: -(Number(b.blocks[k].balance) || 0) })).filter(x => x.v > 0.005);
        let res = { ok: true };
        for (const { k, v } of авансы) {
            res = await donateBlockAdvance(k, v, причина);
            if (!res?.ok) break;
        }
        if (FinUtils.handleResult(res)) document.getElementById('writeOffModal').close();
        await refreshAfterChange();
        return;
    }


    if (mode === 'all') {
        // Весь итог карточки одной операцией: сначала проверяем, что каждому
        // долгу есть чем «ответить» (начисление с достаточным «К оплате»)
        const b = participants.find(x => x.participant_id === card.id)?.balance;
        if (!b) return;
        const долги = BLOCKS.map(k => ({ k, v: Number(b.blocks[k].balance) || 0 })).filter(x => x.v > 0);
        const авансы = BLOCKS.map(k => ({ k, v: -(Number(b.blocks[k].balance) || 0) })).filter(x => x.v > 0);
        const безПокрытия = долги.find(({ k, v }) => !Object.values(cardChargesById)
            .some(c => c.kind === k && !c.is_cancelled && Number(c.net_amount) >= v));
        if (безПокрытия) {
            Layout.showNotification(`${blockLabel(безПокрытия.k)}: ${t('fin_write_off_no_charge')}`, 'warning');
            return;
        }
        let res = { ok: true };
        for (const { k, v } of долги) {
            res = await writeOffBlockDebt(k, v, причина);
            if (!res?.ok) break;
        }
        if (res?.ok) for (const { k, v } of авансы) {
            res = await donateBlockAdvance(k, v, причина);
            if (!res?.ok) break;
        }
        if (FinUtils.handleResult(res)) {
            document.getElementById('writeOffModal').close();
        }
        await refreshAfterChange();   // и при частичном сбое показать фактическое состояние
        return;
    }

    const res = mode === 'advance'
        ? await donateBlockAdvance(kind, сумма, причина)
        : await writeOffBlockDebt(kind, сумма, причина);
    if (!res?.ok && res?.error?.message === t('fin_write_off_no_charge')) {
        Layout.showNotification(t('fin_write_off_no_charge'), 'warning');
        return;
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
        const donateBtn = ev.target.closest('[data-donate-advance]');
        if (donateBtn) { openWriteOff(donateBtn.dataset.donateAdvance, 'advance'); return; }
        const compBtn = ev.target.closest('[data-open-participant]');
        if (compBtn) { openCard(compBtn.dataset.openParticipant); return; }
        // внести за спутника, не выходя из карточки (ВГ, 28.08)
        const payForBtn = ev.target.closest('[data-pay-for]');
        if (payForBtn) { openPaymentFor(payForBtn.dataset.payFor); return; }
        // зачесть аванс спутника в долг владельца карточки
        const offsetBtn = ev.target.closest('[data-offset-from]');
        if (offsetBtn) { offsetFromCompanion(offsetBtn.dataset.offsetFrom); return; }
        const writeOffAllBtn = ev.target.closest('[data-writeoff-all]');
        if (writeOffAllBtn) { openWriteOff(null, 'all'); return; }
        const donateAllBtn = ev.target.closest('[data-donate-all]');
        if (donateAllBtn) { openWriteOff(null, 'advance_all'); return; }
        // Валюта сводных карточек: «в чём человек хочет платить» (ВГ, 24.08)
        const curBtn = ev.target.closest('[data-cardcur]');
        if (curBtn) {
            cardCurrency = curBtn.dataset.cardcur;
            renderCardCurrencyBtns();
            const p = participants.find(x => x.participant_id === card.id);
            if (p) renderCardBlocks(p.balance);
            return;
        }
        // Кнопки «Выдать сдачу» / «Оставить как пожертвование» при переплате (п.2–3)
        const payAct = ev.target.closest('[data-payact]');
        if (payAct) payAct.dataset.payact === 'change' ? openChangeBlock() : keepAsDonation();
    });
    document.getElementById('writeOffForm').addEventListener('submit', FinUtils.lockedSubmit(submitWriteOff));

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

window.FinParticipants = { openCharge, closeCharge, openPayment, closePayment, addChargeRow, addPayRow, addOtherParticipantRow, syncFromCrm, copySummary, openRecalc, onBaseCurrencyChange, removeChange, removeDonation, addChangeRow, keepAsDonation };
init();
})();
