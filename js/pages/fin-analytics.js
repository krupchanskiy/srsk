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
        retreats.map(r => `<option value="${r.id}">${e(Layout.getName(r))}${FinUtils.retreatDatesLabel(r.start_date, r.end_date)}</option>`).join('');
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
    // полный отчёт ретрита — только финансистам; главе кухни он закрыт (там оргвзнос, проживание, долги)
    fullReportLink.classList.toggle('hidden', !canReadAllFin());
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
            <tbody>${rows.map(r => r.link ? `<tr class="cursor-pointer hover:bg-base-200 italic" onclick="location.href='${e(r.link)}'">` : `<tr class="fin-drill-row cursor-pointer hover:bg-base-200"
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
    document.querySelectorAll('.fin-drill-row.bg-base-200, .fin-cost-row.bg-base-200').forEach(x => x.classList.remove('bg-base-200'));
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

// Расшифровка статьи себестоимости прасада (правое окно): продукты — по продуктам, посуда и готовое —
// по приёмам пищи, накладные — строки расхода с долей на этот ретрит
async function openCostDrill(rowEl) {
    const panel = drillPanel();
    const st = prasadCostState;
    if (!panel || !st?.res) return;
    const { costKey: key, costName: name } = rowEl.dataset;
    const token = ++drillToken;
    document.querySelectorAll('.fin-drill-row.bg-base-200, .fin-cost-row.bg-base-200').forEach(x => x.classList.remove('bg-base-200'));
    rowEl.classList.add('bg-base-200');
    const ev = `retreat:${st.retreatId}`;
    const share = r => {   // доля ретрита в приёме пищи
        const b = r.byEvent?.[ev];
        const n = b ? KitchenCost.BUCKETS.reduce((a, k) => a + (b[k] || 0), 0) : 0;
        return { n, part: r.eaters ? n / r.eaters : 0 };
    };
    const day = d => DateUtils.formatShort(DateUtils.parseDate(d));
    const mealName = m => m === 'breakfast' ? tr('breakfast', 'Завтрак') : m === 'lunch' ? tr('lunch', 'Обед') : m;
    let rows = [];   // { title, sub, amount }
    if (key === 'food') {
        const byProd = {};
        for (const r of st.res.mealRecords || []) {
            const { part } = share(r);
            if (!part) continue;
            for (const [pid, c] of Object.entries(r.foodByProduct || {})) byProd[pid] = (byProd[pid] || 0) + c * part;
        }
        const ids = Object.keys(byProd).filter(x => x !== 'own_cook');
        const names = new Map();
        for (let i = 0; i < ids.length; i += 100) {
            const { data } = await Layout.db.from('products').select('id, name_ru').in('id', ids.slice(i, i + 100));
            (data || []).forEach(p => names.set(p.id, p.name_ru));
        }
        if (token !== drillToken) return;
        rows = Object.entries(byProd).map(([pid, v]) => ({ title: pid === 'own_cook' ? tr('fin_pu_own_cook', 'Готовил Бридж Кишор') : (names.get(pid) || '—'), amount: v }));
    } else if (key === 'dish' || key === 'ext') {
        for (const r of st.res.mealRecords || []) {
            const { n, part } = share(r);
            const v = key === 'dish' ? r.dishwarePerEater * n : r.external * part;
            if (v < 0.005) continue;
            rows.push({ title: `${day(r.date)} · ${mealName(r.meal)}`, sub: key === 'ext' ? r.externalNames.join(', ') : `${n} ${tr('cost_people_short', 'чел.')}`, amount: v, keepOrder: true });
        }
    } else {
        const cat = key.slice(4);
        for (const l of st.res.overheadLines || []) {
            const v = l.byEvent?.[ev] || 0;
            if (!v || (l.category || '') !== cat) continue;
            const who = l.category === 'payroll' ? [l.personName, l.label].filter(Boolean).join(' — ') : (l.comment || l.label);
            const period = l.occurredOn ? day(l.occurredOn) : DateUtils.formatRange(l.from, l.to);
            rows.push({ title: who, sub: `${period} · ${tr('fin_pu_full_amount', 'вся сумма')} ${fmtB(l.amount)}${l.estimate ? ` · ${tr('fin_pu_estimate', 'ориентировочно')}` : ''}`, amount: v });
        }
    }
    if (!rows[0]?.keepOrder) rows.sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((a, x) => a + x.amount, 0);
    panel.innerHTML = `
        <div class="px-4 py-3 border-b border-base-200 flex items-start justify-between gap-2 shrink-0">
            <div class="min-w-0">
                <div class="font-bold text-error">${e(name)}</div>
                <div class="text-xs opacity-60">${rows.length} · ${fmtB(total)} · ${e(tr('fin_pu_drill_hint', 'доля этого ретрита'))}</div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <a class="link link-primary text-xs" href="${COST_PAGE}?retreat=${st.retreatId}" target="_blank" rel="noopener">${e(tr('fin_prasad_cost_details', 'Подробно'))} →</a>
                <button type="button" class="btn btn-ghost btn-xs" data-drill-close>✕</button></div>
        </div>
        ${rows.length ? `<div class="overflow-y-auto min-h-0 flex-1">${rows.map(x => `<div class="px-4 py-2 border-b border-base-200 flex justify-between gap-3">
            <div class="min-w-0"><div class="text-sm break-words">${e(x.title || '—')}</div>${x.sub ? `<div class="text-xs opacity-60 break-words">${e(x.sub)}</div>` : ''}</div>
            <div class="text-right font-mono whitespace-nowrap">${fmtB(round2(x.amount))}</div></div>`).join('')}</div>`
        : `<div class="p-6 text-sm opacity-50 text-center">${t('fin_drill_empty')}</div>`}`;
    if (window.innerWidth < 1024) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onReportClick(ev) {
    if (ev.target.closest('[data-drill-close]')) { resetDrill(); return; }
    const costRow = ev.target.closest('.fin-cost-row');
    if (costRow) { openCostDrill(costRow); return; }
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

// Пока кэш переводов не обновился — русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };
const mainLocationId = () => (Layout.locations || []).find(l => l.slug === 'main')?.id;
const COST_PAGE = '../kitchen/cost.html';

// ⚠ пропуски данных — каждый ссылкой туда, где исправить (правило ВГ)
function costGaps(res, retreatId) {
    return gapsAlert(costGapItems(res, retreatId));
}
const gapsAlert = items => items.length ? `<div class="alert alert-warning text-sm items-start py-2"><div>
        <div class="font-semibold">⚠ ${e(tr('cost_q_title', 'Данные могут быть неточными'))}</div>
        <ul class="list-disc ml-5">${items.map(x => `<li>${x}</li>`).join('')}</ul></div></div>` : '';
function costGapItems(res, retreatId) {
    const w = res.warnings;
    const today = DateUtils.toISO(new Date());
    const past = w.noMenu.filter(x => x.split(' ')[0] <= today).length;
    const link = retreatId ? `${COST_PAGE}?retreat=${retreatId}` : COST_PAGE;
    const items = [];
    if (!res.pricesLoaded) items.push(`<a class="link" href="../kitchen/prices.html">${e(tr('cost_q_no_prices', 'цены ещё не внесены — продукты и посуда считаются как 0'))}</a>`);
    else if (w.missingPrices.size) items.push(`<a class="link" href="${link}">${e(tr('cost_q_some_prices', 'нет цены у продуктов'))}: ${w.missingPrices.size}</a>`);
    if (past) items.push(`<a class="link" href="${link}">${e(tr('cost_q_menu_past', 'меню не заведено на прошедшие приёмы пищи'))}: ${past}</a>`);
    if (w.noMenu.length - past) items.push(`<a class="link" href="${link}">${e(tr('cost_q_menu_future', 'меню ещё не заведено на предстоящие приёмы пищи'))}: ${w.noMenu.length - past}</a>`);
    if (w.payrollEstimated.length) items.push(`<a class="link" href="${link}">${e(tr('cost_q_payroll', 'зарплата предварительная, ещё не начислена'))}: ${w.payrollEstimated.length}</a>`);
    return items;
}

// withCharged — отчёт ретрита: «На человека» и «Начислено» (питание по статусу регистрации)
const costHead = (withCharged = false) => `<tr><th></th>
    <th class="text-right">${e(tr('cost_people', 'Людей'))}</th>
    <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
    <th class="text-right">${e(tr('cost_direct', 'Прямые'))}</th>
    <th class="text-right">${e(tr('cost_overhead', 'Накладные'))}</th>
    <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
    <th class="text-right">${e(tr('cost_per_meal', 'На приём пищи'))}</th>
    ${withCharged ? `<th class="text-right">${e(tr('cost_per_person', 'На человека'))}</th>
    <th class="text-right" title="${e(tr('fin_prasad_charged_col_hint', 'Начислено за питание (со скидками, без отмен) — по статусу регистрации; пожертвования на прасад — только в итоге сверху'))}">${e(tr('fin_prasad_charged_col', 'Начислено'))}</th>` : ''}</tr>`;
const costRow = (label, r, cls = '', sub = false, charged) => `<tr class="${cls}">
    <td class="${sub ? 'tbl-lvl-1 text-sm' : 'font-medium'}">${e(label)}</td>
    <td class="text-right">${r.people ?? '—'}</td>
    <td class="text-right">${r.pm.toLocaleString('ru-RU')}</td>
    <td class="text-right font-mono">${fmtB(r.food + r.dish + r.ext)}</td>
    <td class="text-right font-mono">${fmtB(r.ovR + r.ovG)}</td>
    <td class="text-right font-mono font-semibold">${fmtB(r.total)}</td>
    <td class="text-right font-mono">${r.pm ? fmtB(r.total / r.pm) : '—'}</td>
    ${charged !== undefined ? `<td class="text-right font-mono">${r.people ? fmtB(r.total / r.people) : '—'}</td>
    <td class="text-right font-mono">${charged === null ? '—' : fmtB(charged)}</td>` : ''}</tr>`;

// ⚠ начисления без курса — не вошли в «Начислено» (правило ВГ: о каждом пропуске)
function incomeGaps(inc, charged) {
    if (charged === null) return `<div class="alert alert-warning text-sm py-2">⚠ ${e(tr('fin_prasad_income_err', 'Не удалось получить начисления за питание — окупаемость не посчитана'))}</div>`;
    const nr = inc?.no_rate || [];
    if (!nr.length) return '';
    const by = {};
    nr.forEach(x => { by[x.currency] = (by[x.currency] || 0) + Number(x.amount); });
    return `<div class="alert alert-warning text-sm py-2">⚠ ${e(tr('fin_prasad_no_rate', 'Нет курса ретрита — начисления не вошли в «Начислено»'))}: ${nr.length} ·
        ${Object.entries(by).map(([c, a]) => `${a.toLocaleString('ru-RU')} ${e(c)}`).join(', ')} ·
        <a class="link" href="dictionaries.html">${e(tr('fin_prasad_add_rate', 'завести курс'))} →</a></div>`;
}

// Юнит «Прасад» — как Ретрит и Кафе (ВГ 29.09): приход — начислено за питание и пожертвования
// на прасад, расход по статьям — себестоимость прасада ретрита (что вошло в расчёт), не касса.
// Статьи накладных (зарплаты, гонорары, билеты, такси…) — своей долей на этот ретрит.
function prasadExpenseRows(res, sum, retreatId) {
    const ev = `retreat:${retreatId}`;
    const on = k => sum.settings.components.includes(k);
    const all = sum.rows[0];
    const by = new Map();   // ключ → { name, v }: food / dish / ext / cat:<статья>
    const add = (key, name, v) => {
        if (Math.abs(v) < 0.005) return;
        const x = by.get(key) || { key, name, v: 0 };
        x.v += v; by.set(key, x);
    };
    if (on('food')) add('food', COMPONENT_LABELS.food(), all.food);
    if (on('dish')) add('dish', COMPONENT_LABELS.dish(), all.dish);
    if (on('ext')) add('ext', COMPONENT_LABELS.ext(), all.ext);
    for (const l of res.overheadLines || []) {
        const v = l.byEvent?.[ev] || 0;
        if (!v || !on(KitchenCost.overheadComponent(l))) continue;
        const cat = l.category || '';
        add(`cat:${cat}`, cat === 'payroll' ? COMPONENT_LABELS.payroll() : (cat || COMPONENT_LABELS.household()), v);
    }
    return [...by.values()].map(x => ({ ...x, v: round2(x.v) })).sort((a, b) => b.v - a.v);
}

function prasadUnitHtml(res, sum, retreatId) {
    const inc = sum.income;
    // приход — получено (ВГ 30.09): питание оплачено + зачтено из общего, как в карточке участника
    const incRows = inc ? [inc.mealsPaid == null ? [tr('fin_pu_meals', 'Питание — начислено'), inc.meals] : [tr('fin_pu_meals_paid', 'Питание — получено'), inc.mealsPaid],
        [tr('fin_pu_donations', 'Прасад - пожертвование'), inc.donations]]
        .filter(([, v]) => Math.abs(v) > 0.005) : [];
    const expRows = prasadExpenseRows(res, sum, retreatId);
    const table = (titleKey, cls, rows, total, extra = '') => `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
        <h2 class="card-title text-base font-bold ${cls}">${t(titleKey)}</h2>
        ${rows.length ? `<div class="overflow-x-auto"><table class="table table-sm"><tbody>
            ${rows.map(([name, v]) => `<tr><td>${e(name)}</td><td class="text-right font-mono w-36">${fmtB(v)}</td></tr>`).join('')}
            <tr class="font-semibold border-t-2 border-base-300"><td>${e(tr('cost_total', 'Всего'))}</td><td class="text-right font-mono">${total === null ? '—' : fmtB(total)}</td></tr>
        </tbody></table></div>` : `<div class="text-sm opacity-60">${e(t('fin_drill_empty'))}</div>`}${extra}
    </div></div>`;
    const debt = inc?.mealsDebt > 0.5 ? `<div class="text-xs text-warning mt-2">${e(tr('fin_pu_meals_debt', 'Ещё не получено за питание (долги участников)'))}: ${fmtB(inc.mealsDebt)}</div>` : '';
    return table('fin_income_by_category', 'text-success', incRows, inc?.received ?? inc?.charged ?? null, debt)
        + `<div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base font-bold text-error">${t('fin_expense_by_category')}</h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                <tr class="font-semibold bg-base-200/60"><td>${e(tr('fin_pu_cost', 'Себестоимость прасада'))}${sum.provisional ? ` <span class="badge badge-warning badge-sm" title="${e(t('fin_prasad_cost_prov_hint'))}">${e(tr('cost_provisional', 'предварительно'))}</span>` : ''}</td>
                    <td class="text-right font-mono w-36">${fmtB(sum.included)}</td></tr>
                ${expRows.map(x => `<tr class="fin-cost-row cursor-pointer hover:bg-base-200" data-cost-key="${e(x.key)}" data-cost-name="${e(x.name)}">
                    <td class="tbl-lvl-1">${e(x.name)}</td><td class="text-right font-mono">${fmtB(x.v)}</td></tr>`).join('')}
            </tbody></table></div>
            <div class="text-xs opacity-60 mt-1">${e(tr('fin_pu_click', 'Нажмите на статью — расшифровка откроется справа'))}</div>
        </div></div>`
        + `<p class="text-xs opacity-60">${e(tr('fin_pu_note', 'Расход — себестоимость прасада ретрита: продукты по меню, посуда, готовое, и своей долей зарплаты кухни, оборудование, коммунальные, хозтовары, расходы кухни на ретрит. Всё со счёта Кухни входит сюда, а не в «Ретрит».'))}
            <a class="link" href="${COST_PAGE}?retreat=${retreatId}">${e(tr('fin_prasad_cost_details', 'Подробно'))} →</a></p>`;
}

// Касса прасада (ДДС: питание и пожертвования, траты со счёта Кухни) — для сверки, свёрнуто
function prasadCashDetails(pr) {
    if (!pr?.income_by_category?.length && !pr?.expense_by_category?.length) return '';
    return `<details class="space-y-4"><summary class="cursor-pointer text-sm opacity-80">${e(tr('fin_pu_cash', 'По кассе (ДДС) — для сверки'))}:
            ${e(tr('fin_prasad_received', 'Получено'))} ${fmtB(pr.totals?.income_base || 0)} · ${e(tr('fin_pu_spent', 'потрачено со счёта Кухни'))} ${fmtB(pr.totals?.expense_base || 0)}</summary>
        <div class="space-y-4 mt-2">${catTable(pr.income_by_category, 'fin_income_by_category', 'prasad')}${catTable(pr.expense_by_category, 'fin_expense_by_category', 'prasad')}</div></details>`;
}

// Сводка «Ретрит / Прасад / Кафе»: строка прасада и итог — когда посчитана себестоимость
let unitsState = null;
function fillUnitsTable(charged, included) {
    const row = document.getElementById('prasadSplitRow');
    const totalRow = document.getElementById('unitsTotalRow');
    if (!row) return;
    const cells = (inc, exp, net) => `<td class="text-right font-mono text-success">${inc === null ? '—' : fmtB(inc)}</td>
        <td class="text-right font-mono text-error">${fmtB(exp)}</td>
        <td class="text-right font-mono ${net < 0 ? 'text-error' : 'text-success'}">${fmtB(net)}</td>`;
    const pNet = round2((charged ?? 0) - included);
    row.innerHTML = `<td>${t('retreat_report_finance_prasad')}</td>${cells(charged, included, pNet)}`;
    if (!totalRow || !unitsState) return;
    const { retreat: r, cafe: c } = unitsState;
    totalRow.innerHTML = `<td>${t('retreat_report_finance_total')}</td>${cells(
        round2(Number(r.income_base) + (charged ?? 0) + Number(c.income_base)),
        round2(Number(r.expense_base) + included + Number(c.expense_base)),
        round2(Number(r.net_base) + pNet + Number(c.net_base)))}`;
}

// Отчёт по департаментам («Кухня»): расчётная себестоимость за период с разбивкой —
// ретриты (своей долей по дням), команда, волонтёры, гости и группы без события
const NONE_ROWS = [
    ['team', ['team'], () => tr('status_team', 'Команда')],
    ['volunteers', ['volunteers'], () => tr('category_volunteer', 'Волонтёры')],
    ['guests', ['guests', 'vips'], () => tr('cost_guests_no_event', 'Гости без события')],
    ['groups', ['groups'], () => tr('cost_groups_no_event', 'Группы без события')],
    ['expected', ['expected'], () => tr('expected_guests', 'Ожидаются')]
];
function cellsRow(cells, ev, buckets) {
    const a = { pm: 0, food: 0, dish: 0, ext: 0, ovR: 0, ovG: 0, people: null };
    for (const b of buckets) {
        const c = cells?.[ev]?.[b];
        if (!c) continue;
        a.pm += c.personMeals; a.food += c.food; a.dish += c.dishware; a.ext += c.external; a.ovR += c.overheadRetreat; a.ovG += c.overheadGeneral;
    }
    a.total = a.food + a.dish + a.ext + a.ovR + a.ovG;
    return a;
}

async function fillDeptPrasadCost(from, to) {
    const box = document.getElementById('deptPrasadCostBox');
    if (!box || typeof KitchenCost === 'undefined') return;
    try {
        if (!await canViewKitchenCost()) return;
        const locationId = mainLocationId();
        if (!locationId) return;
        box.innerHTML = `<div class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></div>`;
        const res = await KitchenCost.calculate(Layout.db, locationId, from, to);
        if (!document.getElementById('deptPrasadCostBox')) return;
        const B = KitchenCost.BUCKETS;
        const rows = Object.keys(res.cells).filter(k => k.startsWith('retreat:')).map(ev => {
            const r = retreats.find(x => x.id === ev.slice(8));
            return { label: r ? Layout.getName(r) : '—', r: cellsRow(res.cells, ev, B) };
        }).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        for (const [, buckets, label] of NONE_ROWS) {
            const r = cellsRow(res.cells, 'none', buckets);
            if (r.pm) rows.push({ label: label(), r, none: true });
        }
        const sum = rows.reduce((a, x) => { ['pm', 'food', 'dish', 'ext', 'ovR', 'ovG', 'total'].forEach(k => a[k] += x.r[k]); return a; },
            { pm: 0, food: 0, dish: 0, ext: 0, ovR: 0, ovG: 0, total: 0, people: null });
        box.innerHTML = `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4 space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
                <h2 class="card-title text-base">${e(tr('fin_prasad_cost_title', 'Себестоимость прасада — расчёт по меню'))} · ${e(DateUtils.formatRange(from, to))}</h2>
                ${res.totals.provisional ? `<span class="badge badge-warning badge-sm" title="${e(t('fin_prasad_cost_prov_hint'))}">${e(tr('cost_provisional', 'предварительно'))}</span>` : ''}
                <a class="link link-primary text-sm ml-auto" href="${COST_PAGE}">${e(tr('fin_prasad_cost_details', 'Подробно'))} →</a>
            </div>
            ${costGaps(res)}
            <div class="overflow-x-auto"><table class="table table-sm">
                <thead>${costHead()}</thead>
                <tbody>${rows.map(x => costRow(x.label, x.r)).join('')}
                    ${rows.length > 1 ? costRow(tr('cost_grand_total', 'Итого за период'), sum, 'border-t-2 border-base-300 font-semibold') : ''}</tbody>
            </table></div>
            <p class="text-xs opacity-60">${e(tr('fin_prasad_cost_dept_note', 'Ретрит, захватывающий несколько месяцев, входит в период своей долей по дням. Команда, волонтёры, гости и группы без события — дни, когда человек ел не по ретриту. Это расчёт по меню и подсчёту вкушающих, не деньги: реальные деньги — в строке «Кухня» выше.'))}</p>
        </div></div>`;
    } catch (err) {
        console.error('Dept prasad cost:', err);
        box.innerHTML = '';
    }
}

// ---- Состав себестоимости и «внутренний ретрит» (ВГ 27.09) ----
// Обычный ретрит — полная себестоимость. Внутренний — в стоимость ретрита входят только
// отмеченные составляющие (fin_prasad_settings; меняет администратор финансов).
let prasadCostState = null;
const COMPONENT_LABELS = {
    food: () => tr('fin_pc_food', 'Продукты (по меню + Бридж Кишор)'),
    dish: () => tr('fin_pc_dish', 'Одноразовая посуда'),
    ext: () => tr('fin_pc_ext', 'Готовое со стороны'),
    payroll: () => tr('fin_pc_payroll', 'Зарплаты кухни'),
    equipment: () => tr('fin_pc_equipment', 'Оборудование и инвентарь'),
    utilities: () => tr('fin_pc_utilities', 'Электричество, вода, газ'),
    household: () => tr('fin_pc_household', 'Хозтовары и прочее'),
    retreat: () => tr('fin_pc_retreat', 'Расходы на ретрит (гонорары, билеты, такси, «Программа»)')
};

// включённое по настройке → в сохраняемый расчёт (он же уходит в снимок закрытия)
function applyPrasadSettings() {
    KitchenCost.applySettings(prasadCostState.sum, prasadCostState.settings);
}

function componentsPanel() {
    const { sum, settings } = prasadCostState;
    const admin = window.hasPermission?.('fin_admin');
    const internal = !!settings.is_internal;
    const on = k => !internal || (settings.components || []).includes(k);
    const rows = KitchenCost.COMPONENTS.map(k => `<tr class="${on(k) ? '' : 'opacity-40'}">
        <td>${internal ? `<label class="flex items-center gap-2 ${admin ? 'cursor-pointer' : ''}"><input type="checkbox" class="checkbox checkbox-xs" data-prasad-comp="${k}" ${on(k) ? 'checked' : ''} ${admin ? '' : 'disabled'}>${e(COMPONENT_LABELS[k]())}</label>` : e(COMPONENT_LABELS[k]())}
            ${on(k) ? '' : ` <span class="text-xs">(${e(tr('fin_pc_excluded', 'не входит'))})</span>`}</td>
        <td class="text-right font-mono">${fmtB(sum.components[k])}</td></tr>`).join('');
    return `<div class="border border-base-300 rounded-xl p-3 space-y-2">
        <div class="flex items-center gap-3 flex-wrap">
            <div class="text-sm font-medium">${e(tr('fin_pc_title', 'Состав себестоимости'))}</div>
            <label class="flex items-center gap-2 ml-auto text-sm ${admin ? 'cursor-pointer' : ''}" title="${e(tr('fin_pc_internal_hint', 'Внутренний ретрит: в его стоимость входят только отмеченные составляющие. Ничего не отмечено — питание в стоимость ретрита не входит.'))}">
                <input type="checkbox" class="toggle toggle-sm toggle-success" data-prasad-internal ${internal ? 'checked' : ''} ${admin ? '' : 'disabled'}>
                ${e(tr('fin_pc_internal', 'Внутренний ретрит'))}
                <span class="badge badge-sm ${internal ? 'badge-success' : 'badge-ghost'}">${e(internal ? tr('fin_pc_internal_on', 'включён') : tr('fin_pc_internal_off', 'выключен'))}</span></label>
        </div>
        <table class="table table-xs"><tbody>${rows}
            <tr class="font-semibold border-t-2 border-base-300"><td>${e(internal ? tr('fin_prasad_included', 'Входит в стоимость ретрита') : tr('cost_total', 'Всего'))}</td>
                <td class="text-right font-mono">${fmtB(sum.included)}</td></tr></tbody></table>
        ${internal && !sum.settings.components.length ? `<div class="text-xs text-warning">⚠ ${e(tr('fin_pc_nothing', 'Ничего не отмечено — питание в стоимость ретрита не входит'))}</div>` : ''}
    </div>`;
}

async function onPrasadSettingChange(input) {
    if (!prasadCostState || !window.hasPermission?.('fin_admin')) return;
    const st = prasadCostState.settings;
    if (input.hasAttribute('data-prasad-internal')) {
        st.is_internal = input.checked;
        if (st.is_internal) st.components = [...KitchenCost.COMPONENTS];   // при включении отмечено всё (решение ВГ)
    } else {
        const k = input.dataset.prasadComp;
        const set = new Set(st.components || []);
        if (input.checked) set.add(k); else set.delete(k);
        st.components = KitchenCost.COMPONENTS.filter(x => set.has(x));
    }
    const { error } = await Layout.db.rpc('fin_set_prasad_settings', { p_retreat: prasadCostState.retreatId, p_is_internal: st.is_internal, p_components: st.components });
    if (error) { Layout.handleError(error, 'Прасад'); return; }
    fillPrasadCost(prasadCostState.retreatId, prasadCostState.prasadTotals, prasadCostState.retreatOnly);
}

// Отчёт по ретриту → «Прасад» по ТЗ 3.7: приход (начислено и получено) против себестоимости по расчёту,
// окупаемость по начисленному. Расчёт сохраняется в Финансы (fin_prasad_cost) и фиксируется при закрытии.
// retreatOnly — собственные приход/расход ретрита (без прасада и кафе); у главы кухни его нет.
async function fillPrasadCost(retreatId, prasadTotals, retreatOnly = null) {
    const box = document.getElementById('prasadCostBox');
    if (!box || typeof KitchenCost === 'undefined') return;
    const token = ++prasadCostToken;
    try {
        if (!await canViewKitchenCost()) return;
        const retreat = retreats.find(x => x.id === retreatId);
        const locationId = mainLocationId();
        if (!retreat?.start_date || !retreat?.end_date || !locationId) return;

        box.innerHTML = `<div class="text-center py-4"><span class="loading loading-spinner loading-sm"></span></div>`;
        const span = await KitchenCost.retreatSpan(retreat);
        const [res, detail, inc] = await Promise.all([
            KitchenCost.calculate(Layout.db, locationId, span.from, span.to),
            KitchenCost.loadDetail(Layout.db, span.from, span.to),
            KitchenCost.loadIncome(Layout.db, retreatId)
        ]);
        if (token !== prasadCostToken) return;
        const sum = KitchenCost.summarizeRetreat(res, detail, retreatId, span);
        const { data: settings } = await Layout.db.rpc('fin_get_prasad_settings', { p_retreat: retreatId });
        if (token !== prasadCostToken) return;
        prasadCostState = { retreatId, sum, res, settings: settings || { is_internal: false, components: KitchenCost.COMPONENTS }, prasadTotals, retreatOnly };
        applyPrasadSettings();
        sum.income = KitchenCost.incomeSummary(inc);
        KitchenCost.saveRetreatCost(Layout.db, retreatId, sum);
        renderMovement(retreat, span, detail, token);

        const all = sum.rows[0];
        const received = Number(prasadTotals?.income_base || 0);
        const charged = sum.income?.charged ?? null;
        const expenseDds = Number(prasadTotals?.expense_base || 0);
        const result = (charged ?? 0) - sum.included;
        const payback = sum.included > 0 && charged !== null ? Math.round(charged / sum.included * 100) : null;
        const LABELS = { all: Layout.getName(retreat), participants: tr('cost_row_participants', 'Участники'),
            guests: tr('cost_row_guests', 'Гости'), vips: tr('cost_row_vips', 'ВИП'),
            team: tr('cost_row_team_retreat', 'Команда ретрита'), volunteers: tr('cost_row_vol_retreat', 'Волонтёры ретрита'), groups: tr('nav_groups', 'Группы') };
        // начислено за питание по статусу регистрации → строки таблицы
        const bs = sum.income?.byStatus || {};
        const st = (...k) => k.reduce((a, x) => a + Number(bs[x] || 0), 0);
        const chargedByRow = { all: sum.income?.meals, participants: st('guest', 'vip', 'none'), guests: st('guest', 'none'),
            vips: st('vip'), team: st('team'), volunteers: st('volunteer'), groups: null };
        const noRate = inc?.no_rate || [];
        const today = DateUtils.toISO(new Date());
        const status = today > span.to ? tr('cost_status_done', 'завершён — данные окончательные')
            : `${tr('cost_status_forecast', 'прогноз по броням')} ${tr('cost_status_forecast_from', 'с')} ${DateUtils.formatShort(DateUtils.parseDate(today))}`;
        const actual = span.from !== retreat.start_date || span.to !== retreat.end_date
            ? ` · ${tr('cost_actual_dates', 'фактически')} ${DateUtils.formatRange(span.from, span.to)} (${tr('cost_actual_dates_hint', 'первый заезд — последний выезд по броням')})` : '';
        const noPrices = !sum.pricesLoaded;
        const kv = (label, value, cls = '', sub = '') => `<div class="bg-base-200/60 rounded-xl p-3">
            <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
            <div class="text-xl font-bold mt-1 ${cls}">${value}</div>${sub ? `<div class="text-xs opacity-60 mt-1">${sub}</div>` : ''}</div>`;

        box.innerHTML = `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4 space-y-3">
            <div class="flex items-center gap-2 flex-wrap">
                <h2 class="card-title text-base">${e(tr('fin_prasad_cost_title', 'Себестоимость прасада — расчёт по меню'))}</h2>
                ${sum.provisional ? `<span class="badge badge-warning badge-sm" title="${e(t('fin_prasad_cost_prov_hint'))}">${e(tr('cost_provisional', 'предварительно'))}</span>` : ''}
                <a class="link link-primary text-sm ml-auto" href="${COST_PAGE}?retreat=${retreatId}">${e(tr('fin_prasad_cost_details', 'Подробно'))} →</a>
            </div>
            <div class="text-xs opacity-60">${e(tr('fin_official_dates', 'официально'))} ${e(DateUtils.formatRange(retreat.start_date, retreat.end_date))}${e(actual)} · ${e(status)}</div>
            ${costGaps(res, retreatId)}
            ${incomeGaps(inc, charged)}
            <div class="grid grid-cols-2 gap-2">
                ${kv(tr('fin_prasad_charged', 'Начислено за прасад'), charged === null ? '—' : fmtB(charged), '',
                    charged === null ? '' : `${e(tr('fin_prasad_meals', 'питание'))} ${fmtB(sum.income.meals)}${sum.income.discount ? ` (${e(tr('fin_prasad_after_disc', 'со скидками'))} −${fmtB(sum.income.discount)})` : ''}${sum.income.donations ? ` + ${e(tr('fin_prasad_donations', 'пожертвования'))} ${fmtB(sum.income.donations)}${Number(inc?.donations_auto_n) ? ` (${e(tr('cost_donations_auto_short', 'не отмечены, по дате ретрита'))}: ${inc.donations_auto_n} · ${fmtB(inc.donations_auto)})` : ''}` : ''}${Number(inc?.cancelled) ? ` · ${e(tr('fin_prasad_cancelled', 'отменённые не входят'))}: ${inc.cancelled}` : ''}`)}
                ${kv(tr('fin_prasad_received', 'Получено'), `<span class="text-blue-600">${fmtB(received)}</span>`, '',
                    charged !== null && charged - received > 0.5 ? `${e(tr('fin_prasad_not_received', 'ещё не получено'))} ${fmtB(charged - received)}` : e(tr('cost_cash_in_hint', 'оплаты участников, по Финансам')))}
                ${kv(sum.settings.is_internal ? tr('fin_prasad_included', 'Входит в стоимость ретрита') : tr('cost_total', 'Себестоимость'), fmtB(sum.included), '',
                    `${e(tr('cost_per_participant', 'На участника'))}: ${sum.includedPerParticipant !== null ? fmtB(sum.includedPerParticipant) : '—'}${sum.settings.is_internal ? ` · ${e(tr('fin_prasad_full', 'полная'))} ${fmtB(all.total)}` : ''}`)}
                ${kv(tr('fin_prasad_payback', 'Окупаемость'), noPrices || payback === null ? '—' : `${payback}%`, noPrices ? '' : result < 0 ? 'text-error' : 'text-success',
                    noPrices ? `⚠ <a class="link" href="../kitchen/prices.html">${e(tr('cost_result_after_prices', 'появится после внесения цен'))} →</a>`
                        : `${e(tr('fin_prasad_result', 'начислено − себестоимость'))}: <span class="${result < 0 ? 'text-error' : 'text-success'}">${fmtB(result)}</span>`)}
            </div>
            ${componentsPanel()}
            <div class="text-sm font-medium opacity-70">${e(tr('fin_prasad_by_people', 'Полная себестоимость по людям'))}</div>
            <div class="overflow-x-auto"><table class="table table-sm">
                <thead>${costHead(true)}</thead>
                <tbody>${sum.rows.map((r, i) => costRow(LABELS[r.key] || r.key, r, i === 0 ? 'bg-base-200/60' : '', i > 0, chargedByRow[r.key] ?? null)).join('')}</tbody>
            </table></div>
            <p class="text-xs opacity-60">${e(tr('fin_prasad_cost_note3', 'Себестоимость — расчёт по меню и подсчёту вкушающих, включая ранний заезд и поздний выезд; «На участника» — без команды и волонтёров. Окупаемость — по начисленному (питание со скидками, без отмен, плюс пожертвования на прасад), полученное — рядом. Сохраняется в Финансы и фиксируется при закрытии ретрита. Деньги не двигает.'))}
                ${expenseDds ? ` ${e(tr('fin_prasad_cost_dds', 'Потрачено из кассы на прасад ретрита (ДДС)'))}: ${fmtB(expenseDds)} — ${e(tr('fin_prasad_dds_ref', 'для сверки с расчётом'))}.` : ''}</p>
        </div></div>`;

        const unitBox = document.getElementById('prasadUnitBox');
        if (unitBox) unitBox.innerHTML = prasadUnitHtml(res, sum, retreatId);
        fillUnitsTable(sum.income?.received ?? charged, sum.included);

        // Управленческая часть наверху отчёта (ВГ 28.09): ⚠ пропуски, стоимость на участника
        if (retreatOnly) {
            const donAuto = Number(inc?.donations_auto_n) ? [`<a class="link" href="${await donationsLink(retreat)}">${e(tr('fin_gap_don_auto', 'пожертвования на прасад без ретрита — отнесены к ретриту по дате, проверьте'))}: ${inc.donations_auto_n} · ${fmtB(inc.donations_auto)}</a>`] : [];
            if (token !== prasadCostToken) return;
            const nr = inc?.no_rate || [];
            reportGaps.cost = [...costGapItems(res, retreatId),
                ...(charged === null ? [e(tr('fin_prasad_income_err', 'Не удалось получить начисления за питание — окупаемость не посчитана'))] : []),
                ...(nr.length ? [`<a class="link" href="dictionaries.html">${e(tr('fin_prasad_no_rate', 'Нет курса ретрита — начисления не вошли в «Начислено»'))}: ${nr.length}</a>`] : []),
                ...donAuto];
            renderReportGaps();
            const money = await moneyPromise;
            if (token !== prasadCostToken) return;
            renderPerParticipant(money, sum, Number(retreatOnly.expense_base), noPrices);
        }
    } catch (err) {
        console.error('Prasad cost:', err);
        if (token === prasadCostToken) box.innerHTML = '';
    }
}

// ==================== ДВИЖЕНИЕ УЧАСТНИКОВ ПО ДНЯМ ====================
// Решение ВГ 25.09: сколько человек ретрита в день, заезды/выезды, пик, официальные и фактические даты.
// Источник — тот же eating_detail, что у себестоимости: человек «на ретрите» в день, когда ел по ретриту.
// Заезд — первый день подряд, выезд — последний (уехал и вернулся — два заезда).
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
let chartLib = null;
let moveChart = null;
function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (!chartLib) chartLib = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = CHART_JS; sc.onload = () => res(window.Chart); sc.onerror = () => { chartLib = null; rej(); };
        document.head.appendChild(sc);
    });
    return chartLib;
}
const isoShift = (iso, n) => { const d = DateUtils.parseDate(iso); d.setDate(d.getDate() + n); return DateUtils.toISO(d); };
const MOVE_CATS = [
    ['part', ['guests', 'vips', 'expected'], '#8b5cf6', () => tr('cost_row_participants', 'Участники')],
    ['team', ['team'], '#10b981', () => tr('cost_row_team_retreat', 'Команда ретрита')],
    ['volunteers', ['volunteers'], '#f59e0b', () => tr('cost_row_vol_retreat', 'Волонтёры ретрита')],
    ['groups', ['groups'], '#3b82f6', () => tr('nav_groups', 'Группы')]
];

// пунктир дат (начало/конец ретрита, «сегодня») — свой маленький плагин, без annotation
function dashMarks(days, marks) {
    const on = marks.filter(([d]) => days.includes(d));
    return { id: 'dashMarks', afterDatasetsDraw(c) {
        const { ctx, chartArea: a, scales: { x } } = c;
        ctx.save(); ctx.setLineDash([4, 4]); ctx.font = '11px sans-serif';
        for (const [d, color, label] of on) {
            const px = x.getPixelForValue(days.indexOf(d));
            ctx.strokeStyle = color; ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
            ctx.fillText(label, px + 3, a.top + 10);
        }
        ctx.restore();
    } };
}

function movementData(retreatId, span, detail) {
    const days = [];
    for (let d = span.from; d <= span.to; d = isoShift(d, 1)) days.push(d);
    const present = new Map();   // человек/группа → Map(день → {n, cat})
    for (const x of detail) {
        if (x.retreat_id !== retreatId || !(x.breakfast || x.lunch)) continue;
        const cat = MOVE_CATS.find(c => c[1].includes(x.bucket))?.[0];
        if (!cat) continue;
        const key = x.kind === 'group' ? 'g:' + x.ref_id : (x.vaishnava_id || x.ref_id);
        if (!present.has(key)) present.set(key, { id: x.vaishnava_id, group: x.kind === 'group', days: new Map() });
        present.get(key).days.set(x.d, { n: x.kind === 'group' ? (Number(x.people) || 1) : 1, cat });
    }
    const byDay = new Map(days.map(d => [d, { cats: {}, total: 0, inN: 0, outN: 0, inIds: [], outIds: [] }]));
    for (const p of present.values()) {
        for (const [d, v] of p.days) {
            const b = byDay.get(d);
            if (!b) continue;
            b.cats[v.cat] = (b.cats[v.cat] || 0) + v.n;
            b.total += v.n;
            if (!p.days.has(isoShift(d, -1))) { b.inN += v.n; b.inIds.push(p); }
            if (!p.days.has(isoShift(d, 1))) { b.outN += v.n; b.outIds.push(p); }
        }
    }
    let peak = null;
    for (const [d, b] of byDay) if (!peak || b.total > peak.total) peak = { d, total: b.total };
    const people = [...present.values()].reduce((a, p) => a + Math.max(...[...p.days.values()].map(v => v.n)), 0);
    return { days, byDay, peak, people, present };
}

async function renderMovement(retreat, span, detail, token) {
    const box = document.getElementById('retreatMoveBox');
    if (!box) return;
    const m = movementData(retreat.id, span, detail);
    if (!m.people) { box.innerHTML = ''; return; }
    const today = DateUtils.toISO(new Date());
    const short = d => DateUtils.formatShort(d).replace(/ \d{4}$/, '');
    const avg = Math.round(m.days.reduce((a, d) => a + m.byDay.get(d).total, 0) / m.days.length);
    const official = `${e(tr('fin_official_dates', 'официально'))} ${e(DateUtils.formatRange(retreat.start_date, retreat.end_date))}`;
    const actual = span.from !== retreat.start_date || span.to !== retreat.end_date
        ? ` · ${e(tr('cost_actual_dates', 'фактически'))} ${e(DateUtils.formatRange(span.from, span.to))}` : '';
    box.innerHTML = `
    <div class="card bg-base-100 shadow-sm"><div class="card-body py-4 space-y-2">
        <div class="flex items-center gap-2 flex-wrap">
            <h2 class="card-title text-base">${e(tr('fin_move_title', 'Движение участников по дням'))}</h2>
            <span class="text-xs opacity-60">${official}${actual}${today >= span.from && today <= span.to ? ` · ${e(tr('fin_move_future', 'после сегодня — по броням'))}` : ''}</span>
        </div>
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>${e(tr('fin_move_people', 'Всего людей'))}: <b>${m.people}</b></span>
            <span>${e(tr('fin_move_peak', 'Пик'))}: <b>${m.peak.total}</b> — ${e(short(m.peak.d))}</span>
            <span>${e(tr('fin_move_avg', 'В среднем в день'))}: <b>${avg}</b></span>
        </div>
        <div class="relative h-72"><canvas id="moveChart"></canvas></div>
        <p class="text-xs opacity-60">${e(tr('fin_move_hint', 'Столбцы — сколько человек ретрита ели в этот день; линии — заезды и выезды за день. Пунктир — официальные даты начала и конца. Считается по подсчёту вкушающих (брони и отметки заезда), как себестоимость.'))}</p>
        <details class="text-sm" data-move-days><summary class="cursor-pointer opacity-80">${e(tr('fin_move_by_day', 'По дням — кто заехал и уехал'))}</summary>
            <div class="overflow-x-auto mt-2" data-move-table><span class="loading loading-spinner loading-sm"></span></div></details>
    </div></div>`;
    box.querySelector('[data-move-days]').addEventListener('toggle', ev => { if (ev.target.open) fillMoveTable(box, m, short); }, { once: true });

    let Chart;
    try { Chart = await loadChartLib(); } catch { box.querySelector('canvas').replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') })); return; }
    if (token !== prasadCostToken || !document.getElementById('moveChart')) return;
    if (moveChart) moveChart.destroy();
    const markPlugin = dashMarks(m.days, [[retreat.start_date, '#6b7280', tr('fin_move_start', 'начало')], [retreat.end_date, '#6b7280', tr('fin_move_end', 'конец')],
                   [today, '#ef4444', tr('today', 'сегодня')]]);
    const cats = MOVE_CATS.filter(([k]) => m.days.some(d => m.byDay.get(d).cats[k]));
    moveChart = new Chart(document.getElementById('moveChart'), {
        type: 'bar',
        data: { labels: m.days.map(short), datasets: [
            ...cats.map(([k, , color, label]) => ({ label: label(), data: m.days.map(d => m.byDay.get(d).cats[k] || 0), backgroundColor: color, stack: 's', order: 2 })),
            { type: 'line', label: tr('fin_move_in', 'Заехали'), data: m.days.map(d => m.byDay.get(d).inN), borderColor: '#16a34a', backgroundColor: '#16a34a', pointRadius: 2, borderWidth: 2, order: 1, stack: 'in' },
            { type: 'line', label: tr('fin_move_out', 'Уехали'), data: m.days.map(d => m.byDay.get(d).outN), borderColor: '#dc2626', backgroundColor: '#dc2626', pointRadius: 2, borderWidth: 2, order: 1, stack: 'out' }
        ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
                tooltip: { callbacks: { footer: items => `${tr('cost_total', 'Всего')}: ${m.byDay.get(m.days[items[0].dataIndex]).total}` } } },
            scales: { x: { stacked: true, ticks: { maxTicksLimit: 16 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } },
        plugins: [markPlugin]
    });
}

// Раскрытие «по дням» — имена заехавших и уехавших (грузим один раз, когда открыли)
async function fillMoveTable(box, m, short) {
    const cell = box.querySelector('[data-move-table]');
    const ids = [...new Set([...m.present.values()].filter(p => !p.group && p.id).map(p => p.id))];
    const names = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const { data } = await Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name').in('id', ids.slice(i, i + 100));
        (data || []).forEach(v => names.set(v.id, v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim()));
    }
    const who = list => list.map(p => p.group ? tr('nav_groups', 'Группа') : (names.get(p.id) || '—')).sort((a, b) => a.localeCompare(b, 'ru')).map(e).join(', ');
    const rows = m.days.map(d => {
        const b = m.byDay.get(d);
        return `<tr class="${d === m.peak.d ? 'font-semibold' : ''}">
            <td class="whitespace-nowrap">${e(short(d))}</td><td class="text-right">${b.total}</td>
            <td class="text-right text-success">${b.inN ? '+' + b.inN : ''}</td><td class="text-right text-error">${b.outN ? '−' + b.outN : ''}</td>
            <td class="text-xs">${b.inN ? `<span class="text-success">${who(b.inIds)}</span>` : ''}${b.inN && b.outN ? '<br>' : ''}${b.outN ? `<span class="text-error">${who(b.outIds)}</span>` : ''}</td></tr>`;
    }).join('');
    cell.innerHTML = `<table class="table table-xs"><thead><tr><th>${e(tr('date', 'Дата'))}</th><th class="text-right">${e(tr('fin_move_on', 'Ели'))}</th>
        <th class="text-right">${e(tr('fin_move_in', 'Заехали'))}</th><th class="text-right">${e(tr('fin_move_out', 'Уехали'))}</th><th>${e(tr('fin_move_names', 'Кто'))}</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
}

// ==================== УПРАВЛЕНЧЕСКАЯ ЧАСТЬ ОТЧЁТА (ВГ 28.09) ====================
// Одна плашка ⚠ наверху: пропуски расчёта прасада (cost) и денег участников (money)
let reportGaps = { cost: [], money: [] };
let moneyPromise = Promise.resolve(null);   // fin_retreat_money_by_day текущего ретрита
let moneyChart = null;
let reportToken = 0;

function renderReportGaps() {
    const box = document.getElementById('retreatGapsBox');
    if (box) box.innerHTML = gapsAlert([...reportGaps.money, ...reportGaps.cost]);
}

// ДДС: пожертвования на прасад в официальные даты ретрита (там видно, какие без ретрита)
let donationCategoryId;
async function donationsLink(retreat) {
    if (donationCategoryId === undefined) {
        const { data } = await Layout.db.from('fin_v_categories').select('id').eq('name', 'Прасад - пожертвование').limit(1);
        donationCategoryId = data?.[0]?.id || null;
    }
    return `dds.html?${donationCategoryId ? `category=${donationCategoryId}&` : ''}from=${retreat.start_date}&to=${retreat.end_date}`;
}

const personLink = (p, extra = '') => `<a class="link" href="participants.html?retreat=${currentRetreat}&open=${p.id}">${e(p.name || '—')}</a>${extra}`;

// Группы людей ретрита по начислениям (ВГ 28.09): платящие — полная оплата, со скидкой, дети платные;
// не платят — дети и гости бесплатно, ВИП, волонтёры ретрита. Команда ашрама в ретрит не входит.
function peopleGroups(money) {
    const g = { full: [], disc: [], kidPaid: [], kidFree: [], free: [], vip: [], vol: [], noCharges: [] };
    for (const p of money?.people || []) {
        const net = Number(p.gross) - Number(p.discount);
        const child = p.meal_type === 'child';
        if (p.status === 'team') continue;
        if (p.status === 'vip') { if (p.placed || p.has_charges) g.vip.push(p); continue; }
        if (p.status === 'volunteer') { if (p.placed) g.vol.push(p); continue; }
        if (!p.has_charges) { g.noCharges.push(p); continue; }
        if (net > 0.005) (child ? g.kidPaid : Number(p.discount) > 0.005 ? g.disc : g.full).push(p);
        else (child ? g.kidFree : g.free).push(p);
    }
    return g;
}

function renderPerParticipant(money, sum, ownExp, noPrices) {
    const box = document.getElementById('perPartBox');
    if (!box) return;
    if (!money) { box.innerHTML = ''; return; }
    const g = peopleGroups(money);
    const net = list => list.reduce((a, p) => a + Number(p.gross) - Number(p.discount), 0);
    const disc = list => list.reduce((a, p) => a + Number(p.discount), 0);
    const payers = [...g.full, ...g.disc, ...g.kidPaid];
    const total = round2(ownExp + sum.included);
    const perPayer = payers.length ? total / payers.length : null;
    const chargedPer = payers.length ? net(payers) / payers.length : null;
    const groupsRow = sum.rows.find(r => r.key === 'groups');
    const row = (label, list, opts = {}) => list.length || opts.n ? `<tr class="${opts.cls || ''}">
        <td class="${opts.sub ? 'tbl-lvl-1 text-sm' : ''}">${e(label)}${opts.hint ? `<div class="text-xs opacity-60">${opts.hint}</div>` : ''}</td>
        <td class="text-right">${opts.n ?? list.length}</td>
        <td class="text-right font-mono">${opts.free ? '—' : fmtB(net(list))}</td>
        <td class="text-right font-mono">${opts.free || !list.length ? '—' : fmtB(net(list) / list.length)}</td></tr>` : '';
    box.innerHTML = `
    <div class="card bg-base-100 shadow-sm h-full"><div class="card-body py-4 space-y-3">
        <h2 class="card-title text-base">${e(tr('fin_ppc_title', 'Стоимость ретрита на участника'))}</h2>
        <div class="grid grid-cols-2 gap-2">
            <div class="bg-base-200/60 rounded-xl p-3">
                <div class="text-xs uppercase tracking-wide opacity-60">${e(tr('fin_ppc_cost', 'Стоит на платящего'))}</div>
                <div class="text-xl font-bold mt-1">${perPayer === null ? '—' : fmtB(perPayer)}</div>
                <div class="text-xs opacity-60 mt-1">${fmtB(total)} ÷ ${payers.length} · ${e(tr('fin_ppc_retreat', 'ретрит'))} ${fmtB(ownExp)} + ${e(tr('fin_ppc_prasad', 'прасад'))} ${fmtB(sum.included)}${noPrices ? ' ⚠' : ''}</div>
            </div>
            <div class="bg-base-200/60 rounded-xl p-3">
                <div class="text-xs uppercase tracking-wide opacity-60">${e(tr('fin_ppc_charged', 'Начислено на платящего'))}</div>
                <div class="text-xl font-bold mt-1 ${perPayer !== null && chargedPer !== null ? (chargedPer < perPayer ? 'text-error' : 'text-success') : ''}">${chargedPer === null ? '—' : fmtB(chargedPer)}</div>
                <div class="text-xs opacity-60 mt-1">${perPayer !== null && chargedPer !== null ? `${e(tr('fin_ppc_diff', 'разница'))} ${fmtB(chargedPer - perPayer)}` : ''}</div>
            </div>
        </div>
        <div class="overflow-x-auto"><table class="table table-sm">
            <thead><tr><th></th><th class="text-right">${e(tr('cost_people', 'Людей'))}</th>
                <th class="text-right">${e(tr('fin_prasad_charged_col', 'Начислено'))}</th><th class="text-right">${e(tr('cost_per_person', 'На человека'))}</th></tr></thead>
            <tbody>
                ${row(tr('fin_ppc_payers', 'Платят'), payers, { cls: 'font-semibold bg-base-200/60' })}
                ${row(tr('fin_ppc_full', 'Полная оплата'), g.full, { sub: true })}
                ${row(tr('fin_ppc_disc', 'Со скидкой'), g.disc, { sub: true, hint: g.disc.length ? `${e(tr('fin_ppc_disc_sum', 'скидки'))} ${fmtB(disc(g.disc))}` : '' })}
                ${row(tr('fin_ppc_kid_paid', 'Дети платные'), g.kidPaid, { sub: true })}
                ${row(tr('fin_ppc_free', 'Не платят — их питание разложено на платящих'), [], { cls: 'font-semibold bg-base-200/60', free: true,
                    n: g.kidFree.length + g.free.length + g.vip.length + g.vol.length + (groupsRow?.people || 0) })}
                ${row(tr('fin_ppc_kid_free', 'Дети бесплатно'), g.kidFree, { sub: true, free: true })}
                ${row(tr('fin_ppc_guest_free', 'Гости бесплатно (скидка 100%)'), g.free, { sub: true, free: true })}
                ${row(tr('fin_ppc_vip', 'ВИП, лекторы'), g.vip, { sub: true, free: true })}
                ${row(tr('fin_ppc_vol', 'Волонтёры ретрита'), g.vol, { sub: true, free: true })}
                ${groupsRow ? row(tr('nav_groups', 'Группы'), [], { sub: true, free: true, n: groupsRow.people }) : ''}
            </tbody></table></div>
        <p class="text-xs opacity-60">${e(tr('fin_ppc_note', 'Стоимость = собственные расходы ретрита (без кухонных, уже вошедших в прасад — один расход один раз) + себестоимость прасада за всех, кто ел по ретриту, включая ВИП и волонтёров. Делится на платящих. Команда ашрама в ретрит не входит. Начислено — без отмен, со скидками.'))}</p>
    </div></div>`;
}

// «Начислено и получено по дням» — весь ретрит, нарастающим итогом (ВГ 28.09).
// Стартовые остатки (оплаты и долги до перехода на систему) — в первый день.
async function renderMoneyByDay(retreat, token) {
    const box = document.getElementById('moneyDayBox');
    if (!box) return;
    const money = await moneyPromise;
    if (token !== reportToken) return;
    // ⚠ гости без единого начисления — возможно, забыли начислить (или не приехали)
    const g = peopleGroups(money);
    reportGaps.money = g.noCharges.length ? [`${e(tr('fin_gap_no_charges', 'гости без начислений'))}: ${g.noCharges.length} — ${g.noCharges
        .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'))
        .map(p => personLink(p, p.placed ? '' : ` <span class="opacity-60">(${e(tr('fin_gap_not_placed', 'не заселён'))})</span>`)).join(', ')}`] : [];
    renderReportGaps();

    const dates = [...new Set([...Object.keys(money?.charged || {}), ...Object.keys(money?.paid || {})])].sort();
    const od = Number(money?.opening_debt || 0), oc = Number(money?.opening_credit || 0);
    if (!dates.length && !od && !oc) { box.innerHTML = ''; return; }
    const today = DateUtils.toISO(new Date());
    const from = dates[0] || retreat.start_date;
    const to = [dates[dates.length - 1] || from, today < retreat.end_date ? today : retreat.end_date].sort().pop();
    const days = [];
    for (let d = from; d <= to; d = isoShift(d, 1)) days.push(d);
    let ch = od, pd = oc;
    const cumCh = [], cumPd = [], dayPd = [];
    days.forEach((d, i) => {
        const c = Number(money.charged?.[d] || 0), p = Number(money.paid?.[d] || 0);
        ch += c; pd += p;
        cumCh.push(round2(ch)); cumPd.push(round2(pd)); dayPd.push(round2(p + (i === 0 ? oc : 0)));
    });
    const short = d => DateUtils.formatShort(d).replace(/ \d{4}$/, '');
    const rest = round2(ch - pd);
    box.innerHTML = `
    <div class="card bg-base-100 shadow-sm h-full"><div class="card-body py-4 space-y-2">
        <h2 class="card-title text-base">${e(tr('fin_money_title', 'Начислено и получено по дням'))}</h2>
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <span>${e(tr('fin_charged', 'Начислено'))}: <b>${fmtB(ch)}</b></span>
            <span>${e(tr('fin_money_received', 'Получено'))}: <b class="text-blue-600">${fmtB(pd)}</b></span>
            <span>${rest >= 0 ? e(tr('fin_money_rest', 'Не получено')) : e(tr('fin_money_over', 'Получено больше начисленного'))}: <b class="${rest > 0.5 ? 'text-error' : ''}">${fmtB(Math.abs(rest))}</b></span>
        </div>
        <div class="relative h-64"><canvas id="moneyChart"></canvas></div>
        <p class="text-xs opacity-60">${e(tr('fin_money_hint', 'Весь ретрит: оргвзнос, проживание, питание, доп. услуги. Линии — нарастающим итогом, столбцы — получено за день. Начислено — без отмен, со скидками.'))}${od || oc ? ` ${e(tr('fin_money_opening', 'В первый день — остатки до перехода на систему'))}: ${e(tr('fin_money_opening_paid', 'оплачено'))} ${fmtB(oc)}${od ? `, ${e(tr('fin_money_opening_debt', 'долг'))} ${fmtB(od)}` : ''}.` : ''}</p>
    </div></div>`;
    let Chart;
    try { Chart = await loadChartLib(); } catch { box.querySelector('canvas').replaceWith(Object.assign(document.createElement('div'), { className: 'text-sm text-error', textContent: tr('cost_charts_load_error', 'Не удалось загрузить графики') })); return; }
    if (token !== reportToken || !document.getElementById('moneyChart')) return;
    if (moneyChart) moneyChart.destroy();
    moneyChart = new Chart(document.getElementById('moneyChart'), {
        type: 'bar',
        data: { labels: days.map(short), datasets: [
            { type: 'line', label: tr('fin_charged', 'Начислено'), data: cumCh, borderColor: '#8b5cf6', backgroundColor: '#8b5cf6', pointRadius: 0, borderWidth: 2, stepped: true, order: 1 },
            { type: 'line', label: tr('fin_money_received', 'Получено'), data: cumPd, borderColor: '#2563eb', backgroundColor: '#2563eb', pointRadius: 0, borderWidth: 2, stepped: true, order: 1 },
            { label: tr('fin_money_day', 'Получено за день'), data: dayPd, backgroundColor: 'rgba(37, 99, 235, 0.25)', order: 2 }
        ] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } },
                tooltip: { callbacks: { label: c => `${c.dataset.label}: ${fmtB(c.raw)}` } } },
            scales: { x: { ticks: { maxTicksLimit: 12 } }, y: { beginAtZero: true, ticks: { callback: v => Number(v).toLocaleString('ru-RU') } } } },
        plugins: [dashMarks(days, [[retreat.start_date, '#6b7280', tr('fin_move_start', 'начало')], [retreat.end_date, '#6b7280', tr('fin_move_end', 'конец')]])]
    });
}

// Процент отделу продаж (миграция 623): пока не зафиксирован — в траты ретрита идёт
// расчётом, чтобы итог был виден сразу; после фиксации это обычная трата, а если
// с тех пор что-то изменилось — расчётом идёт только разница (ВГ 02.10).
async function addSalesFeeEstimate(report, retreatId) {
    if (!canReadAllFin()) return;
    const [{ data: sf }, { data: rates }] = await Promise.all([
        Layout.db.rpc('fin_sales_fee_calc', { p_retreat: retreatId }).then(r => r, () => ({})),
        Layout.db.rpc('fin_get_retreat_rates', { p_retreat: retreatId }).then(r => r, () => ({}))
    ]);
    if (!sf?.has_object) return;
    const pending = Number(sf.amount_rub) - Number(sf.fixation?.amount_rub || 0);
    if (Math.abs(pending) < 0.005) return;
    const rubRate = Number((rates || []).find(x => x.currency_code === 'RUB')?.rate);
    if (!(rubRate > 0)) return;
    const base = Math.round(pending * rubRate * 100) / 100;
    const label = sf.fixation
        ? tr('fin_sales_fee_pending_delta', 'Процент отделу продаж — изменилось после фиксации, не проведено')
        : tr('fin_sales_fee_pending', 'Процент отделу продаж — расчёт, не зафиксировано');
    report.expense_by_category = [...(report.expense_by_category || []), {
        category_id: 'sales_fee_pending', name: `${label} (${sf.qualified} × ${FinUtils.fmtMoney(sf.rate_rub, 'RUB')})`,
        base_total: base, by_currency: { RUB: pending }, link: `sales-fee.html?retreat=${retreatId}`
    }];
    const tot = report.totals;
    tot.expense_base = Math.round((Number(tot.expense_base) + base) * 100) / 100;
    tot.net_base = Math.round((Number(tot.net_base) - base) * 100) / 100;
}

async function loadReport() {
    const box = document.getElementById('retreatReport');
    box.innerHTML = `<div class="text-center py-8"><span class="loading loading-spinner loading-md"></span></div>`;
    const token = ++reportToken;
    reportGaps = { cost: [], money: [] };
    // деньги участников по дням — только финансистам (глава кухни их не видит)
    moneyPromise = canReadAllFin()
        ? Layout.db.rpc('fin_retreat_money_by_day', { p_retreat: currentRetreat }).then(r => r.error ? null : r.data, () => null)
        : Promise.resolve(null);
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: currentRetreat });
    if (error) { Layout.handleError(error, 'Аналитика'); return; }
    if (!data?.ok) { Layout.showNotification(data?.error?.message || 'Ошибка', 'error'); return; }
    currentData = data.result;
    if (currentData.exists) await addSalesFeeEstimate(currentData.report, currentRetreat);
    if (token !== reportToken) return;

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
    // Вкладка «Прасад» видна всегда тем, кто видит себестоимость: кормим каждый ретрит,
    // даже если за питание не начисляли и по кассе прасада ничего не прошло (Художники)
    const showPrasad = hasPrasadActivity || await canViewKitchenCost();

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
        // тот же стандарт, что у финансистов: строка «Прасад» — начислено против себестоимости
        unitsState = null;
        box.innerHTML = `
            <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
                <div class="overflow-x-auto"><table class="table table-sm">
                    <thead><tr><th></th><th class="text-right">${t('fin_income')}</th><th class="text-right">${t('fin_expense')}</th><th class="text-right">${t('fin_net')}</th></tr></thead>
                    <tbody><tr id="prasadSplitRow"><td>${t('retreat_report_finance_prasad')}</td><td colspan="3" class="text-right"><span class="loading loading-spinner loading-xs"></span></td></tr></tbody>
                </table></div>
            </div></div>
            <div id="retreatMoveBox"></div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <div class="min-w-0 space-y-4">
                    <h2 class="text-lg font-semibold">${t('retreat_report_finance_prasad')}</h2>
                    <div id="prasadUnitBox"></div>
                    ${prasadCashDetails(pr)}
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
        <td class="${opts.indent ? 'tbl-lvl-1 text-sm opacity-70' : ''}">${label}</td>
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

    // Три сущности — Ретрит, Прасад, Кафе (ВГ 29.09). Ретрит и кафе — по кассе своих счетов,
    // прасад — начислено против себестоимости (строку и итог заполняет fillPrasadCost)
    const cafeTotals = hasCafeActivity ? cafe : { income_base: 0, expense_base: 0, net_base: 0 };
    unitsState = { retreat: retreatOnlyTotals, cafe: cafeTotals };
    const splitTotalsTable = (hasCafeActivity || hasPrasadActivity || showPrasad) ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4 space-y-3">
            <div class="overflow-x-auto"><table class="table table-sm">
                <thead><tr><th></th><th class="text-right">${t('fin_income')}</th><th class="text-right">${t('fin_expense')}</th><th class="text-right">${t('fin_net')}</th></tr></thead>
                <tbody>
                    ${splitRow(t('retreat_report_finance_retreat_only'), retreatOnlyTotals)}
                    ${showPrasad ? `<tr id="prasadSplitRow"><td>${t('retreat_report_finance_prasad')}</td><td colspan="3" class="text-right"><span class="loading loading-spinner loading-xs"></span></td></tr>`
                        : hasPrasadActivity ? splitRow(t('retreat_report_finance_prasad'), prasad) : ''}
                    ${hasCafeActivity ? splitRow(t('retreat_report_finance_cafe'), cafe) : ''}
                    ${showPrasad ? `<tr id="unitsTotalRow" class="font-semibold border-t-2 border-base-300"><td>${t('retreat_report_finance_total')}</td><td colspan="3"></td></tr>`
                        : splitRow(t('retreat_report_finance_total'), tot, { bold: true })}
                </tbody>
            </table></div>
            ${showPrasad ? `<p class="text-xs opacity-60">${e(tr('fin_units_note', 'Ретрит и кафе — по кассе своих счетов. Прасад — начислено за питание и пожертвования против себестоимости прасада (всё со счёта Кухни входит в неё). Карточки сверху — вся касса ретрита.'))}</p>` : ''}
        </div></div>` : '';

    // Должники и аванс важны только по ретриту — в прасаде и кафе их нет (ВГ, сен 2026)
    const debtorsHtml = `${p.debtors?.length ? `
        <div class="card bg-base-100 shadow-sm"><div class="card-body py-4">
            <h2 class="card-title text-base">${t('fin_debtors')} <span class="badge badge-error badge-sm">${p.debtors.length}</span>
                <span class="ml-auto font-mono text-error text-base">${fmtB(p.debt_total)}</span></h2>
            <div class="overflow-x-auto"><table class="table table-sm"><tbody>
                ${p.debtors.map(x => `<tr class="cursor-pointer hover:bg-base-200" onclick="location.href='participants.html?retreat=${currentRetreat}&open=${x.participant_id}'"><td><span class="hover:underline">${e(x.name || '')}</span><div data-debtor-note="${x.participant_id}"></div></td><td class="text-right font-mono text-error w-36 align-top">${fmtB(x.debt)}</td></tr>`).join('')}
            </tbody></table></div>
        </div></div>` : ''}
        ${Number(p.advance_total) > 0 ? `<div class="text-sm opacity-70">${t('fin_advance')}: ${fmtB(p.advance_total)}</div>` : ''}`;

    const unitTabs = (hasCafeActivity || showPrasad) ? `
        <div role="tablist" class="tabs tabs-boxed w-fit max-w-full">
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_retreat_only')}" checked />
            <div role="tabpanel" class="tab-content pt-4 space-y-4 min-w-0">
                ${catTable(retreatIncomeRows, 'fin_income_by_category', 'retreat')}
                ${catTable(retreatExpenseRows, 'fin_expense_by_category', 'retreat')}
                ${debtorsHtml}
            </div>
            ${showPrasad ? `
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_prasad')}" />
            <div role="tabpanel" class="tab-content pt-4 space-y-4 min-w-0">
                <div id="prasadUnitBox"></div>
                ${prasadCashDetails(r.prasad)}
                <div id="prasadCostBox"></div>
            </div>` : ''}
            ${hasCafeActivity ? `
            <input type="radio" name="fin_unit_tabs" role="tab" class="tab" aria-label="${t('retreat_report_finance_cafe')}" />
            <div role="tabpanel" class="tab-content pt-4 space-y-4 min-w-0">
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
        <div id="retreatGapsBox"></div>
        ${splitTotalsTable}
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4 items-stretch">
            <div id="perPartBox" class="min-w-0"></div>
            <div id="moneyDayBox" class="min-w-0"></div>
        </div>
        <div id="retreatMoveBox"></div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <div class="min-w-0 space-y-4">${unitTabs}</div>
            <div id="finDrill" class="card bg-base-100 shadow-sm lg:sticky lg:top-4 flex flex-col overflow-hidden"
                 style="max-height: calc(100vh - 2rem)">${drillHintHtml()}</div>
        </div>
    `;
    // Панель относится к юниту — при смене вкладки сбрасываем
    box.querySelectorAll('input[name="fin_unit_tabs"]').forEach(i => i.addEventListener('change', resetDrill));
    renderMoneyByDay(retreats.find(x => x.id === currentRetreat), token);
    if (showPrasad) fillPrasadCost(currentRetreat, prasad || {}, retreatOnlyTotals);
    fillDebtorNotes(currentRetreat, p.debtors || [], token);
}

// Должник — вместе с причиной: последняя заметка кассира из истории сделки
// CRM и срок «принесёт до»; срок прошёл — красным, договорённости нет —
// жёлтым (фаза 2, шаг 6, ВГ 29.09). Заметки импорта — не договорённость
async function fillDebtorNotes(retreat, debtors, token) {
    if (!debtors.length) return;
    const pids = debtors.map(x => x.participant_id);
    const { data: deals } = await Layout.db.from('crm_deals').select('id, vaishnava_id')
        .eq('retreat_id', retreat).in('vaishnava_id', pids).neq('status', 'cancelled');
    const dealPid = {};
    const заметка = {};
    (deals || []).forEach(d => { dealPid[d.id] = d.vaishnava_id; заметка[d.vaishnava_id] = null; });
    const ids = Object.keys(dealPid);
    if (ids.length) {
        const { data } = await Layout.db.from('crm_communications')
            .select('deal_id, summary, content, due_date, created_at')
            .in('deal_id', ids).eq('type', 'note').not('summary', 'like', '[ИМПОРТ]%')
            .order('created_at', { ascending: false });
        (data || []).forEach(n => { const pid = dealPid[n.deal_id]; if (заметка[pid] === null) заметка[pid] = n; });
    }
    if (token !== reportToken) return;
    const сегодня = new Date(); сегодня.setHours(0, 0, 0, 0);
    document.querySelectorAll('[data-debtor-note]').forEach(el => {
        const pid = el.dataset.debtorNote;
        if (!(pid in заметка)) return; // нет сделки CRM — заметку писать некуда
        const n = заметка[pid];
        if (!n) { el.innerHTML = `<div class="text-xs text-warning">Нет договорённости — добавьте заметку в карточке</div>`; return; }
        const срок = n.due_date ? DateUtils.parseDate(n.due_date) : null;
        const срокHtml = !срок ? ''
            : срок < сегодня ? ` · <span class="text-error">срок прошёл ${DateUtils.formatShort(срок)}</span>`
            : ` · срок ${DateUtils.formatShort(срок)}`;
        el.innerHTML = `<div class="text-xs opacity-70">${DateUtils.formatShort(new Date(n.created_at))} · ${e(n.summary)}${n.content ? ` — ${e(n.content)}` : ''}${срокHtml}</div>`;
    });
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

    // Себестоимость прасада — расчёт по меню, зафиксированный в снимке закрытия (fin_prasad_cost)
    const pc = snap.prasad_cost?.data;
    if (pc?.rows?.length) {
        const all = pc.rows[0];
        const part = pc.rows.find(r => r.key === 'participants');
        line('Себестоимость прасада (расчёт по меню)', 13, { gap: 6 });
        line(`Период: ${pc.from} — ${pc.to}   приёмов пищи: ${all.pm}   людей: ${all.people}${part ? `   участников: ${part.people}` : ''}`, 10, { gap: 4 });
        line(`Прямые: ${money(Math.round(all.food + all.dish + all.ext))}   накладные: ${money(Math.round(all.ovR + all.ovG))}   всего: ${money(Math.round(all.total))}`, 10, { gap: 4 });
        const included = pc.included ?? all.total;
        if (pc.settings?.is_internal) {
            const names = { food: 'продукты', dish: 'посуда', ext: 'готовое со стороны', payroll: 'зарплаты кухни', equipment: 'оборудование', utilities: 'коммунальные', household: 'хозтовары и прочее', retreat: 'расходы на ретрит' };
            line(`Внутренний ретрит — входит: ${(pc.settings.components || []).map(k => names[k] || k).join(', ') || 'ничего'}   итого ${money(Math.round(included))}`, 10, { gap: 4 });
        }
        if (pc.participants) line(`На участника: ${money(Math.round(included / pc.participants))}   на приём пищи: ${money(Math.round(pc.perMeal || 0))}`, 10, { gap: 4 });
        const noPr = pc.pricesLoaded ? '' : '   (цены продуктов ещё не внесены — себестоимость занижена)';
        if (pc.income) {
            // ТЗ 3.7: окупаемость по начисленному, полученное рядом
            const ch = Number(pc.income.charged);
            line(`Прасад — начислено ${money(ch)}   получено ${money(prasad?.income_base || 0)}`, 10, { gap: 4 });
            line(`Начислено ${money(ch)} − себестоимость ${money(Math.round(included))} = ${money(Math.round(ch - included))}${included > 0 ? `   окупаемость ${Math.round(ch / included * 100)}%` : ''}${noPr}`, 10, { gap: 4 });
        } else if (prasad) line(`Прасад — получено ${money(prasad.income_base)} − себестоимость ${money(Math.round(included))} = ${money(Math.round(Number(prasad.income_base) - included))}${noPr}`, 10, { gap: 4 });
        line(`Посчитано: ${new Date(snap.prasad_cost.computed_at).toLocaleString('ru-RU')}${snap.prasad_cost.provisional ? ' · предварительно' : ''}`, 9, { color: rgb(0.45, 0.45, 0.45), gap: 16 });
    }

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
const canReadAllFin = () => window.hasPermission?.('fin_admin') || window.hasPermission?.('fin_observer');

function exportCsv() {
    if (!currentData?.exists) return;
    const r = currentData.report;
    // глава департамента (просмотр) видит только блок «Прасад» — его и выгружаем
    if (currentData.restricted) {
        const pr = r.prasad || {};
        const rows = [['Раздел', 'Название', 'Сумма (₹)']];
        for (const x of pr.income_by_category || []) rows.push(['Приход', x.name, x.base_total]);
        for (const x of pr.expense_by_category || []) rows.push(['Расход', x.name, x.base_total]);
        rows.push(['Итог', 'Приход', pr.totals?.income_base ?? 0], ['Итог', 'Расход', pr.totals?.expense_base ?? 0], ['Итог', 'Сальдо', pr.totals?.net_base ?? 0]);
        const csv = '\ufeff' + rows.map(row => row.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'retreat-prasad.csv';
        a.click();
        return;
    }
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

// ==================== ПЕРИОД «ОБЩЕЙ» И «ПО ДЕПАРТАМЕНТАМ» ====================
// Один выбор на обе вкладки, как на Себестоимости (ВГ 27.09): месяц / квартал / год списком,
// ◀ ▶ — соседний период, «или» — свои даты. Смена шага ведёт на период с сегодняшним днём.
const PERIOD_KEY = 'fin_analytics_period';
const period = { step: 'month', from: '', to: '' };
let summaryShown = null;   // за какой период уже показаны вкладки: «from|to»
let deptShown = null;

function periodBounds(step, anchorIso) {
    const d = DateUtils.parseDate(anchorIso);
    if (step === 'year') return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
    const m0 = step === 'quarter' ? Math.floor(d.getMonth() / 3) * 3 : d.getMonth();
    const n = step === 'quarter' ? 3 : 1;
    return [DateUtils.toISO(new Date(d.getFullYear(), m0, 1)), DateUtils.toISO(new Date(d.getFullYear(), m0 + n, 0))];
}

function setPeriodStep(step, anchorIso) {
    period.step = step;
    [period.from, period.to] = periodBounds(step, anchorIso);
    try { localStorage.setItem(PERIOD_KEY, step); } catch { /* нет хранилища */ }
}

function shiftPeriod(dir) {
    if (period.step === 'custom') {
        const days = Math.round((DateUtils.parseDate(period.to) - DateUtils.parseDate(period.from)) / 86400000) + 1;
        period.from = isoShift(period.from, dir * days);
        period.to = isoShift(period.to, dir * days);
        return;
    }
    const d = DateUtils.parseDate(period.from);
    const months = period.step === 'year' ? 12 : period.step === 'quarter' ? 3 : 1;
    setPeriodStep(period.step, DateUtils.toISO(new Date(d.getFullYear(), d.getMonth() + dir * months, 1)));
}

const capital = s => s.charAt(0).toUpperCase() + s.slice(1);
const monthName = (y, m) => capital(new Date(y, m, 1).toLocaleDateString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', ''));

function renderPeriodBar() {
    document.querySelectorAll('[data-period-step]').forEach(b => b.classList.toggle('btn-active', b.dataset.periodStep === period.step));
    document.getElementById('periodFrom').value = period.from;
    document.getElementById('periodTo').value = period.to;
    const custom = period.step === 'custom';
    const sel = document.getElementById('periodSelect');
    const label = document.getElementById('periodLabel');
    sel.classList.toggle('hidden', custom);
    label.classList.toggle('hidden', !custom);
    label.textContent = custom ? DateUtils.formatRange(period.from, period.to) : '';
    if (custom) return;
    // от первого ретрита до следующего года — как на Себестоимости
    const nowY = new Date().getFullYear();
    const years = retreats.map(r => Number((r.start_date || '').slice(0, 4))).filter(Boolean);
    const y1 = Math.min(nowY, ...years), y2 = Math.max(nowY + 1, ...years);
    const opts = [];
    for (let y = y2; y >= y1; y--) {
        if (period.step === 'year') { opts.push([`${y}-01-01`, String(y)]); continue; }
        if (period.step === 'quarter') for (let q = 3; q >= 0; q--) opts.push([DateUtils.toISO(new Date(y, q * 3, 1)), `${q + 1} ${tr('cost_quarter_short', 'кв.')} ${y}`]);
        else for (let m = 11; m >= 0; m--) opts.push([DateUtils.toISO(new Date(y, m, 1)), monthName(y, m)]);
    }
    sel.innerHTML = opts.map(([v, l]) => `<option value="${v}" ${v === period.from ? 'selected' : ''}>${e(l)}</option>`).join('');
}

// Период сменился — перерисовать видимую вкладку; другая догонит, когда её откроют
function onPeriodChange() {
    renderPeriodBar();
    loadActivePeriodTab();
}

function loadActivePeriodTab() {
    const key = `${period.from}|${period.to}`;
    const tab = document.querySelector('[data-tab].tab-active')?.dataset.tab;
    if (tab === 'summary' && summaryShown !== key) loadSummary();
    if (tab === 'dept' && deptShown !== key) loadDepartments();
}

// ==================== ОБЩАЯ ====================
async function loadSummary() {
    const { from, to } = period;
    if (!from || !to) return;
    summaryShown = `${from}|${to}`;
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
    const { from, to } = period;
    if (!from || !to) return;
    deptShown = `${from}|${to}`;
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
    // «Общая» — финансы всего ашрама: главе департамента (просмотр) не открыта, вкладку не показываем
    if (!canReadAllFin()) document.querySelector('[data-tab="summary"]')?.classList.add('hidden');

    document.querySelectorAll('[data-tab]').forEach(tab =>
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-tab]').forEach(x => x.classList.remove('tab-active'));
            tab.classList.add('tab-active');
            document.getElementById('retreatTab').classList.toggle('hidden', tab.dataset.tab !== 'retreat');
            document.getElementById('summaryTab').classList.toggle('hidden', tab.dataset.tab !== 'summary');
            document.getElementById('deptTab').classList.toggle('hidden', tab.dataset.tab !== 'dept');
            document.getElementById('periodBar').classList.toggle('hidden', tab.dataset.tab === 'retreat');
            document.getElementById('deptCsvBtn').classList.toggle('hidden', tab.dataset.tab !== 'dept');
            // Заход на вкладку сразу показывает цифры за выбранный период, а не пустой экран
            loadActivePeriodTab();
        }));

    document.querySelectorAll('[data-period-step]').forEach(btn => btn.addEventListener('click', () => {
        const today = DateUtils.toISO(new Date());
        setPeriodStep(btn.dataset.periodStep, period.from <= today && today <= period.to ? today : period.from);
        onPeriodChange();
    }));
    document.querySelectorAll('[data-period-shift]').forEach(btn => btn.addEventListener('click', () => {
        shiftPeriod(Number(btn.dataset.periodShift));
        onPeriodChange();
    }));
    document.getElementById('periodSelect').addEventListener('change', ev => {
        setPeriodStep(period.step, ev.target.value);
        onPeriodChange();
    });
    ['periodFrom', 'periodTo'].forEach(id => document.getElementById(id).addEventListener('change', () => {
        const from = document.getElementById('periodFrom').value, to = document.getElementById('periodTo').value;
        if (!from || !to || from > to) return;
        Object.assign(period, { step: 'custom', from, to });
        onPeriodChange();
    }));

    document.getElementById('reissueForm').addEventListener('submit', submitReissue);
    document.getElementById('retreatReport').addEventListener('click', onReportClick);
    document.getElementById('retreatReport').addEventListener('change', ev => {
        const input = ev.target.closest('[data-prasad-internal], [data-prasad-comp]');
        if (input) onPrasadSettingChange(input);
    });
    document.addEventListener('click', ev => {
        const att = ev.target.closest('[data-attachment-path]');
        if (att) FinUtils.openAttachment(att.dataset.attachmentPath);
    });

    // Период — шаг с прошлого раза (по умолчанию месяц), сам период — с сегодняшним днём
    let savedStep = 'month';
    try { savedStep = localStorage.getItem(PERIOD_KEY) || 'month'; } catch { /* нет хранилища */ }
    setPeriodStep(['month', 'quarter', 'year'].includes(savedStep) ? savedStep : 'month', DateUtils.toISO(new Date()));
    renderPeriodBar();

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
