// ==================== KITCHEN-COST PAGE ====================
// Кухня → Себестоимость. Два режима (решение ВГ 24.09.2026):
//   «Ретрит» — ретрит целиком, по категориям людей;
//   «Период» — месяц / квартал / год / свои даты: ретриты периода (их доля по дням),
//              команда, волонтёры, гости и группы без события.
// Сверху сводка с итогом, под ней вкладки. Расчёт — js/kitchen-cost.js, вкушающие — eating_detail в базе.

(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов у пользователя не обновился, показываем русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

const BUCKET_LABELS = {
    team: () => tr('status_team', 'Команда'),
    volunteers: () => tr('category_volunteer', 'Волонтёры'),
    vips: () => tr('category_vip', 'Важные гости'),
    guests: () => tr('cost_participants', 'Участники'),
    groups: () => tr('nav_groups', 'Группы'),
    expected: () => tr('expected_guests', 'Ожидаются')
};
// Строки режима «Период» для людей без ретрита — названия как в шахматке («Гость без события»)
const NONE_ROWS = [
    { key: 'none:team', buckets: ['team'], label: () => tr('status_team', 'Команда') },
    { key: 'none:volunteers', buckets: ['volunteers'], label: () => tr('category_volunteer', 'Волонтёры') },
    { key: 'none:guests', buckets: ['guests', 'vips'], label: () => tr('cost_guests_no_event', 'Гости без события') },
    { key: 'none:groups', buckets: ['groups'], label: () => tr('cost_groups_no_event', 'Группы без события') },
    { key: 'none:expected', buckets: ['expected'], label: () => tr('expected_guests', 'Ожидаются') }
];
const MEAL_LABELS = { breakfast: () => tr('breakfast', 'Завтрак'), lunch: () => tr('lunch', 'Обед') };
const ALL_BUCKETS = ['team', 'volunteers', 'vips', 'guests', 'groups', 'expected'];

let locationId = null;
let caps = { view: false, edit: false };
let retreats = [];
let state = { mode: 'retreat', step: 'month', retreatId: '', from: '', to: '', tab: 'eaters' };
let view = null;          // { from, to, result, detail, incomes }
let calcToken = 0;
let kits = { breakfast: [], lunch: [] };
let dishwareProducts = [];
let kitPrices = {};
let unassigned = [];
let costGroups = [];
let reconcileActuals = [];
const retreatSpanCache = new Map();   // retreat_id → { from, to, pm } — где реально ели люди ретрита

// ==================== HELPERS ====================
const locale = () => Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU';
function money(v) {
    return Number(v).toLocaleString(locale(), { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' ₹';
}
function money2(v) {
    return Number(v).toLocaleString(locale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₹';
}
function num(v) { return Number(v).toLocaleString(locale()); }
function fmtDay(iso) { return DateUtils.formatShort(DateUtils.parseDate(iso)); }
function errorText(error) { return error?.details || error?.message || t('error'); }
function addDays(iso, n) { const d = DateUtils.parseDate(iso); d.setDate(d.getDate() + n); return DateUtils.toISO(d); }
function monthEnd(iso) { const d = DateUtils.parseDate(iso); return DateUtils.toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0)); }
const retreatName = id => { const r = retreats.find(x => x.id === id); return r ? Layout.getName(r) : '—'; };
const zero = () => ({ pm: 0, food: 0, dish: 0, ext: 0, ovR: 0, ovG: 0, prov: false });
const direct = x => x.food + x.dish + x.ext;
const overhead = x => x.ovR + x.ovG;
const total = x => direct(x) + overhead(x);
function addCell(acc, c) {
    if (!c) return acc;
    acc.pm += c.personMeals; acc.food += c.food; acc.dish += c.dishware; acc.ext += c.external;
    acc.ovR += c.overheadRetreat; acc.ovG += c.overheadGeneral; acc.prov = acc.prov || c.provisional;
    return acc;
}
function aggregate(cells, ev, buckets) {
    const acc = zero();
    for (const b of buckets) addCell(acc, cells?.[ev]?.[b]);
    return acc;
}

// ==================== ACCESS ====================
async function loadCaps() {
    const { data: { session } } = await Layout.db.auth.getSession();
    const uid = session?.user?.id;
    if (!uid) return;
    const check = async code => (await Layout.db.rpc('kitchen_has_permission', { p_user: uid, p_code: code })).data === true;
    const [viewP, edit, arch] = await Promise.all([check('view_prices'), check('edit_prices'), check('edit_archived_prices')]);
    caps = { view: viewP || edit || arch, edit };
}

// ==================== PERIOD ====================
function stepBounds(step, anchorIso) {
    const d = DateUtils.parseDate(anchorIso);
    if (step === 'year') return [`${d.getFullYear()}-01-01`, `${d.getFullYear()}-12-31`];
    if (step === 'quarter') {
        const q = Math.floor(d.getMonth() / 3) * 3;
        const f = new Date(d.getFullYear(), q, 1);
        return [DateUtils.toISO(f), DateUtils.toISO(new Date(d.getFullYear(), q + 3, 0))];
    }
    const f = new Date(d.getFullYear(), d.getMonth(), 1);
    return [DateUtils.toISO(f), monthEnd(DateUtils.toISO(f))];
}

function setStep(step, anchorIso) {
    state.step = step;
    [state.from, state.to] = stepBounds(step, anchorIso || state.from || DateUtils.toISO(new Date()));
}

function shiftPeriod(dir) {
    if (state.step === 'custom') {
        const days = (DateUtils.parseDate(state.to) - DateUtils.parseDate(state.from)) / 86400000 + 1;
        state.from = addDays(state.from, dir * days);
        state.to = addDays(state.to, dir * days);
        return;
    }
    const d = DateUtils.parseDate(state.from);
    const months = state.step === 'year' ? 12 : state.step === 'quarter' ? 3 : 1;
    setStep(state.step, DateUtils.toISO(new Date(d.getFullYear(), d.getMonth() + dir * months, 1)));
}

function periodLabel(from, to) {
    const f = DateUtils.parseDate(from);
    if (state.mode === 'period' && state.step !== 'custom') {
        if (state.step === 'year') return String(f.getFullYear());
        if (state.step === 'quarter') return `${Math.floor(f.getMonth() / 3) + 1} ${tr('cost_quarter_short', 'кв.')} ${f.getFullYear()}`;
        const m = f.toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '');
        return m.charAt(0).toUpperCase() + m.slice(1);
    }
    return DateUtils.formatRange(from, to);
}

// Ретрит целиком: его даты, расширенные на дни, когда люди ретрита реально ели
// (ранний заезд, задержались после) — чтобы «ретрит целиком» = сумма его месяцев.
async function retreatSpan(r) {
    if (retreatSpanCache.has(r.id)) return retreatSpanCache.get(r.id);
    const counts = await EatingUtils.loadCounts(addDays(r.start_date, -31), addDays(r.end_date, 31));
    const key = `retreat:${r.id}`;
    let from = r.start_date, to = r.end_date, pm = 0;
    for (const [date, day] of Object.entries(counts)) {
        let n = 0;
        for (const m of ['breakfast', 'lunch']) {
            const b = day.byEvent?.[m]?.[key];
            if (b) n += ALL_BUCKETS.reduce((s, k) => s + (b[k] || 0), 0);
        }
        if (!n) continue;
        pm += n;
        if (date < from) from = date;
        if (date > to) to = date;
    }
    const span = { from, to, pm };
    retreatSpanCache.set(r.id, span);
    return span;
}

// ==================== LOADING ====================
// Кто и что ел — построчно по людям и дням. За год это десятки тысяч строк: грузим месяцами параллельно.
async function loadDetail(from, to) {
    const chunks = [];
    for (let f = from; f <= to; f = addDays(monthEnd(f), 1)) chunks.push([f, monthEnd(f) < to ? monthEnd(f) : to]);
    const parts = await Promise.all(chunks.map(async ([f, t2]) => {
        const rows = [];
        for (let off = 0; ; off += 1000) {
            const { data, error } = await Layout.db.rpc('eating_detail', { p_from: f, p_to: t2 })
                .order('d').order('ref_id').range(off, off + 999);
            if (error) { console.error('eating_detail:', error); break; }
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }
        return rows;
    }));
    return parts.flat();
}

// Доход прасада ретрита — из отчёта по ретриту в финансах (блок «Прасад»). Нет прав — не показываем.
const incomeCache = new Map();
async function retreatIncome(retreatId) {
    if (incomeCache.has(retreatId)) return incomeCache.get(retreatId);
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: retreatId });
    const inc = error ? null : data?.result?.report?.prasad?.totals?.income_base;
    const v = inc === undefined || inc === null ? null : Number(inc);
    incomeCache.set(retreatId, v);
    return v;
}

async function calculate() {
    const token = ++calcToken;
    let from = state.from, to = state.to;
    if (state.mode === 'retreat') {
        const r = retreats.find(x => x.id === state.retreatId);
        if (!r) { hideResult(); return; }
        const span = await retreatSpan(r);
        from = span.from; to = span.to;
    }
    if (!from || !to || from > to) { Layout.showNotification(tr('cost_bad_period', 'Проверьте даты периода'), 'error'); return; }

    Layout.showLoader();
    try {
        const [result, detail] = await Promise.all([
            KitchenCost.calculate(Layout.db, locationId, from, to),
            loadDetail(from, to),
            loadReconcile(from, to)
        ]);
        if (token !== calcToken) return;

        // доход прасада ретритов: доля по дням питания (человеко-приёмы в окне / за весь ретрит)
        const incomes = {};
        const retreatIds = Object.keys(result.cells).filter(k => k.startsWith('retreat:')).map(k => k.slice(8));
        await Promise.all(retreatIds.map(async id => {
            const r = retreats.find(x => x.id === id);
            if (!r) return;
            const [income, span] = await Promise.all([retreatIncome(id), retreatSpan(r)]);
            const pmWindow = aggregate(result.cells, `retreat:${id}`, ALL_BUCKETS).pm;
            incomes[id] = income === null ? null
                : { full: income, share: span.pm ? Math.min(1, pmWindow / span.pm) : 1 };
        }));
        if (token !== calcToken) return;

        view = { from, to, result, detail, incomes };
        render();
    } catch (err) {
        console.error('Cost calculation:', err);
        Layout.showNotification(errorText(err), 'error');
    } finally {
        Layout.hideLoader();
    }
}

function hideResult() {
    view = null;
    Layout.$('#summaryBox').classList.add('hidden');
    Layout.$('#tabsBox').classList.add('hidden');
}

// ==================== ROWS ====================
// Строка сводки: { key, label, sub?, ev, buckets, retreatId? }
function rowDefs() {
    const cells = view.result.cells;
    if (state.mode === 'retreat') {
        const ev = `retreat:${state.retreatId}`;
        const subs = ALL_BUCKETS.filter(b => cells[ev]?.[b]?.personMeals)
            .map(b => ({ key: `${ev}:${b}`, label: BUCKET_LABELS[b](), ev, buckets: [b], sub: true }));
        return [{ key: ev, label: retreatName(state.retreatId), ev, buckets: ALL_BUCKETS, retreatId: state.retreatId, main: true }, ...subs];
    }
    const retreatRows = Object.keys(cells).filter(k => k.startsWith('retreat:'))
        .map(ev => ({ key: ev, label: retreatName(ev.slice(8)), ev, buckets: ALL_BUCKETS, retreatId: ev.slice(8) }))
        .sort((a, b) => a.label.localeCompare(b.label, Layout.currentLang));
    const noneRows = NONE_ROWS.map(r => ({ key: r.key, label: r.label(), ev: 'none', buckets: r.buckets }))
        .filter(r => aggregate(cells, 'none', r.buckets).pm);
    return [...retreatRows, ...noneRows];
}

// люди строки по данным eating_detail: кто ел, только завтраки/обеды, не питался
function peopleStats(row) {
    const persons = new Map();   // key → { bf, ln, n }
    for (const x of view.detail) {
        const ev = x.retreat_id ? `retreat:${x.retreat_id}` : 'none';
        if (ev !== row.ev || !row.buckets.includes(x.bucket)) continue;
        const key = x.vaishnava_id || x.ref_id;
        const p = persons.get(key) || { bf: false, ln: false, n: 1, bucket: x.bucket };
        p.bf = p.bf || x.breakfast; p.ln = p.ln || x.lunch;
        if (x.kind === 'group') p.n = Math.max(p.n, Number(x.people) || 1);
        persons.set(key, p);
    }
    const s = { people: 0, both: 0, bfOnly: 0, lnOnly: 0, none: 0, participants: 0 };
    for (const p of persons.values()) {
        if (!p.bf && !p.ln) { s.none += p.n; continue; }
        s.people += p.n;
        if (p.bf && p.ln) s.both += p.n; else if (p.bf) s.bfOnly += p.n; else s.lnOnly += p.n;
        if (p.bucket !== 'team' && p.bucket !== 'volunteers') s.participants += p.n;
    }
    return s;
}

function pricesState() {
    const r = view.result;
    if (!r.pricesLoaded) return 'none';
    return r.warnings.missingPrices.size || r.warnings.unresolvedUnits.size ? 'partial' : 'ok';
}

// ==================== RENDER ====================
function render() {
    renderSummary();
    renderTabs();
}

function renderSummary() {
    const cells = view.result.cells;
    const ps = pricesState();
    const rows = rowDefs();
    const title = state.mode === 'retreat'
        ? `${retreatName(state.retreatId)} · ${DateUtils.formatRange(view.from, view.to)}`
        : periodLabel(view.from, view.to);
    Layout.$('#summaryTitle').textContent = title;

    const badges = [];
    if (view.result.totals.provisional) badges.push(`<span class="badge badge-warning badge-sm" title="${e(tr('cost_provisional_hint', 'Период расходов ещё не закончился или зарплата взята оценкой'))}">${e(tr('cost_provisional', 'предварительно'))}</span>`);
    if (ps === 'none') badges.push(`<a class="badge badge-error badge-sm" href="prices.html">${e(tr('cost_no_prices_badge', 'цены ещё не внесены'))}</a>`);
    if (ps === 'partial') badges.push(`<span class="badge badge-outline badge-warning badge-sm cursor-pointer" data-action="tab" data-tab="problems">${e(tr('cost_partial_badge', 'расчёт неполный'))}</span>`);
    Layout.$('#summaryBadges').innerHTML = badges.join('');

    const isPeriod = state.mode === 'period';
    Layout.$('#summaryHead').innerHTML = `<tr>
        <th></th>
        ${isPeriod ? `<th class="text-right">${e(tr('cost_days', 'Дней'))}</th>` : ''}
        <th class="text-right">${e(tr('cost_people', 'Людей'))}</th>
        <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
        <th class="text-right">${e(tr('cost_direct', 'Прямые'))}</th>
        <th class="text-right">${e(tr('cost_overhead', 'Накладные'))}</th>
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
        <th class="text-right">${e(tr('cost_per_meal', 'На приём пищи'))}</th>
        <th class="text-right">${e(tr('cost_per_participant', 'На участника'))}</th>
        <th class="text-right">${e(tr('cost_income', 'Доход прасада'))}</th>
        <th class="text-right">${e(tr('cost_result', 'Результат'))}</th>
    </tr>`;

    const directCell = x => ps === 'none' ? `<span class="opacity-50">${e(tr('cost_no_prices', 'нет цен'))}</span>`
        : `${money(direct(x))}${ps === 'partial' ? ' <span class="text-warning" title="' + e(tr('cost_partial_hint', 'Не у всех продуктов есть цена или перевод единиц — см. «Проблемы»')) + '">⚠</span>' : ''}`;
    const grand = zero();
    let grandIncome = 0, anyIncome = false;
    const html = rows.map(row => {
        const x = aggregate(cells, row.ev, row.buckets);
        if (!row.sub) Object.keys(grand).forEach(k => { if (k !== 'prov') grand[k] += x[k]; });
        const st = peopleStats(row);
        const inc = row.retreatId ? view.incomes[row.retreatId] : undefined;
        const income = inc ? inc.full * inc.share : null;
        if (income !== null && !row.sub) { grandIncome += income; anyIncome = true; }
        const perPart = row.retreatId && st.participants ? total(x) / st.participants : null;
        const days = isPeriod ? daysOf(row) : null;
        const cls = row.sub ? 'text-sm' : 'font-medium';
        return `<tr class="${row.main ? 'bg-base-200/60 font-semibold' : ''}">
            <td class="${cls} ${row.sub ? 'pl-8' : ''}">${e(row.label)}${inc && inc.share < 0.999 ? ` <span class="text-xs opacity-60">(${Math.round(inc.share * 100)}% ${e(tr('cost_of_retreat', 'ретрита'))})</span>` : ''}</td>
            ${isPeriod ? `<td class="text-right text-sm">${days}</td>` : ''}
            <td class="text-right">${st.people ? num(st.people) : '—'}</td>
            <td class="text-right">${num(x.pm)}</td>
            <td class="text-right">${directCell(x)}</td>
            <td class="text-right">${money(overhead(x))}</td>
            <td class="text-right font-medium">${money(total(x))}</td>
            <td class="text-right">${x.pm ? money2(total(x) / x.pm) : '—'}</td>
            <td class="text-right">${perPart !== null && !row.sub ? money(perPart) : '—'}</td>
            <td class="text-right">${income !== null && !row.sub ? money(income) : '—'}</td>
            <td class="text-right">${resultCell(income, x, row.sub, ps)}</td>
        </tr>`;
    }).join('');

    const showGrand = isPeriod && rows.length > 1;
    const grandHtml = showGrand ? `<tr class="font-bold border-t-2 border-base-300">
        <td>${e(tr('cost_grand_total', 'Итого за период'))}</td><td></td>
        <td class="text-right">${num(peopleTotal())}</td>
        <td class="text-right">${num(grand.pm)}</td>
        <td class="text-right">${directCell(grand)}</td>
        <td class="text-right">${money(overhead(grand))}</td>
        <td class="text-right">${money(total(grand))}</td>
        <td class="text-right">${grand.pm ? money2(total(grand) / grand.pm) : '—'}</td>
        <td></td>
        <td class="text-right">${anyIncome ? money(grandIncome) : '—'}</td>
        <td class="text-right">${anyIncome ? resultCell(grandIncome, grand, false, ps) : '—'}</td>
    </tr>` : '';

    const t2 = view.result.totals;
    const lost = [];
    if (t2.unallocated > 0.5) lost.push(`${tr('cost_unallocated', 'Расходы приёмов пищи без вкушающих (не распределены)')}: ${money(t2.unallocated)}`);
    if (t2.overheadUnallocated > 0.5) lost.push(`${tr('cost_overhead_unallocated', 'Накладные расходы без вкушающих или без приёма пищи в меню (не распределены)')}: ${money(t2.overheadUnallocated)}`);
    const lostHtml = lost.length && isPeriod
        ? lost.map(l => `<tr class="text-warning text-sm"><td colspan="11">${e(l)}</td></tr>`).join('') : '';

    Layout.$('#summaryBody').innerHTML = (html || `<tr><td colspan="11" class="text-center opacity-60 py-6">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`) + grandHtml + lostHtml;
    Layout.$('#summaryNote').textContent = isPeriod
        ? tr('cost_summary_note_period', 'Ретрит, который захватывает несколько месяцев, входит в период своей долей: расходы — по дням, доход прасада — по доле приёмов пищи. «На участника» — стоимость ретрита на одного участника без команды и волонтёров.')
        : tr('cost_summary_note_retreat', 'Ретрит целиком, включая дни раннего заезда и позднего выезда его участников. «На участника» — вся стоимость ретрита на одного участника без команды и волонтёров. Доход прасада — из отчёта по ретриту в финансах.');
    Layout.$('#summaryBox').classList.remove('hidden');
}

function resultCell(income, x, sub, ps) {
    if (sub || income === null) return '—';
    if (ps === 'none') return `<span class="opacity-50" title="${e(tr('cost_result_no_prices', 'Пока нет цен, себестоимость занижена — результат не показываем'))}">—</span>`;
    const r = income - total(x);
    return `<span class="${r < 0 ? 'text-error' : 'text-success'} font-medium">${money(r)}</span>${ps === 'partial' ? ' <span class="text-warning">⚠</span>' : ''}`;
}

function daysOf(row) {
    const dates = new Set();
    for (const [date, day] of Object.entries(view.result.counts || {})) {
        if (date < view.from || date > view.to) continue;
        for (const m of ['breakfast', 'lunch']) {
            const b = day.byEvent?.[m]?.[row.ev];
            if (b && row.buckets.some(k => b[k])) { dates.add(date); break; }
        }
    }
    if (!dates.size) return '—';
    const list = [...dates].sort();
    if (!row.retreatId) return String(list.length);
    return `${list.length} <span class="opacity-60">(${e(DateUtils.formatRangeShort(list[0], list[list.length - 1]))})</span>`;
}

function peopleTotal() {
    const seen = new Map();
    for (const x of view.detail) {
        if (!x.breakfast && !x.lunch) continue;
        const key = x.vaishnava_id || x.ref_id;
        seen.set(key, x.kind === 'group' ? Math.max(seen.get(key) || 0, Number(x.people) || 1) : 1);
    }
    return [...seen.values()].reduce((s, n) => s + n, 0);
}

// ==================== TABS ====================
function tabList() {
    const w = view.result.warnings;
    const problems = w.missingPrices.size + w.unresolvedUnits.size + w.noMenu.length + w.noEaters.length
        + w.overheadNoBase.length + w.overheadUnallocated.length + w.laborUnlinked.length + w.recipesNoOutput.size
        + (w.overheadError ? 1 : 0) + (w.payrollEstimated.length ? 1 : 0);
    const multiMonth = view.from.slice(0, 7) !== view.to.slice(0, 7);
    return [
        { id: 'eaters', label: tr('cost_tab_eaters', 'Вкушающие') },
        { id: 'direct', label: tr('cost_tab_direct', 'Прямые затраты') },
        { id: 'overhead', label: tr('cost_tab_overhead', 'Накладные') },
        multiMonth ? { id: 'months', label: tr('cost_tab_months', 'По месяцам') } : null,
        { id: 'reconcile', label: tr('cost_reconcile_title', 'Сверка с ДДС') },
        { id: 'settings', label: tr('cost_tab_settings', 'Настройки расчёта') },
        { id: 'problems', label: `${tr('cost_tab_problems', 'Проблемы')}${problems ? ` (${problems})` : ''}`, warn: problems > 0 }
    ].filter(Boolean);
}

function renderTabs() {
    const tabs = tabList();
    if (!tabs.some(x => x.id === state.tab)) state.tab = 'eaters';
    Layout.$('#tabBar').innerHTML = tabs.map(x =>
        `<a role="tab" class="tab ${x.id === state.tab ? 'tab-active [--tab-bg:oklch(var(--b1))]' : ''} ${x.warn ? 'text-warning' : ''}" data-action="tab" data-tab="${x.id}">${e(x.label)}</a>`).join('');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== state.tab));
    Layout.$('#tabsBox').classList.remove('hidden');
    ({ eaters: renderEaters, direct: renderDirect, overhead: renderOverhead, months: renderMonths,
       reconcile: renderReconcile, settings: () => { renderKits(); renderGroups(); }, problems: renderWarnings })[state.tab]?.();
}

// ---------- Вкушающие ----------
function scopeEvents() {
    return state.mode === 'retreat' ? [`retreat:${state.retreatId}`] : null;   // null — все события
}

function renderEaters() {
    const rows = rowDefs();
    Layout.$('#eatersHead').innerHTML = `<tr><th></th>
        <th class="text-right">${e(tr('cost_people', 'Людей'))}</th>
        <th class="text-right">${e(tr('cost_ate_both', 'Завтраки и обеды'))}</th>
        <th class="text-right">${e(tr('cost_ate_bf_only', 'Только завтраки'))}</th>
        <th class="text-right">${e(tr('cost_ate_ln_only', 'Только обеды'))}</th>
        <th class="text-right">${e(tr('cost_ate_none', 'Не питались'))}</th>
        <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th></tr>`;
    Layout.$('#eatersBody').innerHTML = rows.map(row => {
        const s = peopleStats(row);
        const x = aggregate(view.result.cells, row.ev, row.buckets);
        return `<tr class="${row.main ? 'bg-base-200/60 font-semibold' : ''}">
            <td class="${row.sub ? 'pl-8 text-sm' : ''}">${e(row.label)}</td>
            <td class="text-right">${num(s.people)}</td><td class="text-right">${num(s.both)}</td>
            <td class="text-right">${num(s.bfOnly)}</td><td class="text-right">${num(s.lnOnly)}</td>
            <td class="text-right ${s.none ? '' : 'opacity-40'}">${num(s.none)}</td>
            <td class="text-right">${num(x.pm)}</td></tr>`;
    }).join('');

    const scope = scopeEvents();
    const cols = ALL_BUCKETS;
    Layout.$('#daysHead').innerHTML = `<tr><th>${e(tr('date', 'Дата'))}</th><th></th>
        ${cols.map(b => `<th class="text-right">${e(BUCKET_LABELS[b]())}</th>`).join('')}
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr>`;
    const out = [];
    const dates = Object.keys(view.result.counts || {}).filter(d => d >= view.from && d <= view.to).sort();
    for (const d of dates) {
        for (const m of ['breakfast', 'lunch']) {
            const byEv = view.result.counts[d].byEvent?.[m] || {};
            const sum = Object.fromEntries(cols.map(b => [b, 0]));
            for (const [ev, b] of Object.entries(byEv)) {
                if (scope && !scope.includes(ev)) continue;
                cols.forEach(k => sum[k] += b[k] || 0);
            }
            const tot = cols.reduce((s, k) => s + sum[k], 0);
            if (!tot) continue;
            out.push(`<tr><td class="whitespace-nowrap">${m === 'breakfast' ? e(fmtDay(d)) : ''}</td><td class="text-sm opacity-70">${e(MEAL_LABELS[m]())}</td>
                ${cols.map(k => `<td class="text-right ${sum[k] ? '' : 'opacity-30'}">${sum[k]}</td>`).join('')}
                <td class="text-right font-medium">${tot}</td></tr>`);
        }
    }
    Layout.$('#daysBody').innerHTML = out.join('') || `<tr><td colspan="9" class="text-center opacity-60">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`;
}

// ---------- Прямые затраты ----------
function renderDirect() {
    const scope = scopeEvents();
    const ps = pricesState();
    Layout.$('#directHead').innerHTML = `<tr><th>${e(tr('date', 'Дата'))}</th><th></th>
        <th class="text-right">${e(tr('cost_cook_portions', 'Порций (повар)'))}</th>
        <th class="text-right">${e(tr('cost_eaters', 'Вкушающих'))}</th>
        ${scope ? `<th class="text-right">${e(tr('cost_of_them_retreat', 'из них ретрит'))}</th>` : ''}
        <th class="text-right">${e(tr('cost_food', 'Продукты'))}</th>
        <th class="text-right">${e(tr('cost_dishware', 'Посуда'))}</th>
        <th class="text-right">${e(tr('cost_external', 'Готовое'))}</th>
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr>`;
    const sum = { food: 0, dish: 0, ext: 0 };
    const rows = view.result.mealRecords.filter(r => r.date >= view.from && r.date <= view.to)
        .sort((a, b) => a.date.localeCompare(b.date) || a.meal.localeCompare(b.meal)).map(r => {
        let n = r.eaters;
        if (scope) n = Object.entries(r.byEvent).filter(([ev]) => scope.includes(ev))
            .reduce((s, [, b]) => s + ALL_BUCKETS.reduce((x, k) => x + (b[k] || 0), 0), 0);
        if (scope && !n) return '';
        const share = r.eaters ? n / r.eaters : 0;
        const food = r.food * share, dish = r.dishwarePerEater * n, ext = r.external * share;
        sum.food += food; sum.dish += dish; sum.ext += ext;
        const fullyExternal = !r.ownDishes && r.external > 0;
        const extTitle = r.externalNames.length ? r.externalNames.join(', ') : '';
        return `<tr class="${r.unallocated ? 'text-warning' : ''}">
            <td class="whitespace-nowrap">${e(fmtDay(r.date))}</td>
            <td class="text-sm">${e(MEAL_LABELS[r.meal]())}${fullyExternal ? ` <span class="badge badge-info badge-xs">${e(tr('cost_fully_external', 'целиком со стороны'))}</span>` : ''}</td>
            <td class="text-right">${r.portions ?? '—'}</td>
            <td class="text-right">${r.eaters || '—'}</td>
            ${scope ? `<td class="text-right">${n}</td>` : ''}
            <td class="text-right">${ps === 'none' ? '—' : money(food)}</td>
            <td class="text-right">${ps === 'none' ? '—' : money(dish)}</td>
            <td class="text-right" title="${e(extTitle)}">${ext ? money(ext) : '—'}</td>
            <td class="text-right font-medium">${money(food + dish + ext)}</td></tr>`;
    }).join('');
    Layout.$('#directBody').innerHTML = rows
        ? rows + `<tr class="font-semibold border-t-2 border-base-300"><td colspan="${scope ? 5 : 4}">${e(tr('cost_total', 'Всего'))}</td>
            <td class="text-right">${money(sum.food)}</td><td class="text-right">${money(sum.dish)}</td>
            <td class="text-right">${money(sum.ext)}</td><td class="text-right">${money(sum.food + sum.dish + sum.ext)}</td></tr>`
        : `<tr><td colspan="9" class="text-center opacity-60">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`;
}

// ---------- Накладные ----------
const GROUP_LABELS = {
    direct: () => tr('cost_group_direct', 'Прямые (сверка с ДДС)'),
    retreat: () => tr('cost_group_retreat', 'На ретрит'),
    general: () => tr('cost_group_general', 'Общие'),
    excluded: () => tr('cost_group_excluded', 'Не учитывать')
};

function renderOverhead() {
    const scope = scopeEvents();
    Layout.$('#overheadHead').innerHTML = `<tr><th>${e(tr('cost_reconcile_category', 'Статья'))}</th>
        <th>${e(tr('cost_ov_period', 'Период расхода'))}</th>
        <th>${e(tr('cost_ov_group', 'Как делится'))}</th>
        <th class="text-right">${e(tr('cost_ov_amount', 'Сумма'))}</th>
        <th class="text-right">${e(scope ? tr('cost_ov_to_retreat', 'На этот ретрит') : tr('cost_ov_to_period', 'В этот период'))}</th></tr>`;
    let sum = 0;
    const lines = view.result.overheadLines.map(l => {
        const part = scope ? scope.reduce((s, ev) => s + (l.byEvent[ev] || 0), 0) : l.allocated;
        if (!(part > 0.5) && !l.unallocated) return null;
        sum += part;
        const label = l.category === 'payroll' ? `${tr('cost_payroll', 'Зарплата')}: ${l.label}` : l.category;
        const how = l.unallocated ? tr('cost_ov_unallocated_short', 'не распределено — нет вкушающих')
            : l.kind === 'retreat_event' ? `${GROUP_LABELS.retreat()}: ${retreatName(l.retreatId)}`
            : l.kind === 'retreat_period' ? tr('cost_ov_retreats_of_period', 'на ретриты своего периода')
            : l.group === 'general' && l.kind !== 'general' ? `${GROUP_LABELS.general()} (${tr('cost_ov_no_retreat_eaters', 'людей ретрита не было')})`
            : GROUP_LABELS.general();
        return { from: l.from, html: `<tr class="${l.unallocated ? 'text-warning' : ''}">
            <td class="text-sm">${e(label)}${l.estimate ? ` <span class="badge badge-warning badge-xs">${e(tr('cost_estimate', 'оценка'))}</span>` : ''}${l.comment ? `<div class="text-xs opacity-60">${e(l.comment)}</div>` : ''}</td>
            <td class="text-sm whitespace-nowrap">${e(DateUtils.formatRange(l.from, l.to))}</td>
            <td class="text-sm">${e(how)}</td>
            <td class="text-right">${money(l.amount)}</td>
            <td class="text-right font-medium">${money(part)}</td></tr>` };
    }).filter(Boolean).sort((a, b) => a.from.localeCompare(b.from)).map(x => x.html).join('');
    Layout.$('#overheadBody').innerHTML = lines
        ? lines + `<tr class="font-semibold border-t-2 border-base-300"><td colspan="4">${e(tr('cost_total', 'Всего'))}</td><td class="text-right">${money(sum)}</td></tr>`
        : `<tr><td colspan="5" class="text-center opacity-60">${e(tr('cost_ov_none', 'Накладных расходов в периоде нет'))}</td></tr>`;
    renderUnassigned();
}

// ---------- По месяцам ----------
function renderMonths() {
    const months = view.result.months || {};
    const keys = Object.keys(months).sort();
    // колонки: в режиме «Ретрит» — только ретрит; в «Периоде» — ретриты вместе и люди без события
    const colDefs = state.mode === 'retreat'
        ? [{ label: retreatName(state.retreatId), pick: (m) => aggregate(m, `retreat:${state.retreatId}`, ALL_BUCKETS) }]
        : [{ label: tr('cost_retreats', 'Ретриты'), pick: (m) => Object.keys(m).filter(k => k.startsWith('retreat:'))
                .reduce((acc, ev) => { const x = aggregate(m, ev, ALL_BUCKETS); Object.keys(acc).forEach(k => { if (k !== 'prov') acc[k] += x[k]; }); return acc; }, zero()) },
           ...NONE_ROWS.map(r => ({ label: r.label(), pick: (m) => aggregate(m, 'none', r.buckets) }))];
    Layout.$('#monthsHead').innerHTML = `<tr><th>${e(tr('cost_month', 'Месяц'))}</th>
        ${colDefs.map(c => `<th class="text-right">${e(c.label)}</th>`).join('')}
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
        <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
        <th class="text-right">${e(tr('cost_per_meal', 'На приём пищи'))}</th></tr>`;
    const grand = colDefs.map(() => zero());
    const body = keys.map(ym => {
        const vals = colDefs.map(c => c.pick(months[ym]));
        vals.forEach((v, i) => Object.keys(v).forEach(k => { if (k !== 'prov') grand[i][k] += v[k]; }));
        const tot = vals.reduce((s, v) => s + total(v), 0), pm = vals.reduce((s, v) => s + v.pm, 0);
        const label = DateUtils.parseDate(ym + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '');
        return `<tr><td>${e(label.charAt(0).toUpperCase() + label.slice(1))}</td>
            ${vals.map(v => `<td class="text-right">${v.pm ? money(total(v)) : '—'}</td>`).join('')}
            <td class="text-right font-medium">${money(tot)}</td><td class="text-right">${num(pm)}</td>
            <td class="text-right">${pm ? money2(tot / pm) : '—'}</td></tr>`;
    }).join('');
    const gTot = grand.reduce((s, v) => s + total(v), 0), gPm = grand.reduce((s, v) => s + v.pm, 0);
    Layout.$('#monthsBody').innerHTML = body + `<tr class="font-bold border-t-2 border-base-300"><td>${e(tr('cost_total', 'Всего'))}</td>
        ${grand.map(v => `<td class="text-right">${v.pm ? money(total(v)) : '—'}</td>`).join('')}
        <td class="text-right">${money(gTot)}</td><td class="text-right">${num(gPm)}</td>
        <td class="text-right">${gPm ? money2(gTot / gPm) : '—'}</td></tr>`;
}

// ---------- Проблемы ----------
function warningBox(title, items, cls = 'alert-warning') {
    if (!items) return '';
    const shown = items.slice(0, 8).map(x => `<li>${e(x)}</li>`).join('');
    const more = items.length > 8 ? `<li class="opacity-60">… ${items.length - 8}</li>` : '';
    return `<div class="alert ${cls} items-start text-sm"><div><div class="font-semibold">${e(title)}</div>${items.length ? `<ul class="list-disc ml-5 mt-1">${shown}${more}</ul>` : ''}</div></div>`;
}

function renderWarnings() {
    const w = view.result.warnings;
    const names = view.result.productNames;
    const parts = [];
    const nonEmpty = (title, items, cls) => items.length ? warningBox(`${title}: ${items.length}`, items, cls) : '';

    if (!view.result.pricesLoaded) {
        parts.push(`<div class="alert alert-error text-sm"><div><div class="font-semibold">${e(tr('cost_w_no_prices_all', 'Цены ещё не внесены ни на один продукт — продукты и посуда считаются как 0'))}</div>
            <a class="link" href="prices.html">${e(tr('nav_prices', 'Цены'))} →</a></div></div>`);
    } else {
        parts.push(nonEmpty(tr('cost_w_prices', 'Нет цены на дату приёма пищи, расход по этим продуктам не учтён'),
            [...w.missingPrices.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${names[id] || id} (${n})`)));
    }
    parts.push(nonEmpty(tr('cost_w_units', 'Не удалось перевести единицы (рецепт и продукт в несовместимых единицах), ингредиент не учтён'),
        [...w.unresolvedUnits.keys()].map(k => { const [p, a, b] = k.split('|'); return `${p}: ${a} → ${b}`; })));
    if (w.recipesNoOutput.size) parts.push(warningBox(`${tr('cost_w_output', 'У рецептов не указан выход, масштаб не посчитан')}: ${w.recipesNoOutput.size}`, []));
    parts.push(nonEmpty(tr('cost_w_nomenu', 'Вкушающие есть, а приёма пищи в меню нет'),
        w.noMenu.map(s => { const [d, m] = s.split(' '); return `${fmtDay(d)} · ${MEAL_LABELS[m]()}`; }), 'alert-info'));
    parts.push(nonEmpty(tr('cost_w_noeaters', 'Приём пищи с расходами, но без вкушающих'),
        w.noEaters.map(s => { const [d, m] = s.split(' '); return `${fmtDay(d)} · ${MEAL_LABELS[m]()}`; })));
    if (w.overheadError) parts.push(warningBox(`${tr('cost_w_ov_error', 'Не удалось загрузить накладные расходы (зарплаты, общие расходы, билеты), показаны только прямые затраты')}: ${w.overheadError}`, []));
    parts.push(nonEmpty(tr('cost_w_payroll_est', 'Зарплата за месяц взята оценкой (начисления ещё нет), итог предварительный'), w.payrollEstimated, 'alert-info'));
    parts.push(nonEmpty(tr('cost_w_ov_nobase', 'Расход «на ретрит», а вкушающих ретрита в периоде нет: учтён в общих'), w.overheadNoBase));
    parts.push(nonEmpty(tr('cost_w_ov_unalloc', 'Расход периода, в котором нет вкушающих: не распределён'), w.overheadUnallocated));
    if (w.overheadUnassigned) parts.push(warningBox(`${tr('cost_w_ov_unassigned', 'Расходы «на ретрит» без ретрита и назначения считаются общими, назначьте их во вкладке «Накладные»')}: ${w.overheadUnassigned}`, [], 'alert-info'));
    parts.push(nonEmpty(tr('cost_w_labor', 'Выплата по статье «Зарплата» не связана с ведомостью: возможен двойной счёт с начислениями'), w.laborUnlinked));
    if (w.overheadForeign) parts.push(warningBox(`${tr('cost_w_foreign', 'Зарплата не в рупиях, не учтена')}: ${w.overheadForeign}`, []));
    const html = parts.join('');
    Layout.$('#warnings').innerHTML = html || `<div class="text-sm opacity-60">${e(tr('cost_no_problems', 'Проблем в данных нет'))}</div>`;
}

// ==================== KIT ====================
async function loadKits() {
    const [{ data: kitRows }, { data: cat }] = await Promise.all([
        Layout.db.from('kitchen_portion_kits').select('meal_type, product_id, quantity').eq('location_id', locationId),
        Layout.db.from('product_categories').select('id').eq('slug', 'disposable').maybeSingle()
    ]);
    kits = { breakfast: [], lunch: [] };
    (kitRows || []).forEach(k => kits[k.meal_type]?.push(k));

    dishwareProducts = [];
    if (cat?.id) {
        const { data } = await Layout.db.from('products').select('id, name_ru, name_en, name_hi').eq('category_id', cat.id).order('name_ru');
        dishwareProducts = data || [];
    }
    const ids = dishwareProducts.map(p => p.id);
    kitPrices = {};
    if (ids.length) {
        const { data } = await Layout.db.from('kitchen_prices').select('product_id, price, valid_from, valid_to')
            .eq('location_id', locationId).in('product_id', ids);
        (data || []).forEach(r => (kitPrices[r.product_id] = kitPrices[r.product_id] || []).push(r));
    }
}

function productLabel(id) {
    const p = dishwareProducts.find(x => x.id === id);
    return p ? (p['name_' + Layout.currentLang] || p.name_ru) : id;
}

function renderKits() {
    const today = DateUtils.toISO(new Date());
    Layout.$('#kitBody').innerHTML = ['breakfast', 'lunch'].map(meal => {
        const items = kits[meal];
        const used = new Set(items.map(k => k.product_id));
        const free = dishwareProducts.filter(p => !used.has(p.id));
        const rows = items.map(k => {
            const price = KitchenCost.priceOn(kitPrices[k.product_id], today);
            return `<div class="flex items-center gap-2 py-1 border-b border-base-200">
                <span class="flex-1 text-sm">${e(productLabel(k.product_id))}</span>
                <span class="text-xs opacity-60 w-24 text-right">${price === null ? e(tr('prices_no_price', 'Нет цены')) : e(money2(price))}</span>
                <input type="number" min="0.05" step="0.05" value="${k.quantity}" class="input input-bordered input-xs w-20 text-right"
                       data-kit-qty data-meal="${meal}" data-product="${k.product_id}" ${caps.edit ? '' : 'disabled'} />
                ${caps.edit ? `<button class="btn btn-ghost btn-xs" data-action="kit-remove" data-meal="${meal}" data-product="${k.product_id}">✕</button>` : ''}
            </div>`;
        }).join('');
        const add = caps.edit && free.length ? `<div class="flex items-center gap-2 mt-2">
            <select class="select select-bordered select-xs flex-1" data-kit-add-product="${meal}">${free.map(p => `<option value="${p.id}">${e(productLabel(p.id))}</option>`).join('')}</select>
            <button class="btn btn-xs btn-outline" data-action="kit-add" data-meal="${meal}">+ ${e(tr('cost_kit_add', 'Добавить'))}</button>
        </div>` : (caps.edit ? `<div class="text-xs opacity-60 mt-2">${e(tr('cost_kit_all_added', 'Все позиции категории «Одноразовая посуда» уже в наборе. Новый вид посуды заведите как продукт в этой категории:'))} <a class="link" href="products.html">${e(tr('nav_products', 'Продукты'))}</a></div>` : '');
        return `<div><div class="font-medium mb-1">${e(MEAL_LABELS[meal]())}</div>${rows || `<div class="text-sm opacity-60">${e(tr('cost_kit_empty', 'Набор пуст'))}</div>`}${add}</div>`;
    }).join('');
}

async function saveKit(meal, productId, qty) {
    const { error } = await Layout.db.rpc('kitchen_set_kit_item', {
        p_location_id: locationId, p_meal_type: meal, p_product_id: productId, p_quantity: qty
    });
    if (error) { Layout.showNotification(errorText(error), 'error'); return false; }
    Layout.showNotification(t('saved'), 'success');
    await loadKits();
    renderKits();
    return true;
}

// ==================== СВЕРКА С ДДС ====================
// Расчёт (модель по рецептам/ценам/вкушающим) против факта (реальные расходы кухни по
// «прямым» статьям за те же даты). Расхождение не всегда ошибка: «стратегический запас»
// закупается заранее, а расходуется постепенно — прямого аналога в модели у него нет.
const RECONCILE_ROWS = [
    { code: 'dept_food', modelKey: 'food' },
    { code: 'disposable_tableware', modelKey: 'dishware' },
    { code: 'prasad_order', modelKey: 'external' },
    { code: 'strategic_stock', modelKey: null }
];

async function loadReconcile(from, to) {
    const { data, error } = await Layout.db.rpc('fin_kitchen_direct_actuals', { p_from: from, p_to: to });
    reconcileActuals = error ? [] : (data || []);
}

function renderReconcile() {
    const totals = view.result.totals;
    let modelSum = 0, factSum = 0;
    const rows = RECONCILE_ROWS.map(r => {
        const actual = reconcileActuals.find(x => x.category_code === r.code);
        const model = r.modelKey ? Number(totals[r.modelKey] || 0) : null;
        const fact = Number(actual?.amount_base || 0);
        const name = actual?.category_name || tr('cost_cat_' + r.code, r.code);
        const diff = model === null ? null : model - fact;
        if (model !== null) { modelSum += model; factSum += fact; }
        return `<tr>
            <td class="text-sm">${e(name)}</td>
            <td class="text-right">${model === null ? '—' : money(model)}</td>
            <td class="text-right">${money(fact)}</td>
            <td class="text-right ${diff !== null && Math.abs(diff) > Math.max(fact, model || 0) * 0.15 ? 'text-warning font-medium' : ''}">${diff === null ? e(tr('cost_reconcile_na', 'нет в модели')) : money(diff)}</td>
        </tr>`;
    }).join('') + `<tr class="font-semibold border-t-2 border-base-300">
        <td class="text-sm">${e(tr('cost_reconcile_total', 'Итого сопоставимых'))}</td>
        <td class="text-right">${money(modelSum)}</td>
        <td class="text-right">${money(factSum)}</td>
        <td class="text-right ${Math.abs(modelSum - factSum) > Math.max(factSum, modelSum) * 0.15 ? 'text-warning' : ''}">${money(modelSum - factSum)}</td>
    </tr>`;
    Layout.$('#reconcileBody').innerHTML = rows;
}

// ==================== РАСХОДЫ БЕЗ НАЗНАЧЕНИЯ И ГРУППЫ СТАТЕЙ ====================
async function loadUnassigned() {
    const { data, error } = await Layout.db.rpc('fin_kitchen_unassigned');
    unassigned = error ? [] : (data || []);
}

async function loadGroups() {
    const { data, error } = await Layout.db.rpc('fin_kitchen_cost_groups');
    costGroups = error ? [] : (data || []);
}

function renderUnassigned() {
    const box = Layout.$('#unassignedBlock');
    if (!unassigned.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    Layout.$('#unassignedSummary').textContent = `${tr('cost_unassigned_title', 'Расходы без назначения')}: ${unassigned.length}`;
    Layout.$('#unassignedBody').innerHTML = unassigned.map(x => `
        <div class="border border-base-200 rounded-lg p-3 flex flex-wrap items-center gap-3">
            <div class="flex-1 min-w-[12rem]">
                <div class="font-medium text-sm">${e(x.category_name)} · ${e(fmtDay(x.occurred_on))}</div>
                <div class="text-xs opacity-70">${e(Number(x.amount).toLocaleString())} ${e(x.currency_code)}${x.currency_code !== 'INR' ? ` (≈ ${e(money(x.amount_base))})` : ''}${x.comment ? ' · ' + e(x.comment) : ''}</div>
            </div>
            ${caps.edit ? `
            <button class="btn btn-sm btn-outline" data-action="dest-general" data-id="${x.posting_id}">${e(tr('cost_dest_general', 'Общие расходы'))}</button>
            <div class="flex items-center gap-1">
                <input type="date" class="input input-bordered input-xs" data-dest-from="${x.posting_id}" />
                <input type="date" class="input input-bordered input-xs" data-dest-to="${x.posting_id}" />
                <button class="btn btn-sm btn-primary" data-action="dest-period" data-id="${x.posting_id}">${e(tr('cost_dest_period', 'Период работы'))}</button>
            </div>` : ''}
        </div>`).join('');
}

function renderGroups() {
    const box = Layout.$('#groupsBlock');
    if (!costGroups.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const unconfirmed = costGroups.filter(g => !g.cost_group).length;
    Layout.$('#groupsSummary').textContent = `${tr('cost_groups_title', 'Группы статей расходов кухни')}${unconfirmed ? ` · ${tr('cost_group_unconfirmed', 'не подтверждено')}: ${unconfirmed}` : ''}`;
    Layout.$('#groupsBody').innerHTML = costGroups.map(g => {
        const options = ['direct', 'retreat', 'general', 'excluded'].map(k =>
            `<option value="${k}" ${g.cost_group === k ? 'selected' : ''}>${e(GROUP_LABELS[k]())}</option>`).join('');
        return `<tr class="${g.cost_group ? '' : 'bg-warning/10'}">
            <td class="text-sm">${e(g.name)}</td>
            <td class="text-xs opacity-60 text-right">${g.postings}</td>
            <td class="text-xs opacity-60 text-right">${e(money(g.total_base))}</td>
            <td class="text-right">
                <select class="select select-bordered select-xs" data-group-cat="${g.category_id}" ${caps.edit ? '' : 'disabled'}>
                    ${g.cost_group ? '' : `<option value="" selected>${e(tr('cost_group_unconfirmed_opt', '— не подтверждена —'))}</option>`}
                    ${options}
                </select>
            </td>
        </tr>`;
    }).join('');
}

async function setDestination(postingId, mode, from, to) {
    const { error } = await Layout.db.rpc('fin_set_posting_destination', {
        p_posting_id: postingId, p_mode: mode, p_from: from || null, p_to: to || null });
    if (error) { Layout.showNotification(errorText(error), 'error'); return; }
    Layout.showNotification(t('saved'), 'success');
    await loadUnassigned();
    renderUnassigned();
}

async function saveGroup(categoryId, group) {
    const { error } = await Layout.db.rpc('fin_set_cost_group', { p_category_id: categoryId, p_group: group || null });
    if (error) { Layout.showNotification(errorText(error), 'error'); return; }
    Layout.showNotification(t('saved'), 'success');
    await Promise.all([loadGroups(), loadUnassigned()]);
    renderGroups();
    // группа статьи меняет накладные — пересчитываем
    calculate();
}

// ==================== CONTROLS ====================
function renderControls() {
    document.querySelectorAll('[data-action="mode"]').forEach(a => a.classList.toggle('tab-active', a.dataset.mode === state.mode));
    Layout.$('#retreatControls').classList.toggle('hidden', state.mode !== 'retreat');
    Layout.$('#periodControls').classList.toggle('hidden', state.mode !== 'period');
    document.querySelectorAll('[data-action="step"]').forEach(b => b.classList.toggle('btn-active', b.dataset.step === state.step));
    Layout.$('#retreatSelect').innerHTML = `<option value="">${e(tr('select_retreat', 'Выберите ретрит...'))}</option>` + retreats.map(r =>
        `<option value="${r.id}" ${r.id === state.retreatId ? 'selected' : ''}>${e(Layout.getName(r))} (${e(DateUtils.formatRange(r.start_date, r.end_date))})</option>`).join('');
    Layout.$('#dateFrom').value = state.from;
    Layout.$('#dateTo').value = state.to;
    Layout.$('#periodLabel').textContent = state.from && state.to ? periodLabel(state.from, state.to) : '';
}

function saveState() {
    try { localStorage.setItem('kitchen_cost_view', JSON.stringify({ mode: state.mode, step: state.step, retreatId: state.retreatId, tab: state.tab })); } catch { /* нет хранилища */ }
}

// ==================== EVENTS ====================
document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    switch (btn.dataset.action) {
        case 'mode':
            state.mode = btn.dataset.mode;
            saveState(); renderControls();
            if (state.mode === 'retreat' && !state.retreatId) hideResult(); else calculate();
            break;
        case 'step':
            setStep(btn.dataset.step, state.step === 'custom' ? state.from : state.from);
            saveState(); renderControls(); calculate();
            break;
        case 'shift':
            shiftPeriod(Number(btn.dataset.dir));
            renderControls(); calculate();
            break;
        case 'tab':
            state.tab = btn.dataset.tab;
            saveState();
            if (view) renderTabs();
            break;
        case 'dest-general': setDestination(btn.dataset.id, 'general'); break;
        case 'dest-period': {
            const from = Layout.$(`[data-dest-from="${btn.dataset.id}"]`)?.value;
            const to = Layout.$(`[data-dest-to="${btn.dataset.id}"]`)?.value;
            setDestination(btn.dataset.id, 'period', from, to);
            break;
        }
        case 'kit-remove': saveKit(btn.dataset.meal, btn.dataset.product, 0); break;
        case 'kit-add': {
            const sel = Layout.$(`[data-kit-add-product="${btn.dataset.meal}"]`);
            if (sel?.value) saveKit(btn.dataset.meal, sel.value, 1);
            break;
        }
    }
});

document.addEventListener('change', ev => {
    const groupSelect = ev.target.closest('[data-group-cat]');
    if (groupSelect) { saveGroup(groupSelect.dataset.groupCat, groupSelect.value); return; }
    const input = ev.target.closest('[data-kit-qty]');
    if (input) {
        const qty = parseFloat(input.value);
        if (qty > 0) saveKit(input.dataset.meal, input.dataset.product, qty);
        return;
    }
    if (ev.target.id === 'retreatSelect') {
        state.retreatId = ev.target.value;
        saveState();
        if (state.retreatId) calculate(); else hideResult();
        return;
    }
    if (ev.target.id === 'dateFrom' || ev.target.id === 'dateTo') {
        const from = Layout.$('#dateFrom').value, to = Layout.$('#dateTo').value;
        if (!from || !to || from > to) return;
        state.from = from; state.to = to; state.step = 'custom';
        renderControls(); calculate();
    }
});

function updateUI() {
    Layout.updateAllTranslations();
    renderControls();
    if (view) render();
}
window.onLanguageChange = () => updateUI();

// ==================== INIT ====================
async function init() {
    await Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'cost' });
    await loadCaps();
    if (!caps.view) {
        Layout.$('#noAccess').classList.remove('hidden');
        return;
    }
    locationId = (Layout.locations || []).find(l => l.slug === 'main')?.id || null;
    if (!locationId) { Layout.showNotification(t('error'), 'error'); return; }

    const { data } = await Layout.db.from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date').order('start_date', { ascending: false });
    retreats = data || [];

    // по умолчанию — ретрит, который идёт сейчас или закончился последним
    const today = DateUtils.toISO(new Date());
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kitchen_cost_view') || '{}'); } catch { saved = {}; }
    state.mode = saved.mode === 'period' ? 'period' : 'retreat';
    state.tab = saved.tab || 'eaters';
    const current = retreats.find(r => r.start_date <= today && r.end_date >= today)
        || retreats.find(r => r.end_date < today);
    state.retreatId = retreats.some(r => r.id === saved.retreatId) ? saved.retreatId : (current?.id || '');
    setStep(['month', 'quarter', 'year'].includes(saved.step) ? saved.step : 'month', today);

    Layout.$('#costContent').classList.remove('hidden');
    await Promise.all([loadKits(), loadUnassigned(), loadGroups()]);
    updateUI();
    if (state.mode === 'period' || state.retreatId) calculate();
}

init();

})();
