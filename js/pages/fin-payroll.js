// ==================== ФИНАНСЫ: ЗАРПЛАТНАЯ ВЕДОМОСТЬ ====================
// Одна ведомость на весь ашрам, сгруппированная по департаментам.
// Баланс = Σ начислений − Σ выплат — накопительно за всё время, поэтому
// недоплата, неровная сумма и аванс переходят на следующий месяц сами
// (см. 438_fin_payroll.sql).
//
// Строка ведомости = человек в департаменте. Под ней могут быть несколько
// позиций-периодов (Уша: Кухня до 19.08, потом снова Кухня с осени) — история
// и баланс складываются, поэтому переходы туда-сюда не плодят строк.
// «Начислено» и «Выплачено» показываются за выбранный период (месяц/год/всё
// время) — что начислили и что выплатили В ЭТОТ период, независимо от того, за
// какой месяц работы: итог за всё время через годы ни о чём не говорит, а долг виден в
// балансе, который от периода не зависит.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Кэш переводов может не знать новых ключей — запасной текст по-русски
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

let positions = [];
let accruals = [];
let payments = [];
let housing = [];   // жильё из пакета (790): начисления и оплаты
let absences = [];  // отъезды (796)
let groups = [];
const detailOpen = new Set();

// PostgREST отдаёт не больше 1000 строк за запрос — читаем страницами
async function fetchAll(view, orderCol) {
    const out = [];
    for (let from = 0; ; from += 1000) {
        const { data, error } = await Layout.db.from(view).select('*').order(orderCol).range(from, from + 999);
        if (error) return { error };
        out.push(...(data || []));
        if (!data || data.length < 1000) break;
    }
    return { data: out };
}

function periodLabel(periodStr) {
    const d = DateUtils.parseDate(periodStr);
    const lang = DateUtils.getLang();
    return `${DateUtils.monthNamesShort[lang]?.[d.getMonth()] || DateUtils.monthNamesShort.ru[d.getMonth()]} ${d.getFullYear()}`;
}

// ---------- выбранный период колонок ----------
function currentRange() {
    const mode = document.getElementById('payrollRange')?.value || 'month';
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    if (mode === 'month') return { mode, from: `${y}-${m}-01`, to: `${y}-${m}-31`, label: periodLabel(`${y}-${m}-01`) };
    if (mode === 'year') return { mode, from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
    return { mode, from: '0000-01-01', to: '9999-12-31', label: t('fin_payroll_range_all_short') };
}

const inRange = (dateStr, r) => {
    const d = (dateStr || '').slice(0, 10);
    return d >= r.from && d <= r.to;
};

// ---------- группировка позиций по человеку + департаменту ----------
function buildGroups() {
    const r = currentRange();
    const map = new Map();
    for (const p of positions) {
        const key = `${p.vaishnava_id}|${p.department_id}`;
        if (!map.has(key)) map.set(key, { key, positions: [] });
        map.get(key).positions.push(p);
    }

    for (const g of map.values()) {
        g.positions.sort((a, b) => a.effective_from.localeCompare(b.effective_from));
        const latest = g.positions[g.positions.length - 1];
        const current = g.positions.find(p => p.is_current) || null;
        const shown = current || latest;
        const ids = new Set(g.positions.map(p => p.id));
        g.current = current;
        g.employee_name = shown.employee_name;
        g.vaishnava_id = shown.vaishnava_id;
        g.telegram_enabled = shown.telegram_enabled !== false;
        g.department_id = shown.department_id;
        g.department_name = shown.department_name;
        g.position_title = shown.position_title;
        g.salary_amount = shown.salary_amount;
        g.currency_code = shown.currency_code;
        g.is_current = !!current;
        g.ended_on = current ? null : g.positions.map(p => p.effective_to).filter(Boolean).sort().pop();
        g.balance = g.positions.reduce((s, p) => s + Number(p.balance || 0), 0);
        g.total_accrued_all = g.positions.reduce((s, p) => s + Number(p.total_accrued || 0), 0);
        g.accruals = accruals.filter(a => ids.has(a.position_id));
        g.payments = payments.filter(p => ids.has(p.position_id));
        // Пакет (790): жильё не выдаётся на руки — копит долг «Жильё к оплате»;
        // долг человека (прасад семьи) — то, что можно удержать при выплате
        g.housing_amount = shown.housing_amount;
        g.housing = housing.filter(h => ids.has(h.position_id));
        g.housing_balance = g.positions.reduce((s, p) => s + Number(p.housing_balance || 0), 0);
        g.person_debt = Number(shown.person_debt || 0);
        g.housing_paid_to = shown.housing_paid_to || null;
        g.housing_payee = shown.housing_payee || null;
        g.absences = absences.filter(a => a.vaishnava_id === g.vaishnava_id && a.department_id === g.department_id);
        g.accrued = g.accruals.filter(a => inRange(DateUtils.toISO(new Date(a.created_at)), r)).reduce((s, a) => s + Number(a.amount), 0);
        g.paid = g.payments.filter(p => !p.is_reversed && inRange(p.occurred_on, r)).reduce((s, p) => s + Number(p.amount), 0);
        // платёж кладём на действующую позицию, а если её нет (остался долг за
        // прошлый период) — на последнюю: баланс всё равно складывается по группе
        g.payPositionId = (current || latest).id;
    }
    return [...map.values()];
}

// Баланс имеет смысл, если есть оклад или хоть одно начисление (в т.ч. ручное):
// без них — только разовые выплаты, долга нет
function tracksBalance(g) {
    return g.salary_amount != null || g.total_accrued_all > 0;
}

function balanceBadge(g) {
    if (!tracksBalance(g)) return '';
    const bal = Math.round(g.balance * 100) / 100;
    if (bal > 0) return `<span class="badge badge-warning badge-sm payroll-badge">${t('fin_payroll_debt')}: <span class="whitespace-nowrap">${FinUtils.fmtMoney(bal, g.currency_code)}</span></span>`;
    if (bal < 0) return `<span class="badge badge-info badge-sm payroll-badge">${t('fin_payroll_advance')}: <span class="whitespace-nowrap">${FinUtils.fmtMoney(-bal, g.currency_code)}</span></span>`;
    return `<span class="badge badge-success badge-sm payroll-badge">${t('fin_payroll_settled')}</span>`;
}

const round2 = x => Math.round(Number(x || 0) * 100) / 100;
const fmtD = iso => DateUtils.formatShort(DateUtils.parseDate(iso));

// Временный отъезд, который идёт сейчас (или будет): «в отъезде до 20.12»
function awayBadge(g) {
    if (!g.is_current) return '';
    const today = DateUtils.toISO(new Date());
    const a = g.absences.find(x => x.kind !== 'left' && (!x.d_to || x.d_to >= today));
    if (!a) return '';
    const txt = a.d_to ? `${tr('fin_payroll_away_until', 'в отъезде до')} ${fmtD(a.d_to)}` : tr('fin_payroll_away', 'в отъезде');
    return ` <span class="badge badge-info badge-xs whitespace-nowrap" title="${e(a.reason || '')}">${e(txt)}</span>`;
}
const hasHousingDue = g => round2(g.housing_balance) !== 0;

// Жильё к оплате и долг человека (прасад семьи) — рядом с балансом оклада
function extraBadges(g) {
    const out = [];
    const hb = round2(g.housing_balance);
    if (hb > 0) out.push(`<span class="badge badge-warning badge-sm payroll-badge">${e(tr('fin_payroll_housing_due', 'Жильё к оплате'))}: <span class="whitespace-nowrap">${FinUtils.fmtMoney(hb, g.currency_code)}</span></span>`);
    else if (hb < 0) out.push(`<span class="badge badge-info badge-sm payroll-badge">${e(tr('fin_payroll_housing_ahead', 'Жильё оплачено вперёд'))}: <span class="whitespace-nowrap">${FinUtils.fmtMoney(-hb, g.currency_code)}</span></span>`);
    const debt = round2(g.person_debt);
    if (debt > 0) out.push(`<span class="badge badge-error badge-outline badge-sm payroll-badge">${e(tr('fin_payroll_person_debt', 'Долг за прасад'))}: <span class="whitespace-nowrap">${FinUtils.fmtMoney(debt, g.currency_code)}</span></span>`);
    return out.join('');
}

// Телеграм у человека (684): выключен — ни строки в чат, ни лички, ни ожидания «Получил»
const tgIcon = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-3.5 h-3.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"/></svg>`;

function telegramToggleHtml(g) {
    return g.telegram_enabled
        ? `<button type="button" class="btn btn-ghost btn-xs px-1 opacity-60" data-tg-toggle="${g.vaishnava_id}" data-tg-enabled="1" title="${e(t('fin_payroll_tg_on'))}">${tgIcon}</button>`
        : `<button type="button" class="badge badge-ghost badge-sm gap-1 cursor-pointer line-through" data-tg-toggle="${g.vaishnava_id}" data-tg-enabled="0" title="${e(t('fin_payroll_tg_off'))}">${tgIcon}${t('fin_payroll_tg_off_short')}</button>`;
}

async function toggleTelegram(vaishnavaId, enable) {
    const res = await FinUtils.rpc('fin_payroll_set_telegram', { vaishnava_id: vaishnavaId, enabled: enable });
    if (FinUtils.handleResult(res)) await load();
}

const chevron = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-3 h-3 inline transition-transform"><path stroke-linecap="round" stroke-linejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5"/></svg>`;

function rowHtml(g) {
    const hasSalary = g.salary_amount != null;
    const tracks = tracksBalance(g);
    const isOpen = detailOpen.has(g.key);
    return `<tr class="${g.is_current ? '' : 'opacity-60'} ${isOpen ? 'row-open' : ''}">
        <td>
            <button type="button" class="inline-flex items-center gap-1 hover:underline" data-toggle="${g.key}">
                <span class="${isOpen ? 'rotate-90' : ''}">${chevron}</span>${e(g.employee_name)}
            </button>
            ${telegramToggleHtml(g)}
            ${!g.is_current ? ` <span class="badge badge-ghost badge-xs">${t('fin_payroll_ended_on')} ${DateUtils.formatShort(DateUtils.parseDate(g.ended_on))}</span>` : ''}
            ${awayBadge(g)}
        </td>
        <td>${e(g.position_title)}</td>
        <td class="font-mono">${hasSalary ? FinUtils.fmtMoney(g.salary_amount, g.currency_code) : `<span class="opacity-50">${t('fin_payroll_no_salary')}</span>`}${g.housing_amount != null
            ? `<div class="text-xs opacity-70 whitespace-nowrap">+ ${e(tr('fin_payroll_housing_short', 'жильё'))} ${FinUtils.fmtMoney(g.housing_amount, g.currency_code)}</div>` : ''}</td>
        <td class="font-mono">${tracks ? FinUtils.fmtMoney(g.accrued, g.currency_code) : '—'}</td>
        <td class="font-mono">${FinUtils.fmtMoney(g.paid, g.currency_code)}</td>
        <td><div class="flex flex-col items-start gap-1">${balanceBadge(g)}${extraBadges(g)}</div></td>
        <td class="text-right">
            <div class="payroll-actions">
                <button type="button" class="btn btn-primary btn-xs" data-pay="${g.payPositionId}">${t(tracks ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')}</button>
                ${g.housing_amount != null || hasHousingDue(g) ? `<button type="button" class="btn btn-outline btn-xs" data-pay-housing="${g.payPositionId}">${e(tr('fin_payroll_pay_housing', 'Оплатить жильё'))}</button>` : '<span></span>'}
                ${g.is_current ? `<button type="button" class="btn btn-outline btn-xs" data-accrue="${g.current.id}">${t('fin_payroll_accrue')}</button>` : '<span></span>'}
            </div>
        </td>
    </tr>
    <tr class="row-child ${isOpen ? '' : 'hidden'}">
        <td colspan="7" class="tbl-lvl-1 py-2">
            <div class="text-xs">${isOpen ? detailBodyHtml(g) : ''}</div>
        </td>
    </tr>`;
}

// Подтверждение получения (683): ждут только выплаты, проведённые после
// запуска; сторнированные не в счёт
const needsConfirm = p => p.confirm_requested_at && !p.is_reversed && !p.confirmed_at;

function confirmHtml(p) {
    if (!p.confirm_requested_at || p.is_reversed) return '';
    if (p.confirmed_at) {
        return ` <span class="badge badge-success badge-xs whitespace-nowrap">${t('fin_payroll_confirmed')} ${DateUtils.formatShort(new Date(p.confirmed_at))}</span>`;
    }
    if (p.recipient_linked) {
        return ` <span class="badge badge-warning badge-xs whitespace-nowrap">${t('fin_payroll_wait_confirm_tg')}</span>`;
    }
    return ` <span class="inline-flex flex-wrap items-center gap-1 mt-0.5"><span class="badge badge-warning badge-xs whitespace-nowrap">${t('fin_payroll_not_linked')}</span>
        <button type="button" class="btn btn-outline btn-xs whitespace-nowrap" data-invite="${p.id}">${t('fin_payroll_copy_invite')}</button></span>`;
}

// ⚠ сверху: сколько выплат без подтверждения и чьи — клик раскрывает строку
function renderConfirmWarning() {
    const box = document.getElementById('payrollConfirmWarn');
    const list = payments.filter(needsConfirm).sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="alert alert-warning mb-4 items-start">
        <div class="w-full">
            <div class="font-semibold">⚠ ${t('fin_payroll_unconfirmed_title')}: ${list.length}</div>
            <ul class="mt-1 text-sm">${list.map(p => {
                const g = groupByPosition(p.position_id);
                return `<li><button type="button" class="hover:underline text-left" data-open-pos="${p.position_id}">
                    • ${e(g?.employee_name || '')} (${e(g?.department_name || '')}) — ${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}, ${FinUtils.fmtMoney(p.amount, p.currency_code)} — ${t(p.recipient_linked ? 'fin_payroll_wait_confirm_tg' : 'fin_payroll_not_linked')}
                </button></li>`;
            }).join('')}</ul>
        </div>
    </div>`;
}

// ⚠ Жильё к оплате (795): всё начисленное и не оплаченное; у кого получатель не
// выяснен — отдельной пометкой. Клик раскрывает строку человека
function renderPayablesWarning() {
    const box = document.getElementById('payrollPayablesWarn');
    const list = groups.filter(g => round2(g.housing_balance) > 0)
        .sort((a, b) => a.employee_name.localeCompare(b.employee_name));
    if (!list.length) { box.innerHTML = ''; return; }
    const unknown = list.filter(g => !g.housing_paid_to).length;
    const totals = {};
    for (const g of list) totals[g.currency_code] = (totals[g.currency_code] || 0) + round2(g.housing_balance);
    box.innerHTML = `<div class="alert alert-warning mb-4 items-start">
        <div class="w-full">
            <div class="font-semibold">⚠ ${e(tr('fin_payroll_payables_title', 'Жильё к оплате'))}: ${Object.entries(totals).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' + ')}${unknown ? ` · ${unknown} — ${e(tr('fin_payroll_payee_unknown_count', 'получатель не выяснен'))}` : ''}</div>
            <ul class="mt-1 text-sm">${list.map(g => `<li><button type="button" class="hover:underline text-left" data-open-pos="${g.payPositionId}">
                • ${e(g.employee_name)} (${e(g.department_name)}) — ${FinUtils.fmtMoney(round2(g.housing_balance), g.currency_code)} — ${g.housing_paid_to
                    ? e(paidToLabel(g.housing_paid_to) + (g.housing_payee ? `: ${g.housing_payee}` : ''))
                    : `<b>${e(tr('fin_payroll_payee_unknown', 'кому — не выяснено'))}</b>`}
            </button></li>`).join('')}</ul>
        </div>
    </div>`;
}

async function cancelAbsence(id) {
    if (!confirm(tr('fin_payroll_absence_cancel', 'Отменить этот отъезд? Дни вернутся в начисление.'))) return;
    const res = await FinUtils.rpc('fin_payroll_absence_cancel', { id });
    if (FinUtils.handleResult(res)) await load();
}

function openPayeeModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('housingPayeePositionId').value = positionId;
    document.getElementById('housingPayeeTitle').textContent = `${tr('fin_payroll_housing_payee', 'Кому платим')} — ${g.employee_name}`;
    document.getElementById('housingPayeeTo').value = g.housing_paid_to || '';
    document.getElementById('housingPayeeName').value = g.housing_payee || '';
    document.getElementById('housingPayeeModal').showModal();
}

async function submitPayee(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_payroll_set_housing_payee', {
        position_id: document.getElementById('housingPayeePositionId').value,
        paid_to: document.getElementById('housingPayeeTo').value || null,
        payee: document.getElementById('housingPayeeName').value || null
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('housingPayeeModal').close();
        await load();
    }
}

function openPosition(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    detailOpen.add(g.key);
    render();
    document.querySelector(`[data-toggle="${g.key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Приглашение для неподключённого к боту: ВГ пересылает его человеку,
// тот жмёт «Старт» — бот привязывает его и присылает выплату с кнопкой
async function copyInvite(paymentId) {
    const res = await FinUtils.rpc('fin_payroll_invite_token', { payment_id: paymentId });
    if (!res?.ok) { FinUtils.handleResult(res); return; }
    const link = `https://t.me/SRSKteambot?start=${res.result.token}`;
    // Без оклада — приглашение без слова «зарплата», только зачем бот (776)
    const pay = payments.find(x => x.id === paymentId);
    const g = pay && groupByPosition(pay.position_id);
    const key = !g || tracksBalance(g) ? 'fin_payroll_invite_text' : 'fin_payroll_invite_text_gift';
    const text = t(key).replace('{link}', link);
    try {
        await navigator.clipboard.writeText(text);
        Layout.showNotification(t('fin_payroll_invite_copied'), 'success');
    } catch (err) {
        window.prompt(t('fin_payroll_copy_invite'), text);
    }
}

// Разбивка «за какой период что начислено» и «когда что выплачено» — всё за
// всё время, независимо от выбранного периода колонок (замечание ВГ, 16.09.2026)
function detailBodyHtml(g) {
    const accr = [...g.accruals].sort((a, b) => a.period.localeCompare(b.period));
    const pays = [...g.payments].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    const accHtml = accr.length
        ? accr.map(a => `<div class="flex justify-between gap-4"><span>${periodLabel(a.period)}${a.is_manual ? ` (${t('fin_payroll_manual')})` : ''}${a.days_worked != null && a.days_worked < a.days_in_month ? ` (${a.days_worked}/${a.days_in_month} ${t('fin_payroll_days')})` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(a.amount, a.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_accruals')}</div>`;
    const payHtml = pays.length
        ? pays.map(p => `<div class="flex justify-between gap-4 ${p.is_reversed ? 'opacity-50 line-through' : ''}"><span class="min-w-0">${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}${p.comment ? ` — ${e(p.comment)}` : ''}${periodsHtml(p)}${Number(p.withheld_amount) > 0
            ? `<div class="opacity-70">${e(tr('fin_payroll_on_hand', 'на руки'))} <span class="whitespace-nowrap">${FinUtils.fmtMoney(p.on_hand, p.currency_code)}</span> · ${e(tr('fin_payroll_withheld', 'удержано'))} <span class="whitespace-nowrap">${FinUtils.fmtMoney(p.withheld_amount, p.currency_code)}</span></div>` : ''}${confirmHtml(p)}</span><span class="font-mono text-right whitespace-nowrap">${FinUtils.fmtMoney(p.amount, p.currency_code)}</span></div>`).join('')
        : `<div class="opacity-60">${t('fin_payroll_no_payments')}</div>`;
    const showHousing = g.housing_amount != null || g.housing.length;
    const kindLabel = { left: tr('fin_payroll_depart_left', 'Надолго'), unpaid: tr('fin_payroll_depart_unpaid', 'Временно, без оплаты'), paid: tr('fin_payroll_depart_paid', 'Временно, оплата идёт') };
    const absHtml = g.absences.length ? `<div class="mt-3"><div class="font-semibold mb-1">${e(tr('fin_payroll_absences', 'Отъезды'))}</div>${
        [...g.absences].sort((a, b) => a.d_from.localeCompare(b.d_from)).map(a => `<div>${fmtD(a.d_from)}${a.d_to ? ` — ${fmtD(a.d_to)}` : ''}: ${e(kindLabel[a.kind])}${a.kind === 'unpaid' && a.stop_housing ? ` (+ ${e(tr('fin_payroll_housing_short', 'жильё'))})` : ''}${a.reason ? ` — ${e(a.reason)}` : ''}${a.kind !== 'left' ? ` <button type="button" class="link link-error" data-absence-cancel="${a.id}" title="${e(t('delete'))}">✕</button>` : ''}</div>`).join('')
    }</div>` : '';
    return `<div class="grid grid-cols-1 ${showHousing ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-4">
        <div class="min-w-0"><div class="font-semibold mb-1">${t('fin_payroll_accrued')} — ${t('fin_payroll_range_all_short')}</div>${accHtml}</div>
        <div class="min-w-0"><div class="font-semibold mb-1">${t('fin_payroll_paid')} — ${t('fin_payroll_range_all_short')}</div>${payHtml}</div>
        ${showHousing ? `<div class="min-w-0">${housingDetailHtml(g)}</div>` : ''}
    </div>${absHtml}`;
}

const paidToLabel = v => v ? tr(`fin_payroll_paid_to_${v}`, { landlord: 'хозяину', employee: 'сотруднику', reimburse: 'возврат заплатившему' }[v])
    : tr('fin_payroll_not_specified', 'не указано');

// Жильё: начисления по месяцам (+ ручные строки — свет) и оплаты, всё за всё время
function housingDetailHtml(g) {
    const rows = [...g.housing].sort((a, b) => a.on_date.localeCompare(b.on_date) || a.kind.localeCompare(b.kind));
    // Снятый месяц (уехал, оплачено вперёд) — зачёркнут с причиной, можно вернуть (793)
    const accrualRow = h => h.cancelled_reason
        ? `<div class="flex justify-between gap-4"><span><span class="line-through opacity-50">${periodLabel(h.on_date)}</span> — ${e(tr('fin_payroll_housing_skipped', 'не начислено'))}: ${e(h.cancelled_reason)} <button type="button" class="link link-primary" data-housing-unskip="${h.id}">${e(tr('fin_payroll_housing_unskip', 'вернуть'))}</button></span><span class="font-mono line-through opacity-50">${FinUtils.fmtMoney(h.amount, h.currency_code)}</span></div>`
        : `<div class="flex justify-between gap-4"><span>${periodLabel(h.on_date)}${h.is_manual ? ` — ${e(h.comment)} <button type="button" class="link link-error" data-housing-del="${h.id}" title="${e(t('delete'))}">✕</button>` : ` <button type="button" class="link opacity-60" data-housing-skip="${h.id}" title="${e(tr('fin_payroll_housing_skip_hint', 'Не начислять жильё за этот месяц (уехал, оплачено вперёд…)'))}">${e(tr('fin_payroll_housing_skip', 'не начислять'))}</button>`}${h.days_worked != null && h.days_worked < h.days_in_month ? ` (${h.days_worked}/${h.days_in_month} ${t('fin_payroll_days')})` : ''}</span><span class="font-mono">${FinUtils.fmtMoney(h.amount, h.currency_code)}</span></div>`;
    const body = rows.length ? rows.map(h => h.kind === 'accrual'
        ? accrualRow(h)
        : `<div class="flex justify-between gap-4 ${h.is_reversed ? 'opacity-50 line-through' : ''}"><span>${DateUtils.formatShort(DateUtils.parseDate(h.on_date))} — ${e(tr('fin_payroll_paid', 'выплачено'))}${h.for_period ? ` ${e(tr('fin_payroll_for_month', 'за'))} ${periodLabel(h.for_period)}` : ''} (${e(paidToLabel(h.paid_to))}${h.payee ? `: ${e(h.payee)}` : ''})${h.comment ? ` <span class="opacity-60">${e(h.comment)}</span>` : ''}</span><span class="font-mono">−${FinUtils.fmtMoney(h.amount, h.currency_code)}</span></div>`
    ).join('') : `<div class="opacity-60">${t('fin_payroll_no_accruals')}</div>`;
    const payee = g.housing_paid_to
        ? e(paidToLabel(g.housing_paid_to) + (g.housing_payee ? `: ${g.housing_payee}` : ''))
        : `<span class="text-warning font-semibold">${e(tr('fin_payroll_not_clarified', 'Не выяснено'))}</span>`;
    return `<div class="font-semibold mb-1">${e(tr('fin_payroll_housing', 'Жильё'))}</div>
        <div class="mb-1">${e(tr('fin_payroll_housing_payee', 'Кому платим'))}: ${payee} <button type="button" class="link link-primary" data-housing-payee="${g.payPositionId}">${e(tr('fin_payroll_housing_payee_set', 'изменить'))}</button></div>${body}
        <button type="button" class="link link-primary mt-1" data-housing-line="${g.payPositionId}">+ ${e(tr('fin_payroll_housing_line', 'строка к жилью (свет по чеку)'))}</button>`;
}

// Завершённые периоды без долга в списке не нужны — иначе он зарастает
// историей; действующие видны всегда, даже когда всё выплачено
function visibleGroups() {
    const showEnded = document.getElementById('showEnded')?.checked;
    return groups.filter(g => g.is_current || showEnded || (tracksBalance(g) && Math.round(g.balance * 100) !== 0));
}

function render() {
    groups = buildGroups();
    renderConfirmWarning();
    renderPayablesWarning();
    renderPeriodsWarning();
    const range = currentRange();
    const container = document.getElementById('payrollBody');
    const byDept = new Map();
    for (const g of visibleGroups()) {
        if (!byDept.has(g.department_id)) byDept.set(g.department_id, { name: g.department_name, rows: [] });
        byDept.get(g.department_id).rows.push(g);
    }
    if (!byDept.size) {
        container.innerHTML = `<div class="text-center py-10 opacity-60">${t('fin_payroll_no_employees')}</div>`;
        return;
    }
    const sub = txt => `<div class="text-[10px] font-normal normal-case opacity-60">${e(txt)}</div>`;
    container.innerHTML = [...byDept.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d => `
            <div class="card bg-base-100 shadow-sm mb-4">
                <div class="card-body p-0">
                    <div class="px-4 py-3 font-semibold border-b border-base-200">${e(d.name)}</div>
                    <div class="overflow-x-auto">
                        <table class="table table-sm table-fixed w-full min-w-[820px]">
                            <colgroup>
                                <col class="w-[20%]"><col class="w-[16%]"><col class="w-[11%]">
                                <col class="w-[11%]"><col class="w-[11%]"><col class="w-[13%]"><col class="w-[18%]">
                            </colgroup>
                            <thead><tr>
                                <th>${t('fin_payroll_employee')}</th>
                                <th>${t('fin_payroll_position')}</th>
                                <th>${t('fin_payroll_salary')}</th>
                                <th>${t('fin_payroll_accrued')}${sub(range.label)}</th>
                                <th>${t('fin_payroll_paid')}${sub(range.label)}</th>
                                <th>${t('fin_payroll_balance')}${sub(t('fin_payroll_range_all_short'))}</th>
                                <th></th>
                            </tr></thead>
                            <tbody>${d.rows.map(rowHtml).join('')}</tbody>
                        </table>
                    </div>
                </div>
            </div>`).join('');
}

async function load() {
    const [pos, acc, pay, hous, abs] = await Promise.all([
        fetchAll('fin_v_payroll_positions', 'employee_name'),
        fetchAll('fin_v_payroll_accruals', 'period'),
        fetchAll('fin_v_payroll_payments', 'occurred_on'),
        fetchAll('fin_v_payroll_housing', 'on_date'),
        fetchAll('fin_v_payroll_absences', 'd_from')
    ]);
    const err = pos.error || acc.error || pay.error || hous.error || abs.error;
    if (err) { Layout.handleError(err, 'Зарплатная ведомость'); return; }
    positions = pos.data;
    accruals = acc.data;
    payments = pay.data;
    housing = hous.data;
    absences = abs.data;
    render();
}

function toggleDetail(key) {
    if (detailOpen.has(key)) detailOpen.delete(key); else detailOpen.add(key);
    render();
}

function groupByPosition(positionId) {
    return groups.find(x => x.positions.some(p => p.id === positionId));
}

function openPayModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('payPositionId').value = positionId;
    document.getElementById('payModalTitle').textContent = `${t(tracksBalance(g) ? 'fin_payroll_pay' : 'fin_payroll_adhoc_pay')} — ${g.employee_name} (${g.department_name})`;
    // Подсказка суммы: есть долг — предлагаем его; нет долга, но оклад есть —
    // предлагаем сам оклад (обычно платят именно его); нет оклада — пусто,
    // сумму вводят руками. Подсказку всегда можно поправить — это и оставляет
    // неровный остаток на будущее, как задумано (замечание ВГ, 16.09.2026)
    const bal = Math.round(g.balance * 100) / 100;
    const due = bal > 0 ? bal : (g.salary_amount ?? null);
    // Долг человека (прасад семьи) — удержание подставляется само, можно поправить (790)
    const debt = round2(g.person_debt);
    const withhold = debt > 0 && due ? Math.min(debt, due) : 0;
    payState = { debt, currency: g.currency_code };
    document.getElementById('payWithholdWrap').classList.toggle('hidden', !(debt > 0));
    document.getElementById('payWithhold').value = debt > 0 ? withhold : '';
    document.getElementById('payWithholdHint').textContent = debt > 0
        ? tr('fin_payroll_withhold_hint', 'Долг: {debt}. Удержание — приход «Оплата от участника» без кассы, гасит долг.').replace('{debt}', FinUtils.fmtMoney(debt, g.currency_code))
        : '';
    document.getElementById('payAmountLabel').textContent = debt > 0 ? tr('fin_payroll_on_hand_label', 'На руки') : t('fin_payroll_amount');
    document.getElementById('payAmount').value = due != null ? round2(due - withhold) : '';
    document.getElementById('payDate').value = FinUtils.todayISO();
    setupPeriodEditor('payPeriods', {
        g, exceptId: null,
        rows: [{ month: oldestUnpaidMonth(g, null, FinUtils.todayISO()), amount: due != null ? round2(due) : null }],
        getTotal: payTotal,
        getDate: () => document.getElementById('payDate').value || FinUtils.todayISO()
    });
    updatePaySummary();
    document.getElementById('payComment').value = '';
    document.getElementById('payModal').showModal();
}

let payState = { debt: 0, currency: 'INR' };

// «Оклад 35 000 = на руки 17 000 + удержано 18 000» — видно, что уйдёт из кассы
// Сумма выплаты = на руки + удержано; одна строка месяца идёт за суммой сама
function payTotal() {
    const hand = Number(document.getElementById('payAmount').value || 0);
    const wh = payState.debt > 0 ? Number(document.getElementById('payWithhold').value || 0) : 0;
    return round2(hand + wh);
}

function updatePaySummary() {
    const ed = periodEditors.payPeriods;
    if (ed && ed.rows.length === 1) {
        ed.rows[0].amount = payTotal() || null;
        const inp = document.querySelector('#payPeriods [data-pf="amount"]');
        if (inp) inp.value = ed.rows[0].amount ?? '';
    }
    if (ed) updatePeriodStatus('payPeriods');
    const box = document.getElementById('paySummary');
    const hand = Number(document.getElementById('payAmount').value || 0);
    const wh = payState.debt > 0 ? Number(document.getElementById('payWithhold').value || 0) : 0;
    if (!(wh > 0)) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const c = payState.currency;
    box.classList.remove('hidden');
    box.innerHTML = `${e(tr('fin_payroll_salary', 'Оклад'))} <b>${FinUtils.fmtMoney(hand + wh, c)}</b> = ${e(tr('fin_payroll_on_hand', 'на руки'))} ${FinUtils.fmtMoney(hand, c)} + ${e(tr('fin_payroll_withheld', 'удержано'))} ${FinUtils.fmtMoney(wh, c)}`
        + (wh > payState.debt + 0.005 ? `<div class="text-error">⚠ ${e(tr('fin_payroll_withhold_over', 'Удержание больше долга'))}</div>` : '');
}

// ---------- «За какой месяц» у выплаты (828) ----------
// Выплата раскладывается строками «месяц — сумма», итог = сумма выплаты
// (вместе с удержанием). Проводка одна. Месяц вперёд можно — помечается
// «аванс»; больше начисленного — предупреждаем, но не запрещаем (ВГ 26.11).
const monthKey = iso => (iso || '').slice(0, 7);
const monthLabel = key => periodLabel(`${key}-01`);

// Начислено минус уже разложено выплатами — по месяцам (кроме правимой выплаты)
function monthRemaining(g, exceptId) {
    const m = new Map();
    for (const a of g.accruals) m.set(monthKey(a.period), (m.get(monthKey(a.period)) || 0) + Number(a.amount));
    for (const p of g.payments) {
        if (p.is_reversed || p.id === exceptId) continue;
        for (const x of p.periods || []) m.set(monthKey(x.period), (m.get(monthKey(x.period)) || 0) - Number(x.amount));
    }
    return m;
}

// Самый старый неоплаченный месяц (как в базе), нет такого — месяц даты
function oldestUnpaidMonth(g, exceptId, dateISO) {
    const rem = monthRemaining(g, exceptId);
    return [...rem.keys()].sort().find(k => rem.get(k) > 0.005) || monthKey(dateISO || FinUtils.todayISO());
}

// Месяцы для выбора: от начала работы до следующего месяца (аванс)
function periodMonthOptions(g, selected) {
    const lang = DateUtils.getLang();
    const names = DateUtils.monthNames[lang] || DateUtils.monthNames.ru;
    const start = DateUtils.parseDate(g.positions[0].effective_from);
    const now = new Date();
    const keys = [];
    for (let d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
         d >= new Date(start.getFullYear(), start.getMonth(), 1) && keys.length < 36;
         d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
        keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    if (selected && !keys.includes(selected)) keys.push(selected);
    // monthNames — родительный падеж («октября»), для списка нужен именительный
    const loc = { ru: 'ru-RU', en: 'en-US', hi: 'hi-IN' }[lang] || 'ru-RU';
    return keys.map(k => {
        const [y, m] = k.split('-').map(Number);
        const name = new Date(y, m - 1, 1).toLocaleDateString(loc, { month: 'long' }) || names[m - 1];
        return `<option value="${k}" ${k === selected ? 'selected' : ''}>${name} ${y}</option>`;
    }).join('');
}

// Редакторы строк: окно «Выплатить» и окно «Месяцы выплаты»
const periodEditors = {};

function setupPeriodEditor(containerId, opts) {
    periodEditors[containerId] = { containerId, ...opts };
    renderPeriodEditor(containerId);
}

function renderPeriodEditor(id) {
    const ed = periodEditors[id];
    const box = document.getElementById(id);
    box.innerHTML = ed.rows.map((r, i) => `
        <div class="flex gap-2 mb-1" data-pf-row="${i}">
            <select class="select select-bordered select-sm flex-1 min-w-0" data-pf="month">${periodMonthOptions(ed.g, r.month)}</select>
            <input type="number" class="input input-bordered input-sm w-28" min="0" step="0.01" data-pf="amount" value="${r.amount ?? ''}">
            ${ed.rows.length > 1 ? `<button type="button" class="btn btn-ghost btn-sm px-2" data-pf="del" title="${e(t('delete'))}">✕</button>` : ''}
        </div>`).join('')
        + `<button type="button" class="link link-primary text-sm" data-pf="add">+ ${e(tr('fin_payroll_add_month', 'Добавить месяц'))}</button>
           <div class="text-xs mt-1" data-pf="status"></div>`;
    updatePeriodStatus(id);
}

function readPeriodRows(id) {
    const ed = periodEditors[id];
    document.querySelectorAll(`#${id} [data-pf-row]`).forEach(row => {
        const r = ed.rows[Number(row.dataset.pfRow)];
        r.month = row.querySelector('[data-pf="month"]').value;
        const v = row.querySelector('[data-pf="amount"]').value;
        r.amount = v === '' ? null : round2(v);
    });
}

function periodEditorError(id) {
    const ed = periodEditors[id];
    const total = round2(ed.getTotal());
    if (ed.rows.some(r => !r.month || !(r.amount > 0))) return tr('fin_payroll_month_need_amount', 'У каждого месяца нужна сумма');
    if (new Set(ed.rows.map(r => r.month)).size !== ed.rows.length) return tr('fin_payroll_month_twice', 'Один и тот же месяц указан дважды');
    const sum = round2(ed.rows.reduce((s, r) => s + r.amount, 0));
    if (Math.abs(sum - total) > 0.005) {
        return tr('fin_payroll_months_mismatch', 'По месяцам {sum}, а выплата {total}')
            .replace('{sum}', FinUtils.fmtMoney(sum, ed.g.currency_code)).replace('{total}', FinUtils.fmtMoney(total, ed.g.currency_code));
    }
    return null;
}

function updatePeriodStatus(id) {
    const ed = periodEditors[id];
    const box = document.querySelector(`#${id} [data-pf="status"]`);
    if (!box) return;
    const rem = monthRemaining(ed.g, ed.exceptId);
    const payMonth = monthKey(ed.getDate());
    const notes = [];
    for (const r of ed.rows) {
        if (!r.month || !(r.amount > 0)) continue;
        if (r.month >= payMonth) notes.push(`<div class="opacity-70">${e(monthLabel(r.month))} — ${e(tr('fin_payroll_advance_mark', 'аванс'))}</div>`);
        const left = round2(rem.get(r.month) || 0);
        if (r.amount > left + 0.005) {
            notes.push(`<div class="text-warning">⚠ ${e(monthLabel(r.month))}: ${e(tr('fin_payroll_month_over', 'больше начисленного, осталось'))} ${FinUtils.fmtMoney(Math.max(left, 0), ed.g.currency_code)}</div>`);
        }
    }
    const err = periodEditorError(id);
    box.innerHTML = (err ? `<div class="text-error">⚠ ${e(err)}</div>` : '') + notes.join('');
}

function periodEditorPayload(id) {
    return periodEditors[id].rows.map(r => ({ period: `${r.month}-01`, amount: r.amount }));
}

function bindPeriodEditor(id) {
    const box = document.getElementById(id);
    box.addEventListener('input', () => { readPeriodRows(id); updatePeriodStatus(id); });
    box.addEventListener('change', () => { readPeriodRows(id); updatePeriodStatus(id); });
    box.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-pf]');
        if (!btn || btn.tagName !== 'BUTTON') return;
        const ed = periodEditors[id];
        readPeriodRows(id);
        if (btn.dataset.pf === 'add') {
            const last = ed.rows[ed.rows.length - 1]?.month || monthKey(ed.getDate());
            const d = DateUtils.parseDate(`${last}-01`);
            const next = DateUtils.toISO(new Date(d.getFullYear(), d.getMonth() + 1, 1)).slice(0, 7);
            const left = round2(ed.getTotal() - ed.rows.reduce((s, r) => s + (r.amount || 0), 0));
            ed.rows.push({ month: next, amount: left > 0 ? left : null });
        } else if (btn.dataset.pf === 'del') {
            ed.rows.splice(Number(btn.closest('[data-pf-row]').dataset.pfRow), 1);
        }
        renderPeriodEditor(id);
    });
}

// В ведомости: «за окт 2026» / «за сен 2026 50 000 + окт 2026 50 000»; нет — ⚠
function periodsHtml(p) {
    const list = p.periods || [];
    const edit = ` <button type="button" class="link link-primary" data-edit-periods="${p.id}">${e(tr('fin_payroll_months_edit', 'изменить'))}</button>`;
    if (!list.length) {
        if (p.is_reversed) return '';
        return `<div class="text-warning font-semibold">⚠ ${e(tr('fin_payroll_month_unknown', 'месяц не указан'))}${edit}</div>`;
    }
    const payMonth = monthKey(p.occurred_on);
    const parts = list.map(x => {
        const k = monthKey(x.period);
        const adv = k >= payMonth ? ` (${e(tr('fin_payroll_advance_mark', 'аванс'))})` : '';
        return list.length > 1
            ? `${e(monthLabel(k))}${adv} <span class="whitespace-nowrap">${FinUtils.fmtMoney(x.amount, p.currency_code)}</span>`
            : `${e(monthLabel(k))}${adv}`;
    });
    return `<div class="opacity-80">${e(tr('fin_payroll_for_month', 'за'))} ${parts.join(' + ')}${p.is_reversed ? '' : edit}</div>`;
}

// ⚠ Выплаты без месяца — список, клик открывает окно месяцев
function renderPeriodsWarning() {
    const box = document.getElementById('payrollPeriodsWarn');
    const list = payments.filter(p => !p.is_reversed && !(p.periods || []).length)
        .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on));
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="alert alert-warning mb-4 items-start">
        <div class="w-full">
            <div class="font-semibold">⚠ ${e(tr('fin_payroll_months_missing_title', 'Выплаты без месяца'))}: ${list.length}</div>
            <ul class="mt-1 text-sm">${list.map(p => {
                const g = groupByPosition(p.position_id);
                return `<li><button type="button" class="hover:underline text-left" data-edit-periods="${p.id}">
                    • ${e(g?.employee_name || '')} (${e(g?.department_name || '')}) — ${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}, ${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.comment ? ` — <span class="opacity-70">${e(p.comment)}</span>` : ''}
                </button></li>`;
            }).join('')}</ul>
        </div>
    </div>`;
}

function openPeriodsModal(paymentId) {
    const p = payments.find(x => x.id === paymentId);
    const g = p && groupByPosition(p.position_id);
    if (!g) return;
    document.getElementById('periodsPaymentId').value = paymentId;
    document.getElementById('periodsModalTitle').textContent = `${tr('fin_payroll_months_title', 'За какой месяц')} — ${g.employee_name} (${g.department_name})`;
    document.getElementById('periodsModalSub').textContent =
        `${DateUtils.formatShort(DateUtils.parseDate(p.occurred_on))}, ${FinUtils.fmtMoney(p.amount, p.currency_code)}${p.comment ? ` — ${p.comment}` : ''}`;
    const rows = (p.periods || []).length
        ? p.periods.map(x => ({ month: monthKey(x.period), amount: round2(x.amount) }))
        : [{ month: oldestUnpaidMonth(g, p.id, p.occurred_on), amount: round2(p.amount) }];
    setupPeriodEditor('periodsRows', { g, rows, exceptId: p.id, getTotal: () => Number(p.amount), getDate: () => p.occurred_on });
    document.getElementById('periodsModal').showModal();
}

async function submitPeriods(ev) {
    ev.preventDefault();
    readPeriodRows('periodsRows');
    const err = periodEditorError('periodsRows');
    if (err) { Layout.showNotification(err, 'error'); return; }
    const res = await FinUtils.rpc('fin_set_payroll_payment_periods', {
        payment_id: document.getElementById('periodsPaymentId').value,
        periods: periodEditorPayload('periodsRows')
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('periodsModal').close();
        await load();
    }
}

// Оплата жилья: сумма к оплате подставляется, кому отдали — обязательно
function openHousingModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('housingPositionId').value = positionId;
    document.getElementById('housingModalTitle').textContent = `${tr('fin_payroll_pay_housing', 'Оплатить жильё')} — ${g.employee_name}`;
    const hb = round2(g.housing_balance);
    document.getElementById('housingAmount').value = hb > 0 ? hb : (g.housing_amount ?? '');
    document.getElementById('housingPaidTo').value = g.housing_paid_to || 'landlord';
    document.getElementById('housingPayee').value = g.housing_payee || '';
    document.getElementById('housingDate').value = FinUtils.todayISO();
    document.getElementById('housingComment').value = '';
    // «За какой месяц» — необязательно; по умолчанию первый неоплаченный не угадываем
    document.getElementById('housingPeriod').innerHTML = `<option value="">—</option>` + monthOptions(g.positions[0].effective_from);
    document.getElementById('housingModal').showModal();
}

async function submitHousing(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_pay_payroll_housing', {
        position_id: document.getElementById('housingPositionId').value,
        amount: document.getElementById('housingAmount').value,
        occurred_on: document.getElementById('housingDate').value,
        paid_to: document.getElementById('housingPaidTo').value,
        payee: document.getElementById('housingPayee').value || null,
        period: document.getElementById('housingPeriod').value ? document.getElementById('housingPeriod').value + '-01' : null,
        comment: document.getElementById('housingComment').value || null
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('housingModal').close();
        await load();
    }
}

function monthOptions(fromISO) {
    const lang = DateUtils.getLang();
    const names = DateUtils.monthNames[lang] || DateUtils.monthNames.ru;
    const start = DateUtils.parseDate(fromISO);
    const now = new Date();
    const opts = [];
    for (let d = new Date(now.getFullYear(), now.getMonth(), 1);
         d >= new Date(start.getFullYear(), start.getMonth(), 1) && opts.length < 36;
         d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
        const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        opts.push(`<option value="${v}">${names[d.getMonth()]} ${d.getFullYear()}</option>`);
    }
    return opts.join('');
}

// Ручная строка к жилью — свет и т.п. по чеку
function openHousingLineModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('housingLinePositionId').value = positionId;
    document.getElementById('housingLineTitle').textContent = `${tr('fin_payroll_housing_line', 'строка к жилью (свет по чеку)')} — ${g.employee_name}`;
    document.getElementById('housingLinePeriod').innerHTML = monthOptions(g.positions[0].effective_from);
    document.getElementById('housingLineAmount').value = '';
    document.getElementById('housingLineComment').value = tr('fin_payroll_housing_line_default', 'Свет по чеку');
    document.getElementById('housingLineModal').showModal();
}

async function submitHousingLine(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_payroll_housing_line', {
        position_id: document.getElementById('housingLinePositionId').value,
        period: document.getElementById('housingLinePeriod').value + '-01',
        amount: document.getElementById('housingLineAmount').value,
        comment: document.getElementById('housingLineComment').value
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('housingLineModal').close();
        await load();
    }
}

async function skipHousingMonth(id) {
    const reason = prompt(tr('fin_payroll_housing_skip_reason', 'Почему жильё за этот месяц не начисляем? (например: уехал, оплачено вперёд)'));
    if (!reason || !reason.trim()) return;
    const res = await FinUtils.rpc('fin_payroll_housing_line', { skip_id: id, reason: reason.trim() });
    if (FinUtils.handleResult(res)) await load();
}

async function unskipHousingMonth(id) {
    const res = await FinUtils.rpc('fin_payroll_housing_line', { unskip_id: id });
    if (FinUtils.handleResult(res)) await load();
}

async function deleteHousingLine(id) {
    if (!confirm(tr('fin_payroll_housing_line_delete', 'Удалить эту строку жилья?'))) return;
    const res = await FinUtils.rpc('fin_payroll_housing_line', { delete_id: id });
    if (FinUtils.handleResult(res)) await load();
}

// Ручное начисление за месяц — для тех, у кого сумму каждый месяц называет
// глава департамента. По умолчанию предлагаем прошлый месяц: за него и платят.
function openAccrueModal(positionId) {
    const g = groupByPosition(positionId);
    if (!g) return;
    document.getElementById('accruePositionId').value = positionId;
    document.getElementById('accrueModalTitle').textContent = `${t('fin_payroll_accrue_title')} — ${g.employee_name} (${g.department_name})`;
    // Список месяцев вместо ручного ввода: от начала работы человека в этом
    // департаменте до текущего (раньше и позже начислять нечего). По умолчанию —
    // текущий месяц: то, что вносят сейчас, хронологически идёт «сегодняшним»
    // числом; если платят за другой месяц — выбирают его из списка.
    const lang = DateUtils.getLang();
    const names = DateUtils.monthNames[lang] || DateUtils.monthNames.ru;
    const start = DateUtils.parseDate(g.positions[0].effective_from);
    const now = new Date();
    const opts = [];
    for (let d = new Date(now.getFullYear(), now.getMonth(), 1);
         d >= new Date(start.getFullYear(), start.getMonth(), 1) && opts.length < 36;
         d = new Date(d.getFullYear(), d.getMonth() - 1, 1)) {
        const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        opts.push(`<option value="${v}">${names[d.getMonth()]} ${d.getFullYear()}</option>`);
    }
    const sel = document.getElementById('accruePeriod');
    sel.innerHTML = opts.join('');
    sel.selectedIndex = 0;
    document.getElementById('accrueAmount').value = g.salary_amount ?? '';
    document.getElementById('accrueModal').showModal();
}

async function submitAccrue(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_set_payroll_accrual', {
        position_id: document.getElementById('accruePositionId').value,
        period: document.getElementById('accruePeriod').value + '-01',
        amount: document.getElementById('accrueAmount').value
    });
    if (FinUtils.handleResult(res, 'fin_payroll_accrual_done')) {
        document.getElementById('accrueModal').close();
        await load();
    }
}

async function submitPay(ev) {
    ev.preventDefault();
    const withhold = payState.debt > 0 ? (document.getElementById('payWithhold').value || null) : null;
    readPeriodRows('payPeriods');
    const perr = periodEditorError('payPeriods');
    if (perr) { Layout.showNotification(perr, 'error'); return; }
    const res = await FinUtils.rpc('fin_pay_payroll', {
        periods: periodEditorPayload('payPeriods'),
        position_id: document.getElementById('payPositionId').value,
        amount: document.getElementById('payAmount').value,
        withhold_amount: withhold,
        occurred_on: document.getElementById('payDate').value,
        comment: document.getElementById('payComment').value || null
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('payModal').close();
        await load();
    }
}

// Начисление по расписанию срабатывает 1-го числа; сотруднику, заведённому
// посреди месяца, до этой даты неоткуда взять начисление — кнопка запускает
// ту же серверную функцию вручную. Идемпотентно: уже начисленные месяцы
// просто пропускаются, повторный клик ничего не задвоит.
async function runAccrualNow(ev) {
    const btn = ev.currentTarget;
    if (btn.disabled) return;
    const old = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="loading loading-spinner loading-xs"></span> ${old}`;
    try {
        const res = await FinUtils.rpc('fin_trigger_payroll_accrual');
        if (FinUtils.handleResult(res, 'fin_payroll_accrual_done')) await load();
    } finally {
        btn.disabled = false;
        btn.innerHTML = old;
    }
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_payroll', itemId: 'fin_payroll' });

    // Кэш переводов в браузере живёт долго и не знает про новые ключи: вместо
    // «fin_payroll_range_all_short» на экране — один раз сбрасываем и перечитываем
    if (['fin_payroll_range_all_short', 'fin_payroll_ended_on', 'fin_payroll_invite_text', 'fin_payroll_tg_off_short', 'fin_payroll_tab_hired', 'fin_payroll_invite_text_gift', 'fin_payroll_wait_confirm_tg', 'fin_payroll_housing_due', 'fin_payroll_paid_to_landlord'].some(k => t(k) === k)
        && !sessionStorage.getItem('payrollTrReload7')) {
        sessionStorage.setItem('payrollTrReload7', '1');
        Cache.invalidate('translations_v87');
        location.reload();
        return;
    }

    document.getElementById('payrollBody').addEventListener('click', ev => {
        const payBtn = ev.target.closest('[data-pay]');
        const toggleBtn = ev.target.closest('[data-toggle]');
        const accrueBtn = ev.target.closest('[data-accrue]');
        const inviteBtn = ev.target.closest('[data-invite]');
        const tgBtn = ev.target.closest('[data-tg-toggle]');
        const housingBtn = ev.target.closest('[data-pay-housing]');
        const lineBtn = ev.target.closest('[data-housing-line]');
        const delBtn = ev.target.closest('[data-housing-del]');
        const skipBtn = ev.target.closest('[data-housing-skip]');
        const unskipBtn = ev.target.closest('[data-housing-unskip]');
        const payeeBtn = ev.target.closest('[data-housing-payee]');
        const absBtn = ev.target.closest('[data-absence-cancel]');
        const periodsBtn = ev.target.closest('[data-edit-periods]');
        if (periodsBtn) openPeriodsModal(periodsBtn.dataset.editPeriods);
        else if (absBtn) cancelAbsence(absBtn.dataset.absenceCancel);
        else if (payeeBtn) openPayeeModal(payeeBtn.dataset.housingPayee);
        else if (skipBtn) skipHousingMonth(skipBtn.dataset.housingSkip);
        else if (unskipBtn) unskipHousingMonth(unskipBtn.dataset.housingUnskip);
        else if (housingBtn) openHousingModal(housingBtn.dataset.payHousing);
        else if (lineBtn) openHousingLineModal(lineBtn.dataset.housingLine);
        else if (delBtn) deleteHousingLine(delBtn.dataset.housingDel);
        else if (tgBtn) toggleTelegram(tgBtn.dataset.tgToggle, tgBtn.dataset.tgEnabled !== '1');
        else if (inviteBtn) copyInvite(inviteBtn.dataset.invite);
        else if (payBtn) openPayModal(payBtn.dataset.pay);
        else if (accrueBtn) openAccrueModal(accrueBtn.dataset.accrue);
        else if (toggleBtn) toggleDetail(toggleBtn.dataset.toggle);
    });
    ['payrollConfirmWarn', 'payrollPayablesWarn'].forEach(id => document.getElementById(id).addEventListener('click', ev => {
        const btn = ev.target.closest('[data-open-pos]');
        if (btn) openPosition(btn.dataset.openPos);
    }));
    document.getElementById('housingPayeeForm').addEventListener('submit', FinUtils.lockedSubmit(submitPayee));
    document.getElementById('payrollPeriodsWarn').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-edit-periods]');
        if (btn) openPeriodsModal(btn.dataset.editPeriods);
    });
    bindPeriodEditor('payPeriods');
    bindPeriodEditor('periodsRows');
    document.getElementById('payDate').addEventListener('change', () => updatePeriodStatus('payPeriods'));
    document.getElementById('periodsForm').addEventListener('submit', FinUtils.lockedSubmit(submitPeriods));
    document.getElementById('payForm').addEventListener('submit', FinUtils.lockedSubmit(submitPay));
    document.getElementById('accrueForm').addEventListener('submit', FinUtils.lockedSubmit(submitAccrue));
    document.getElementById('housingForm').addEventListener('submit', FinUtils.lockedSubmit(submitHousing));
    document.getElementById('housingLineForm').addEventListener('submit', FinUtils.lockedSubmit(submitHousingLine));
    document.getElementById('payAmount').addEventListener('input', updatePaySummary);
    document.getElementById('payWithhold').addEventListener('input', updatePaySummary);
    document.getElementById('runAccrualBtn').addEventListener('click', runAccrualNow);
    document.getElementById('showEnded').addEventListener('change', render);
    document.getElementById('payrollRange').addEventListener('change', render);

    // вторая вкладка — «Наёмные рабочие» (fin-hired.js)
    window.FinHired?.init();
    await load();
}

init();
})();
