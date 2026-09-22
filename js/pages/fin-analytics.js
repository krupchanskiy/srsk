// ==================== ФИНАНСЫ: АНАЛИТИКА ====================
// 9.6 «По ретриту»: живой отчёт, закрытие (UC-12), версии, PDF.
// 9.7 «Общая»: период → статьи / месяцы / объекты.
// PDF формируется на клиенте (pdf-lib + fontkit + Noto Sans) из
// snapshot версии закрытия, загружается как объектное вложение и
// связывается fin_finalize_closure — сбой генерации ничего не откатывает.
(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
const fmtB = n => FinUtils.fmtMoney(n, 'INR');

let retreats = [];
let currentRetreat = null;
let currentData = null;   // результат fin_get_retreat_report

// ==================== ПО РЕТРИТУ ====================
async function loadRetreats() {
    const { data } = await Layout.db.from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date')
        .order('start_date', { ascending: false });
    retreats = data || [];
    const sel = document.getElementById('retreatSelect');
    sel.innerHTML = `<option value="">${t('fin_select_retreat')}</option>` +
        retreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}</option>`).join('');
    sel.addEventListener('change', () => selectRetreat(sel.value || null));
}

async function selectRetreat(id) {
    currentRetreat = id;
    const fullReportLink = document.getElementById('fullReportLink');
    if (!id) {
        document.getElementById('retreatReport').innerHTML =
            `<div class="text-center py-8 opacity-60">${t('fin_select_retreat')}</div>`;
        fullReportLink.classList.add('hidden');
        return;
    }
    fullReportLink.href = `retreat-report.html?id=${id}`;
    fullReportLink.classList.remove('hidden');
    await loadReport();
}

// Касса кафе — самостоятельная единица внутри ретрита (ВГ, сен 2026): из
// общей разбивки по статьям вычитаем кафе-часть (одна статья может тратиться
// и с кассы кафе, и с обычной кассы ретрита одновременно), чтобы на вкладке
// «Ретрит» суммы были только ретрита, а кафе — отдельной вкладкой.
const round2 = n => Math.round(n * 100) / 100;

function subtractCategoryRows(mainRows, subRows) {
    const byCategory = new Map((subRows || []).map(x => [x.category_id, x]));
    return (mainRows || []).map(row => {
        const sub = byCategory.get(row.category_id);
        if (!sub) return row;
        const by_currency = {};
        for (const [code, val] of Object.entries(row.by_currency || {})) {
            const rest = round2(Number(val) - Number(sub.by_currency?.[code] || 0));
            if (Math.abs(rest) > 0.005) by_currency[code] = rest;
        }
        return { ...row, base_total: round2(Number(row.base_total) - Number(sub.base_total)), by_currency };
    }).filter(row => Math.abs(row.base_total) > 0.005);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Приходы — зелёным, расходы — красным. Клик по строке открывает справа список
// операций (fin_get_report_drilldown); unit — какой юнит отчёта показан.
function catTable(rows, titleKey, unit = 'retreat') {
    if (!rows?.length) return '';
    const dir = titleKey === 'fin_income_by_category' ? 'in' : 'out';
    return `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
        <h2 class="card-title text-base font-bold ${dir === 'in' ? 'text-success' : 'text-error'}">${t(titleKey)}</h2>
        <div class="overflow-x-auto"><table class="table table-sm">
            <tbody>${rows.map(r => `<tr class="fin-drill-row cursor-pointer hover:bg-base-200"
                    data-drill-unit="${unit}" data-drill-dir="${dir}" data-drill-group="${e(r.category_id)}" data-drill-name="${e(r.name)}">
                    <td>${e(r.name)}</td>
                    <td class="text-right opacity-60">${Object.entries(r.by_currency || {}).map(([c, v]) => FinUtils.fmtMoney(v, c)).join(' · ')}</td>
                    <td class="text-right font-mono w-36">${fmtB(r.base_total)}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>
    </div></div>`;
}

// ---- Детализация строки отчёта (панель справа) ----
let drillToken = 0;

function drillPanel() { return document.getElementById('finDrill'); }

function drillHintHtml() {
    return `<div class="p-6 text-sm opacity-50 text-center">${t('fin_drill_hint')}</div>`;
}

function resetDrill() {
    drillToken++;
    document.querySelectorAll('.fin-drill-row.bg-base-200').forEach(x => x.classList.remove('bg-base-200'));
    const panel = drillPanel();
    if (panel) panel.innerHTML = drillHintHtml();
}

function drillOpHtml(r) {
    const amount = Number(r.amount);
    const title = r.description || r.reason || r.participant || '—';
    const meta = [
        r.description && r.participant ? e(r.participant) : '',
        r.account ? e(r.account) : '',
        r.entered_by ? `${t('fin_drill_entered_by')} ${e(r.entered_by)}` : ''
    ].filter(Boolean).join(' · ');
    const inBase = r.currency !== 'INR'
        ? `<div class="text-xs opacity-50">= ${fmtB(r.amount_base)}</div>` : '';
    return `<a href="dds.html?op=${encodeURIComponent(r.operation_id)}" target="_blank" rel="noopener"
            class="block px-4 py-2 border-b border-base-200 hover:bg-base-200/60">
        <div class="flex justify-between gap-3">
            <div class="min-w-0">
                <div class="text-xs opacity-60">${DateUtils.formatShort(DateUtils.parseDate(r.occurred_on))}</div>
                <div class="text-sm break-words">${e(title)}</div>
                ${meta ? `<div class="text-xs opacity-60 break-words">${meta}</div>` : ''}
            </div>
            <div class="text-right font-mono whitespace-nowrap ${amount < 0 ? 'text-error' : ''}">
                ${FinUtils.fmtMoney(amount, r.currency)}${inBase}
            </div>
        </div></a>`;
}

async function openDrill(rowEl) {
    const { drillUnit: unit, drillDir: dir, drillGroup: group, drillName: name } = rowEl.dataset;
    const panel = drillPanel();
    if (!panel || !currentData?.object_id) return;
    const token = ++drillToken;
    document.querySelectorAll('.fin-drill-row.bg-base-200').forEach(x => x.classList.remove('bg-base-200'));
    rowEl.classList.add('bg-base-200');

    const titleCls = dir === 'in' ? 'text-success' : 'text-error';
    const ddsLink = UUID_RE.test(group)
        ? `<a class="link link-primary text-xs" target="_blank" rel="noopener"
              href="dds.html?category=${group}&object=${currentData.object_id}">${t('fin_open_in_dds')}</a>` : '';
    const head = extra => `
        <div class="px-4 py-3 border-b border-base-200 flex items-start justify-between gap-2 shrink-0">
            <div class="min-w-0">
                <div class="font-bold ${titleCls}">${e(name)}</div>
                <div class="text-xs opacity-60">${extra}</div>
            </div>
            <div class="flex items-center gap-2 shrink-0">${ddsLink}
                <button type="button" class="btn btn-ghost btn-xs" data-drill-close>✕</button></div>
        </div>`;
    panel.innerHTML = head('') + `<div class="p-6 text-center"><span class="loading loading-spinner loading-md"></span></div>`;
    if (window.innerWidth < 1024) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const { data, error } = await Layout.db.rpc('fin_get_report_drilldown', {
        p_object: currentData.object_id, p_unit: unit, p_direction: dir, p_group: group
    });
    if (token !== drillToken) return;
    if (error || !data?.ok) {
        panel.innerHTML = head('') + `<div class="p-4 text-sm text-error">${e(data?.error?.message || error?.message || 'Ошибка')}</div>`;
        return;
    }
    const { rows, total_base } = data.result;
    panel.innerHTML = head(`${rows.length} · ${fmtB(total_base)}`) + (rows.length
        ? `<div class="overflow-y-auto min-h-0 flex-1">${rows.map(drillOpHtml).join('')}</div>`
        : `<div class="p-6 text-sm opacity-50 text-center">${t('fin_drill_empty')}</div>`);
}

function onReportClick(ev) {
    if (ev.target.closest('[data-drill-close]')) { resetDrill(); return; }
    const row = ev.target.closest('.fin-drill-row');
    if (row) openDrill(row);
}

function closureBlock(d) {
    const isAdmin = window.hasPermission?.('fin_admin');
    let statusHtml;
    if (!d.is_closed) {
        statusHtml = `<span class="badge badge-success">${t('fin_status_open')}</span>
            ${isAdmin ? `<button class="btn btn-error btn-sm ml-auto" onclick="FinAnalytics.openClose()">${t('fin_close_retreat')}</button>` : ''}`;
    } else if (d.report_dirty_at) {
        statusHtml = `<span class="badge badge-neutral">${t('fin_status_closed')}</span>
            <span class="badge badge-warning">${t('fin_report_dirty')}</span>
            ${isAdmin ? `<button class="btn btn-warning btn-sm ml-auto" onclick="FinAnalytics.openReissue()">${t('fin_reissue')}</button>` : ''}`;
    } else {
        statusHtml = `<span class="badge badge-neutral">${t('fin_status_closed')}</span>`;
    }

    const versions = (d.versions || []).map(v => `
        <tr>
            <td>v${v.version}${v.is_initial ? ` <span class="opacity-70 text-xs">${t('fin_initial')}</span>` : ''}</td>
            <td>${v.status === 'finalized'
                ? `<span class="badge badge-success badge-sm">${t('fin_finalized')}</span>`
                : `<span class="badge badge-warning badge-sm">${t('fin_report_pending')}</span>`}</td>
            <td class="whitespace-nowrap opacity-70">${v.closed_at ? DateUtils.formatShort(new Date(v.closed_at.slice(0, 16))) : ''}</td>
            <td class="opacity-70">${e(v.reason || '')}</td>
            <td class="text-right">${v.attachment_path
                ? `<button class="btn btn-ghost btn-xs" data-attachment-path="${e(v.attachment_path)}">PDF</button>`
                : (window.hasPermission?.('fin_admin')
                    ? `<button class="btn btn-outline btn-xs" onclick="FinAnalytics.makePdf('${v.closure_id}', ${v.version})">${t('fin_generate_pdf')}</button>`
                    : '')}</td>
        </tr>`).join('');

    return `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
        <div class="flex items-center gap-2 flex-wrap">
            <h2 class="card-title text-base mr-2">${t('fin_closure')}</h2>
            ${statusHtml}
        </div>
        ${versions ? `<div class="overflow-x-auto"><table class="table table-sm mt-2"><tbody>${versions}</tbody></table></div>` : ''}
    </div></div>`;
}

// ==================== ПРАСАД: РАСЧЁТНАЯ СЕБЕСТОИМОСТЬ ====================
// Считает кухонный движок (js/kitchen-cost.js) по вкушающим ретрита и ценам кухни.
// Показывается только тем, кто вправе смотреть себестоимость (fin_kitchen_can_view).
// Расчёт — это те же затраты, что и в расходах ДДС, посчитанные по модели, поэтому
// с фактическим расходом прасада он НЕ суммируется: строка ДДС дана для справки.
let kitchenCostAllowed = null;
let prasadCostToken = 0;

async function canViewKitchenCost() {
    if (kitchenCostAllowed === null) {
        const { data } = await Layout.db.rpc('fin_kitchen_can_view');
        kitchenCostAllowed = data === true;
    }
    return kitchenCostAllowed;
}

// Карточка в отчёте по департаментам: расчётная себестоимость прасада за период (только для «Кухни»)
async function fillDeptPrasadCost(from, to) {
    const box = document.getElementById('deptPrasadCostBox');
    if (!box || typeof KitchenCost === 'undefined') return;
    try {
        if (!await canViewKitchenCost()) return;
        const locationId = (Layout.locations || []).find(l => l.slug === 'main')?.id;
        if (!locationId) return;
        if ((DateUtils.parseDate(to) - DateUtils.parseDate(from)) / 86400000 > 92) {
            box.innerHTML = `<p class="text-xs opacity-60">${t('fin_prasad_cost_long')}</p>`;
            return;
        }
        const res = await KitchenCost.calculate(Layout.db, locationId, from, to);
        if (!document.getElementById('deptPrasadCostBox')) return;
        const cs = Object.values(res.cells).flatMap(ev => Object.values(ev));
        const sum = f => cs.reduce((a, c) => a + f(c), 0);
        const direct = sum(c => c.food + c.dishware + c.external);
        const overhead = sum(c => c.overheadRetreat + c.overheadGeneral);
        const pm = sum(c => c.personMeals);
        const total = direct + overhead;
        box.innerHTML = `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <div class="flex items-center gap-2 flex-wrap">
                <h2 class="card-title text-base">${t('fin_prasad_cost_title')}</h2>
                ${res.totals.provisional ? `<span class="badge badge-warning badge-sm" title="${e(t('fin_prasad_cost_prov_hint'))}">${t('fin_prasad_cost_prov')}</span>` : ''}
                <a class="badge badge-outline badge-sm ml-auto" href="../kitchen/cost.html">${t('fin_prasad_cost_details')}</a>
            </div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div><div class="opacity-60 text-xs">${t('fin_prasad_cost_direct')}</div><div class="font-mono">${fmtB(direct)}</div></div>
                <div><div class="opacity-60 text-xs">${t('fin_prasad_cost_overhead')}</div><div class="font-mono">${fmtB(overhead)}</div></div>
                <div><div class="opacity-60 text-xs">${t('fin_prasad_cost_total')}</div><div class="font-mono font-semibold">${fmtB(total)}</div></div>
                <div><div class="opacity-60 text-xs">${t('fin_prasad_cost_per_person')}</div><div class="font-mono">${pm ? fmtB(total / pm) : '—'}</div></div>
            </div>
            <p class="text-xs opacity-60">${t('fin_prasad_cost_note')}</p>
        </div></div>`;
    } catch (err) {
        console.error('Dept prasad cost:', err);
        box.innerHTML = '';
    }
}

async function fillPrasadCost(retreatId, prasadTotals) {
    const box = document.getElementById('prasadCostBox');
    if (!box || typeof KitchenCost === 'undefined') return;
    const token = ++prasadCostToken;
    try {
        if (!await canViewKitchenCost()) return;
        const retreat = retreats.find(x => x.id === retreatId);
        const locationId = (Layout.locations || []).find(l => l.slug === 'main')?.id;
        if (!retreat?.start_date || !retreat?.end_date || !locationId) return;

        box.innerHTML = `<div class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></div>`;
        const res = await KitchenCost.calculate(Layout.db, locationId, retreat.start_date, retreat.end_date);
        if (token !== prasadCostToken) return;

        const evCells = Object.values(res.cells[`retreat:${retreatId}`] || {});
        const sum = f => evCells.reduce((a, c) => a + f(c), 0);
        const x = { pm: sum(c => c.personMeals), food: sum(c => c.food), dish: sum(c => c.dishware), ext: sum(c => c.external),
                    ovR: sum(c => c.overheadRetreat), ovG: sum(c => c.overheadGeneral) };
        const total = x.food + x.dish + x.ext + x.ovR + x.ovG;
        const provisional = evCells.some(c => c.provisional) || DateUtils.toISO(new Date()) < retreat.end_date;
        const w = res.warnings;
        const gaps = w.missingPrices.size + w.unresolvedUnits.size + w.noMenu.length + w.overheadNoBase.length + w.overheadUnallocated.length + (w.overheadError ? 1 : 0);
        const income = Number(prasadTotals?.income_base || 0);
        const expenseDds = Number(prasadTotals?.expense_base || 0);
        const result = income - total;
        const row = (label, val, cls = '') => `<tr class="${cls}"><td>${label}</td><td class="text-right font-mono w-36">${fmtB(val)}</td></tr>`;

        box.innerHTML = `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <div class="flex items-center gap-2 flex-wrap">
                <h2 class="card-title text-base">${t('fin_prasad_cost_title')}</h2>
                ${provisional ? `<span class="badge badge-warning badge-sm" title="${e(t('fin_prasad_cost_prov_hint'))}">${t('fin_prasad_cost_prov')}</span>` : ''}
                ${gaps ? `<a class="badge badge-outline badge-sm ml-auto" href="../kitchen/cost.html">${t('fin_prasad_cost_gaps')}: ${gaps}</a>` : ''}
            </div>
            <div class="overflow-x-auto"><table class="table table-sm">
                <tbody>
                    ${row(t('cost_food'), x.food)}${row(t('cost_dishware'), x.dish)}${row(t('cost_external'), x.ext)}
                    ${row(t('cost_overhead_retreat'), x.ovR)}${row(t('cost_overhead_general'), x.ovG)}
                    ${row(t('fin_prasad_cost_total'), total, 'font-semibold border-t-2 border-base-300')}
                    <tr><td>${t('fin_prasad_cost_per_person')} (${x.pm} ${t('fin_prasad_cost_person_meals')})</td>
                        <td class="text-right font-mono">${x.pm ? fmtB(total / x.pm) : '—'}</td></tr>
                    ${row(t('fin_prasad_cost_income'), income, 'border-t border-base-300')}
                    ${row(t('fin_prasad_cost_result'), result, `font-semibold ${result < 0 ? 'text-error' : 'text-success'}`)}
                    <tr class="opacity-60 text-xs"><td>${t('fin_prasad_cost_dds')}</td><td class="text-right font-mono">${fmtB(expenseDds)}</td></tr>
                </tbody>
            </table></div>
            <p class="text-xs opacity-60">${t('fin_prasad_cost_note')}</p>
        </div></div>`;
    } catch (err) {
        console.error('Prasad cost:', err);
        if (token === prasadCostToken) box.innerHTML = '';
    }
}

async function loadReport() {
    const box = document.getElementById('retreatReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }
    currentData = data.result;

    if (!currentData.exists) {
        box.innerHTML = `<div class="text-center py-8 opacity-60">${t('fin_no_fin_data')}</div>`;
        return;
    }
    const r = currentData.report;
    const p = r.participants;
    const tot = r.totals;
    const cafe = r.cafe?.totals;
    const prasad = r.prasad?.totals;
    const hasCafeActivity = cafe && (Number(cafe.income_base) || Number(cafe.expense_base));
    const hasPrasadActivity = prasad && (Number(prasad.income_base) || Number(prasad.expense_base));

    const kpi = (chip, icon, label, value, sub) => `
        <div class="card bg-base-100 fin-kpi"><div class="card-body">
            <div class="flex items-start gap-3">
                <div class="fin-icon-chip ${chip}">${icon}</div>
                <div class="min-w-0">
                    <div class="fin-kpi-label">${label}</div>
                    <div class="fin-kpi-value mt-0.5">${value}</div>
                    ${sub ? `<div class="text-xs opacity-70 mt-0.5">${sub}</div>` : ''}
                </div>
            </div>
        </div></div>`;
    const icUsers = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>';
    const icUp = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18L9 11.25l4.306 4.307a11.95 11.95 0 015.814-5.519l2.74-1.22m0 0l-5.94-2.28m5.94 2.28l-2.28 5.941"/></svg>';
    const icDown = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6L9 12.75l4.286-4.286a11.948 11.948 0 014.306 6.43l.776 2.898m0 0l3.182-5.511m-3.182 5.51l-5.511-3.181"/></svg>';
    const icNet = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.7" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 8.25H7.5a2.25 2.25 0 00-2.25 2.25v9a2.25 2.25 0 002.25 2.25h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25H15M9 12l2.25 2.25L15 9.75M9 8.25V6a3 3 0 013-3v0a3 3 0 013 3v2.25"/></svg>';

    // Руководитель департамента (просмотр): сервер отдаёт только блок «Прасад» —
    // без оргвзноса, проживания, долгов участников и кафе
    if (currentData.restricted) {
        const pr = r.prasad || { income_by_category: [], expense_by_category: [], totals: {} };
        const pt = pr.totals || {};
        box.innerHTML = `
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                ${kpi('', icUp, t('fin_income'), `<span class="text-success">${fmtB(pt.income_base || 0)}</span>`)}
                ${kpi('is-error', icDown, t('fin_expense'), `<span class="text-error">${fmtB(pt.expense_base || 0)}</span>`)}
                ${kpi(Number(pt.net_base) < 0 ? 'is-error' : '', icNet, t('fin_net'), `<span class="${Number(pt.net_base) < 0 ? 'text-error' : ''}">${fmtB(pt.net_base || 0)}</span>`)}
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <div class="min-w-0 space-y-4">
                    <h2 class="text-lg font-semibold">${t('retreat_report_finance_prasad')}</h2>
                    ${catTable(pr.income_by_category, 'fin_income_by_category', 'prasad')}
                    ${catTable(pr.expense_by_category, 'fin_expense_by_category', 'prasad')}
                    <div id="prasadCostBox"></div>
                </div>
                <div id="finDrill" class="card bg-base-100 shadow-sm lg:sticky lg:top-4 flex flex-col overflow-hidden"
                     style="max-height: calc(100vh - 2rem)">${drillHintHtml()}</div>
            </div>`;
        fillPrasadCost(currentRetreat, pt);
        return;
    }

    // Разбивка по статьям без кафе и без прасада (самостоятельные единицы, см. subtractCategoryRows)
    let retreatIncomeRows = r.income_by_category;
    let retreatExpenseRows = r.expense_by_category;
    if (hasCafeActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, r.cafe.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, r.cafe.expense_by_category);
    }
    if (hasPrasadActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, r.prasad.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, r.prasad.expense_by_category);
    }

    const splitRow = (label, block, opts = {}) => `<tr class="${opts.bold ? 'font-semibold border-t-2 border-base-300' : ''}">
        <td class="${opts.indent ? 'pl-6 text-sm opacity-70' : ''}">${label}</td>
        <td class="text-right font-mono text-success">${fmtB(block.income_base)}</td>
        <td class="text-right font-mono text-error">${fmtB(block.expense_base)}</td>
        <td class="text-right font-mono ${Number(block.net_base) < 0 ? 'text-error' : 'text-success'}">${fmtB(block.net_base)}</td>
    </tr>`;

    // Прасад — часть ретрита (в отличие от кафе): «Ретрит» в своде — это
    // сумма собственно ретрита и прасада, кафе складывается только в «Итого»
    const retreatCombinedTotals = hasCafeActivity ? {
        income_base: round2(Number(tot.income_base) - Number(cafe.income_base)),
        expense_base: round2(Number(tot.expense_base) - Number(cafe.expense_base)),
        net_base: round2(Number(tot.net_base) - Number(cafe.net_base))
    } : tot;
    const retreatOnlyTotals = hasPrasadActivity ? {
        income_base: round2(Number(retreatCombinedTotals.income_base) - Number(prasad.income_base)),
        expense_base: round2(Number(retreatCombinedTotals.expense_base) - Number(prasad.expense_base)),
        net_base: round2(Number(retreatCombinedTotals.net_base) - Number(prasad.net_base))
    } : retreatCombinedTotals;

    const splitTotalsTable = (hasCafeActivity || hasPrasadActivity) ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <div class="overflow-x-auto"><table class="table table-sm">
                <thead><tr><th></th><th class="text-right">${t('fin_income')}</th><th class="text-right">${t('fin_expense')}</th><th class="text-right">${t('fin_net')}</th></tr></thead>
                <tbody>
                    ${splitRow(t('retreat_report_finance_retreat_only'), retreatCombinedTotals, { bold: hasPrasadActivity })}
                    ${hasPrasadActivity ? splitRow(t('retreat_report_finance_retreat_only'), retreatOnlyTotals, { indent: true }) : ''}
                    ${hasPrasadActivity ? splitRow(t('retreat_report_finance_prasad'), prasad, { indent: true }) : ''}
                    ${hasCafeActivity ? splitRow(t('retreat_report_finance_cafe'), cafe) : ''}
                    ${splitRow(t('retreat_report_finance_total'), tot, { bold: true })}
                </tbody>
            </table></div>
        </div></div>` : '';

    // Должники и аванс важны только по ретриту — в прасаде и кафе их нет (ВГ, сен 2026)
    const debtorsHtml = `${p.debtors?.length ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base">${t('fin_debtors')} <span class="badge badge-error badge-sm">${p.debtors.length}</span>
                <span class="ml-auto font-mono text-error text-base">${fmtB(p.debt_total)}</span></h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                ${p.debtors.map(x => `<tr class="cursor-pointer hover:bg-base-200" onclick="location.href='participants.html?retreat=${currentRetreat}&open=${x.participant_id}'"><td class="hover:underline">${e(x.name || '')}</td><td class="text-right font-mono text-error w-36">${fmtB(x.debt)}</td></tr>`).join('')}
            </tbody></table></div>
        </div></div>` : ''}
        ${Number(p.advance_total) > 0 ? `<div class="text-sm opacity-70">${t('fin_advance')}: ${fmtB(p.advance_total)}</div>` : ''}`;

    const unitTabs = (hasCafeActivity || hasPrasadActivity) ? `
        <div role="tablist" class="tabs tabs-boxed w-fit">
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_retreat_only')}" checked />
            <div role="tabpanel" class="tab-content pt-4 space-y-4">
                ${catTable(retreatIncomeRows, 'fin_income_by_category', 'retreat')}
                ${catTable(retreatExpenseRows, 'fin_expense_by_category', 'retreat')}
                ${debtorsHtml}
            </div>
            ${hasPrasadActivity ? `
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_prasad')}" />
            <div role="tabpanel" class="tab-content pt-4 space-y-4">
                ${catTable(r.prasad.income_by_category, 'fin_income_by_category', 'prasad')}
                ${catTable(r.prasad.expense_by_category, 'fin_expense_by_category', 'prasad')}
                <div id="prasadCostBox"></div>
            </div>` : ''}
            ${hasCafeActivity ? `
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_cafe')}" />
            <div role="tabpanel" class="tab-content pt-4 space-y-4">
                ${catTable(r.cafe.income_by_category, 'fin_income_by_category', 'cafe')}
                ${catTable(r.cafe.expense_by_category, 'fin_expense_by_category', 'cafe')}
            </div>` : ''}
        </div>` : `${catTable(r.income_by_category, 'fin_income_by_category', 'retreat')}${catTable(r.expense_by_category, 'fin_expense_by_category', 'retreat')}${debtorsHtml}`;

    box.innerHTML = `
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${kpi('', icUsers, t('fin_participants_count'), p.count, `${t('fin_charged')}: ${fmtB(p.charged)} · ${t('fin_paid')}: ${fmtB(p.paid)}`)}
            ${kpi('', icUp, t('fin_income'), `<span class="text-success">${fmtB(tot.income_base)}</span>`)}
            ${kpi('is-error', icDown, t('fin_expense'), `<span class="text-error">${fmtB(tot.expense_base)}</span>`)}
            ${kpi(Number(tot.net_base) < 0 ? 'is-error' : '', icNet, t('fin_net'), `<span class="${Number(tot.net_base) < 0 ? 'text-error' : ''}">${fmtB(tot.net_base)}</span>`)}
        </div>

        ${closureBlock(currentData)}
        ${splitTotalsTable}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div class="min-w-0 space-y-4">${unitTabs}</div>
            <div id="finDrill" class="card bg-base-100 shadow-sm lg:sticky lg:top-4 flex flex-col overflow-hidden"
                 style="max-height: calc(100vh - 2rem)">${drillHintHtml()}</div>
        </div>
    `;
    // Панель относится к юниту — при смене вкладки сбрасываем
    box.querySelectorAll('input[name="fin_unit_tabs"]').forEach(i => i.addEventListener('change', resetDrill));
    if (hasPrasadActivity) fillPrasadCost(currentRetreat, prasad);
}

// ==================== ЗАКРЫТИЕ ====================
function openClose() {
    const p = currentData.report.participants;
    document.getElementById('closeInfo').innerHTML =
        p.debt_total > 0
            ? `<span class="text-error font-medium">${t('fin_debtors')}: ${p.debtors.length} · ${fmtB(p.debt_total)}</span>`
            : `<span class="text-success">${t('fin_no_debts')}</span>`;
    document.getElementById('closeModal').showModal();
}

async function submitClose() {
    const res = await FinUtils.rpc('fin_create_closure', {
        request_id: FinUtils.newRequestId(),
        object_id: currentData.object_id
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('closeModal').close();
        await loadReport();
    }
}

function openReissue() {
    document.getElementById('reissueReason').value = '';
    document.getElementById('reissueModal').showModal();
}

async function submitReissue(ev) {
    ev.preventDefault();
    const res = await FinUtils.rpc('fin_reissue_closure', {
        request_id: FinUtils.newRequestId(),
        object_id: currentData.object_id,
        reason: document.getElementById('reissueReason').value
    });
    if (FinUtils.handleResult(res)) {
        document.getElementById('reissueModal').close();
        await loadReport();
    }
}

// ==================== PDF ====================
const FONT_URL = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf';

async function makePdf(closureId, version) {
    Layout.showNotification(t('fin_generating_pdf'), 'info');
    try {
        // snapshot берём из версии закрытия (зафиксированные числа, не живой отчёт)
        const snap = await loadClosureSnapshot(closureId);
        const blob = await renderClosurePdf(snap, version);
        const file = new File([blob], `closure-report-v${version}.pdf`, { type: 'application/pdf' });
        const attRes = await FinUtils.uploadAndAttach(file, currentData.object_id, null, 'accounting_object');
        if (!attRes?.ok) { Layout.showNotification(attRes?.error?.message || 'Ошибка вложения', 'error'); return; }
        const finRes = await FinUtils.rpc('fin_finalize_closure', {
            closure_id: closureId,
            attachment_id: attRes.result.attachment_id
        });
        if (FinUtils.handleResult(finRes, 'fin_pdf_ready')) await loadReport();
    } catch (err) {
        console.error('[PDF]', err);
        Layout.showNotification(t('fin_pdf_failed') + ': ' + err.message, 'error');
    }
}

// totals_snapshot версии закрытия (таблица deny-all — только через RPC)
async function loadClosureSnapshot(closureId) {
    const { data, error } = await Layout.db.rpc('fin_get_closure_snapshot', { p_closure: closureId });
    if (error || !data?.ok) throw new Error(data?.error?.message || error?.message || 'snapshot');
    return data.result;
}

async function renderClosurePdf(snap, version) {
    const { PDFDocument, rgb } = PDFLib;
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const fontBytes = await fetch(FONT_URL).then(r => { if (!r.ok) throw new Error('шрифт недоступен'); return r.arrayBuffer(); });
    const font = await doc.embedFont(fontBytes, { subset: true });

    let page = doc.addPage([595, 842]); // A4
    let y = 800;
    const left = 50, right = 545;
    const line = (txt, size, opts = {}) => {
        if (y < 60) { page = doc.addPage([595, 842]); y = 800; }
        page.drawText(String(txt), { x: opts.x || left, y, size, font, color: opts.color || rgb(0.1, 0.1, 0.1) });
        if (!opts.keep) y -= size + (opts.gap ?? 8);
    };
    const rightText = (txt, size, yy) => {
        const w = font.widthOfTextAtSize(String(txt), size);
        page.drawText(String(txt), { x: right - w, y: yy, size, font, color: rgb(0.1, 0.1, 0.1) });
    };
    const money = n => '₹ ' + Number(n).toLocaleString('ru-RU');

    line('Финансовый отчёт закрытия', 20, { gap: 4 });
    line(snap.object?.display_name || '', 14, { color: rgb(0.3, 0.3, 0.3), gap: 4 });
    line(`Версия ${version} · ${new Date().toLocaleDateString('ru-RU')}`, 10, { color: rgb(0.45, 0.45, 0.45), gap: 18 });

    const p = snap.participants || {};
    line('Участники', 13, { gap: 6 });
    line(`Всего: ${p.count}   Начислено: ${money(p.charged)}   Оплачено: ${money(p.paid)}`, 10, { gap: 4 });
    line(`Долги: ${money(p.debt_total)}   Авансы: ${money(p.advance_total)}`, 10, { gap: 14 });

    const section = (title, rows) => {
        if (!rows?.length) return;
        line(title, 13, { gap: 6 });
        for (const r of rows) {
            const yy = y;
            line(r.name, 10, { keep: true });
            rightText(money(r.base_total), 10, yy);
            y -= 16;
        }
        y -= 8;
    };

    // Кафе и прасад — самостоятельные единицы (см. fin-analytics.js:subtractCategoryRows):
    // в статьях ретрита их часть не показываем, у каждой — свои статьи и итог
    const cafe = snap.cafe?.totals;
    const prasad = snap.prasad?.totals;
    const hasCafeActivity = cafe && (Number(cafe.income_base) || Number(cafe.expense_base));
    const hasPrasadActivity = prasad && (Number(prasad.income_base) || Number(prasad.expense_base));
    let retreatIncomeRows = snap.income_by_category;
    let retreatExpenseRows = snap.expense_by_category;
    if (hasCafeActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, snap.cafe.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, snap.cafe.expense_by_category);
    }
    if (hasPrasadActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, snap.prasad.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, snap.prasad.expense_by_category);
    }
    const hasSplit = hasCafeActivity || hasPrasadActivity;

    section('Приходы по статьям' + (hasSplit ? ' — ретрит' : ''), retreatIncomeRows);
    section('Расходы по статьям' + (hasSplit ? ' — ретрит' : ''), retreatExpenseRows);
    if (hasPrasadActivity) {
        section('Приходы по статьям — прасад', snap.prasad.income_by_category);
        section('Расходы по статьям — прасад', snap.prasad.expense_by_category);
    }
    if (hasCafeActivity) {
        section('Приходы по статьям — кафе', snap.cafe.income_by_category);
        section('Расходы по статьям — кафе', snap.cafe.expense_by_category);
    }

    const tot = snap.totals || {};
    if (hasSplit) {
        const retreatIncome = Number(tot.income_base) - Number(cafe?.income_base || 0) - Number(prasad?.income_base || 0);
        const retreatExpense = Number(tot.expense_base) - Number(cafe?.expense_base || 0) - Number(prasad?.expense_base || 0);
        line(`Ретрит — приход: ${money(retreatIncome)}   расход: ${money(retreatExpense)}   сальдо: ${money(retreatIncome - retreatExpense)}`, 11, { gap: 4 });
        if (hasPrasadActivity) line(`Прасад — приход: ${money(prasad.income_base)}   расход: ${money(prasad.expense_base)}   сальдо: ${money(prasad.net_base)}`, 11, { gap: 4 });
        if (hasCafeActivity) line(`Кафе — приход: ${money(cafe.income_base)}   расход: ${money(cafe.expense_base)}   сальдо: ${money(cafe.net_base)}`, 11, { gap: 4 });
    }
    line(`Итого — приход: ${money(tot.income_base)}   расход: ${money(tot.expense_base)}   сальдо: ${money(tot.net_base)}`, 12, { gap: 16 });

    if (p.debtors?.length) {
        line('Должники', 13, { gap: 6 });
        for (const d of p.debtors) {
            const yy = y;
            line(d.name || '', 10, { keep: true });
            rightText(money(d.debt), 10, yy);
            y -= 16;
        }
    }

    return new Blob([await doc.save()], { type: 'application/pdf' });
}

// ==================== CSV ====================
function exportCsv() {
    if (!currentData?.exists) return;
    const r = currentData.report;
    const cafe = r.cafe?.totals;
    const prasad = r.prasad?.totals;
    const hasCafeActivity = cafe && (Number(cafe.income_base) || Number(cafe.expense_base));
    const hasPrasadActivity = prasad && (Number(prasad.income_base) || Number(prasad.expense_base));
    let retreatIncomeRows = r.income_by_category;
    let retreatExpenseRows = r.expense_by_category;
    if (hasCafeActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, r.cafe.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, r.cafe.expense_by_category);
    }
    if (hasPrasadActivity) {
        retreatIncomeRows = subtractCategoryRows(retreatIncomeRows, r.prasad.income_by_category);
        retreatExpenseRows = subtractCategoryRows(retreatExpenseRows, r.prasad.expense_by_category);
    }

    const rows = [['Юнит', 'Раздел', 'Название', 'Сумма (₹)']];
    for (const x of retreatIncomeRows || []) rows.push(['Ретрит', 'Приход', x.name, x.base_total]);
    for (const x of retreatExpenseRows || []) rows.push(['Ретрит', 'Расход', x.name, x.base_total]);
    if (hasPrasadActivity) {
        for (const x of r.prasad.income_by_category || []) rows.push(['Прасад', 'Приход', x.name, x.base_total]);
        for (const x of r.prasad.expense_by_category || []) rows.push(['Прасад', 'Расход', x.name, x.base_total]);
    }
    if (hasCafeActivity) {
        for (const x of r.cafe.income_by_category || []) rows.push(['Кафе', 'Приход', x.name, x.base_total]);
        for (const x of r.cafe.expense_by_category || []) rows.push(['Кафе', 'Расход', x.name, x.base_total]);
    }
    if (hasCafeActivity || hasPrasadActivity) {
        const retreatIncome = round2(Number(r.totals.income_base) - Number(cafe?.income_base || 0) - Number(prasad?.income_base || 0));
        const retreatExpense = round2(Number(r.totals.expense_base) - Number(cafe?.expense_base || 0) - Number(prasad?.expense_base || 0));
        rows.push(['Ретрит', 'Итог', 'Приход', retreatIncome]);
        rows.push(['Ретрит', 'Итог', 'Расход', retreatExpense]);
        rows.push(['Ретрит', 'Итог', 'Сальдо', round2(retreatIncome - retreatExpense)]);
    }
    if (hasPrasadActivity) {
        rows.push(['Прасад', 'Итог', 'Приход', prasad.income_base]);
        rows.push(['Прасад', 'Итог', 'Расход', prasad.expense_base]);
        rows.push(['Прасад', 'Итог', 'Сальдо', prasad.net_base]);
    }
    if (hasCafeActivity) {
        rows.push(['Кафе', 'Итог', 'Приход', cafe.income_base]);
        rows.push(['Кафе', 'Итог', 'Расход', cafe.expense_base]);
        rows.push(['Кафе', 'Итог', 'Сальдо', cafe.net_base]);
    }
    rows.push(['Итого', 'Итог', 'Приход', r.totals.income_base]);
    rows.push(['Итого', 'Итог', 'Расход', r.totals.expense_base]);
    rows.push(['Итого', 'Итог', 'Сальдо', r.totals.net_base]);
    for (const d of r.participants?.debtors || []) rows.push(['Ретрит', 'Долг', d.name, d.debt]);
    const csv = '﻿' + rows.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'retreat-report.csv';
    a.click();
}

// ==================== ОБЩАЯ ====================
async function loadSummary() {
    const from = document.getElementById('sumFrom').value;
    const to = document.getElementById('sumTo').value;
    if (!from || !to) return;
    const box = document.getElementById('summaryReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;
    const { data, error } = await Layout.db.rpc('fin_get_summary_report', { p_from: from, p_to: to });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }
    const s = data.result;

    const tbl = (title, rows, cols, rowAttr) => rows?.length ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base">${title}</h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                ${rows.map(r => `<tr ${rowAttr ? rowAttr(r) : ''}>${cols(r)}</tr>`).join('')}
            </tbody></table></div>
        </div></div>` : '';

    box.innerHTML =
        tbl(t('fin_by_category'), s.by_category, r =>
            `<td class="${r.category_id ? 'hover:underline' : ''}">${e(r.name)}</td><td class="opacity-60">${t(r.direction === 'in' ? 'fin_dir_in' : 'fin_dir_out')}</td><td class="text-right font-mono w-36">${fmtB(r.base_total)}</td>`,
            r => r.category_id ? `class="cursor-pointer hover:bg-base-200" onclick="location.href='dds.html?category=${r.category_id}&from=${from}&to=${to}'" title="${t('fin_open_in_dds')}"` : '') +
        tbl(t('fin_by_month'), s.by_month, r =>
            `<td>${e(r.month)}</td><td class="text-right font-mono text-success">${fmtB(r.income_base)}</td><td class="text-right font-mono text-error w-36">${fmtB(r.expense_base)}</td>`) +
        tbl(t('fin_by_object'), s.by_object, r =>
            `<td>${e(r.name)}</td><td class="text-right font-mono text-success">${fmtB(r.income_base)}</td><td class="text-right font-mono text-error w-36">${fmtB(r.expense_base)}</td>`)
        || `<div class="text-center py-8 opacity-60">${t('fin_no_operations')}</div>`;
}

// ==================== ПО ДЕПАРТАМЕНТАМ ====================
// Экономика департамента — не «доход/расход», а «получил → потратил → осталось»:
// своих доходов у них нет, деньги приходят переводом из кассы.
let deptData = null;

// Неделя — скользящие 7 дней, месяц и год — календарные:
// та же логика, что в пресетах ДДС, чтобы цифры сходились между страницами.
function deptPeriod(preset) {
    const now = new Date();
    const iso = d => DateUtils.toISO(d);
    switch (preset) {
        case 'week': {
            const с = new Date(); с.setDate(с.getDate() - 6);
            return [iso(с), FinUtils.todayISO()];
        }
        case 'month': return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), FinUtils.todayISO()];
        case 'year':  return [`${now.getFullYear()}-01-01`, FinUtils.todayISO()];
        default:      return null;   // «Выбрать» — период задаёт человек
    }
}

const DEPT_PRESET_KEY = 'fin_dept_report_preset';

function markDeptPreset(preset) {
    document.querySelectorAll('#deptPresets [data-dept-preset]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.deptPreset === preset));
    document.getElementById('deptCustomRange').classList.toggle('hidden', preset !== 'custom');
    localStorage.setItem(DEPT_PRESET_KEY, preset);
}

function applyDeptPreset(preset) {
    markDeptPreset(preset);
    if (preset === 'custom') return;   // ждём, пока выберут даты и нажмут «Показать»
    const [from, to] = deptPeriod(preset);
    document.getElementById('deptFrom').value = from;
    document.getElementById('deptTo').value = to;
    loadDepartments();
}

// Выбор департаментов живёт между сеансами: набор меняют редко,
// а переставлять галочки при каждом заходе — лишняя работа.
const DEPT_PICK_KEY = 'fin_dept_report_excluded';
let deptExcluded = new Set(JSON.parse(localStorage.getItem(DEPT_PICK_KEY) || '[]'));

function saveDeptPick() {
    localStorage.setItem(DEPT_PICK_KEY, JSON.stringify([...deptExcluded]));
}

function toggleDept(id) {
    if (deptExcluded.has(id)) deptExcluded.delete(id); else deptExcluded.add(id);
    saveDeptPick();
    renderDeptReport();
}

function pickAllDepts(включить) {
    deptExcluded = включить
        ? new Set()
        : new Set((deptData?.departments || []).map(d => d.department_id));
    saveDeptPick();
    renderDeptReport();
}

async function loadDepartments() {
    const from = document.getElementById('deptFrom').value;
    const to = document.getElementById('deptTo').value;
    if (!from || !to) return;
    const box = document.getElementById('deptReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;

    const { data, error } = await Layout.db.rpc('fin_get_department_report', { p_from: from, p_to: to });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }

    deptData = data.result;
    renderDeptReport();
}

function renderDeptReport() {
    const box = document.getElementById('deptReport');
    if (!deptData) return;

    const все = deptData.departments || [];
    // Департамент без движений и без остатка — не строка отчёта, а сноска внизу
    const сдвижениями = все.filter(d => Number(d.received) || Number(d.spent)
                                     || Number(d.passed_on) || Number(d.balance_end));
    const пустые = все.filter(d => !сдвижениями.includes(d));
    const активные = сдвижениями.filter(d => !deptExcluded.has(d.department_id));

    const шапка = deptPeriodLine(сдвижениями) + deptPicker(сдвижениями, пустые);

    if (!сдвижениями.length) {
        box.innerHTML = шапка + `<div class="text-center py-8 opacity-60">${t('fin_dept_no_movements')}</div>`;
        return;
    }
    if (!активные.length) {
        box.innerHTML = шапка + `<div class="text-center py-8 opacity-60">${t('fin_dept_none_picked')}</div>`;
        return;
    }

    // Суммируем только движения периода. Остатки не складываем: среди «департаментов»
    // есть подотчётные лица с минусом (ашрам должен им), и общая сумма ушла бы в минус,
    // хотя у настоящих департаментов деньги на руках есть.
    const итог = активные.reduce((s, d) => ({
        received: s.received + Number(d.received),
        spent: s.spent + Number(d.spent)
    }), { received: 0, spent: 0 });

    // Полоса показывает долю в общих расходах: глазу нужна пропорция, а не только число
    const maxSpent = Math.max(...активные.map(d => Number(d.spent)), 1);

    box.innerHTML = шапка + `
        <div class="fin-dept-totals">
            ${kpiBox(t('fin_dept_received'), итог.received)}
            ${kpiBox(t('fin_dept_spent'), итог.spent)}
        </div>
        <div class="card bg-base-100 shadow-sm"><div class="card-body p-0">
            <div class="fin-dept-head">
                <span>${t('fin_department')}</span>
                <span class="text-right">${t('fin_dept_received')}</span>
                <span class="text-right">${t('fin_dept_spent')}</span>
                <span class="text-right">${t('fin_dept_balance')}</span>
            </div>
            ${активные.map(d => deptRow(d, maxSpent)).join('')}
        </div></div>
        ${активные.some(d => d.name === 'Кухня') ? '<div id="deptPrasadCostBox"></div>' : ''}`;
    if (активные.some(d => d.name === 'Кухня')) fillDeptPrasadCost(deptData.from, deptData.to);
}

// Шапка отчёта: за какой период он построен и сколько департаментов в нём учтено.
// Без этого распечатанный или выгруженный отчёт не отвечает сам за себя.
function deptPeriodLine(сдвижениями) {
    const учтено = сдвижениями.filter(d => !deptExcluded.has(d.department_id)).length;
    return `<div class="fin-dept-range">
        <span class="fin-dept-range-dates">${e(DateUtils.formatRange(deptData.from, deptData.to))}</span>
        <span class="fin-dept-range-count">${t('fin_dept_included')}: ${учтено} ${t('fin_of')} ${сдвижениями.length}</span>
    </div>`;
}

function deptPicker(сдвижениями, пустые) {
    if (!сдвижениями.length) return '';
    return `<div class="fin-dept-picker">
        ${сдвижениями.map(d => {
            const вкл = !deptExcluded.has(d.department_id);
            return `<label class="fin-dept-chip ${вкл ? 'is-on' : ''}">
                <input type="checkbox" ${вкл ? 'checked' : ''}
                       onchange="FinAnalytics.toggleDept('${d.department_id}')">
                <span>${e(d.name)}</span>
            </label>`;
        }).join('')}
        <span class="fin-dept-picker-actions">
            <button class="btn btn-ghost btn-xs" onclick="FinAnalytics.pickAllDepts(true)">${t('fin_pick_all')}</button>
            <button class="btn btn-ghost btn-xs" onclick="FinAnalytics.pickAllDepts(false)">${t('fin_pick_none')}</button>
        </span>
        ${пустые.length ? `<span class="fin-dept-picker-idle">${t('fin_dept_idle')}: ${пустые.map(d => e(d.name)).join(', ')}</span>` : ''}
    </div>`;
}

function kpiBox(label, value) {
    return `<div class="fin-dept-kpi">
        <span class="fin-dept-kpi-label">${e(label)}</span>
        <span class="fin-dept-kpi-value">${fmtB(value)}</span>
    </div>`;
}

function deptRow(d, maxSpent) {
    const spent = Number(d.spent), received = Number(d.received);
    const passed = Number(d.passed_on), balance = Number(d.balance_end);
    const доля = spent > 0 ? Math.max(2, Math.round(spent / maxSpent * 100)) : 0;
    return `<div class="fin-dept-row">
        <div class="fin-dept-name">
            <span class="font-medium">${e(d.name)}</span>
            ${доля ? `<span class="fin-dept-bar"><span style="width:${доля}%"></span></span>` : ''}
            ${passed ? `<span class="fin-dept-note">${t('fin_dept_passed')}: ${fmtB(passed)}</span>` : ''}
        </div>
        <span class="fin-dept-num" data-label="${t('fin_dept_received')}">${received ? fmtB(received) : '—'}</span>
        <span class="fin-dept-num ${spent ? 'text-error' : ''}" data-label="${t('fin_dept_spent')}">${spent ? fmtB(spent) : '—'}</span>
        <span class="fin-dept-num ${balance < 0 ? 'text-error' : ''}" data-label="${t('fin_dept_balance')}">${fmtB(balance)}</span>
        ${d.by_category?.length ? `<div class="fin-dept-cats">
            ${d.by_category.map(c => `<span class="fin-dept-cat">${e(c.name)} <b>${fmtB(c.total)}</b></span>`).join('')}
        </div>` : ''}
    </div>`;
}

function exportDeptCsv() {
    if (!deptData) return;
    // Выгружаем ровно то, что на экране: снятые галочки в файл не попадают
    const header = ['Департамент', 'Получено ₹', 'Потрачено ₹', 'Передано дальше ₹', 'На руках ₹', 'Статья', 'Сумма по статье ₹'];
    const rows = [];
    (deptData.departments || [])
      .filter(d => !deptExcluded.has(d.department_id))
      .forEach(d => {
        if (!d.by_category?.length) {
            rows.push([d.name, d.received, d.spent, d.passed_on, d.balance_end, '', '']);
        } else {
            d.by_category.forEach((c, i) => rows.push([
                d.name,
                i === 0 ? d.received : '', i === 0 ? d.spent : '',
                i === 0 ? d.passed_on : '', i === 0 ? d.balance_end : '',
                c.name, c.total
            ]));
        }
    });
    const csv = '﻿' + [header, ...rows]
        .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `departments-${deptData.from}_${deptData.to}.csv`;
    a.click();
}

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_analytics', itemId: 'fin_analytics' });
    await FinUtils.loadRefs();
    await loadRetreats();

    document.querySelectorAll('[data-tab]').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('tab-active'));
            tab.classList.add('tab-active');
            document.getElementById('retreatTab').classList.toggle('hidden', tab.dataset.tab !== 'retreat');
            document.getElementById('summaryTab').classList.toggle('hidden', tab.dataset.tab !== 'summary');
            document.getElementById('deptTab').classList.toggle('hidden', tab.dataset.tab !== 'dept');
            // Первый заход на вкладку сразу показывает цифры, а не пустой экран
            if (tab.dataset.tab === 'dept' && !deptData) loadDepartments();
        }));

    document.querySelectorAll('[data-dept-preset]').forEach(btn =>
        btn.addEventListener('click', () => applyDeptPreset(btn.dataset.deptPreset)));

    document.getElementById('reissueForm').addEventListener('submit', submitReissue);
    document.getElementById('retreatReport').addEventListener('click', onReportClick);
    document.addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) FinUtils.openAttachment(att.dataset.attachmentPath);
    });

    // период по умолчанию: текущий год
    const now = new Date();
    document.getElementById('sumFrom').value = `${now.getFullYear()}-01-01`;
    document.getElementById('sumTo').value = FinUtils.todayISO();
    // Возвращаем период, с которым работали в прошлый раз; по умолчанию текущий месяц.
    // Поля дат заполняем всегда — они же стартовые значения для «Выбрать».
    const сохранённый = localStorage.getItem(DEPT_PRESET_KEY) || 'month';
    const [dFrom, dTo] = deptPeriod(сохранённый) || deptPeriod('month');
    document.getElementById('deptFrom').value = dFrom;
    document.getElementById('deptTo').value = dTo;
    markDeptPreset(сохранённый);

    const params = new URLSearchParams(window.location.search);
    const preset = params.get('retreat');
    if (preset && retreats.some(r => r.id === preset)) {
        document.getElementById('retreatSelect').value = preset;
        await selectRetreat(preset);
    }
}

window.FinAnalytics = { openClose, submitClose, openReissue, makePdf, exportCsv, loadSummary,
                        loadDepartments, exportDeptCsv, toggleDept, pickAllDepts };
init();
})();
