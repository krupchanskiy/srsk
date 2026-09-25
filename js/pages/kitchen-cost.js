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
// Режим «Ретрит»: участники делятся по статусу на сегодня — уехали / здесь / ожидаются
const PART_BUCKETS = ['guests', 'vips', 'expected'];
const STATUS_ROWS = [
    { status: 'left', label: () => tr('cost_st_left', 'Уже уехали') },
    { status: 'here', label: () => tr('cost_st_here', 'Сейчас на ретрите') },
    { status: 'expected', label: () => tr('expected_guests', 'Ожидаются') }
];
const MEAL_LABELS = { breakfast: () => tr('breakfast', 'Завтрак'), lunch: () => tr('lunch', 'Обед') };
const ALL_BUCKETS = ['team', 'volunteers', 'vips', 'guests', 'groups', 'expected'];

let locationId = null;
let caps = { view: false, edit: false };
let retreats = [];
// section: calc | now | charts | data; tab — вкладка «Расчёта», dataTab — вкладка «Данных»
let state = { mode: 'retreat', step: 'month', retreatId: '', from: '', to: '', section: 'calc', tab: 'eaters', dataTab: 'completeness', cashTab: 'cashMonths' };
const DATA_TABS = ['completeness', 'problems', 'settings'];
let view = null;          // { from, to, result, detail, incomes }
let calcToken = 0;
let kits = { breakfast: [], lunch: [] };
let dishwareProducts = [];
let kitPrices = {};
let unassigned = [];
let costGroups = [];
let reconcileActuals = [];
let reconcileThreshold = 15;  // % — порог подсветки расхождений в сверке (fin_settings, меняет fin_admin)
const retreatSpanCache = new Map();   // retreat_id → { from, to, pm } — где реально ели люди ретрита
let departments = [];                 // справочник департаментов людей (vaishnavas.department_id)
const personDept = new Map();         // vaishnava_id → department_id | null
const personName = new Map();         // vaishnava_id → имя (для списков людей)
const groupNames = new Map();         // meal_groups.id → название группы

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

// Под заголовком ретрита: фактические даты (первый заезд — последний выезд по броням)
// и насколько данные окончательные — что уже прошло, а что прогноз по броням.
function retreatStatusLine(r) {
    const today = DateUtils.toISO(new Date());
    const day = d => DateUtils.parseDate(d).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
    const daysBetween = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 86400000);
    const parts = [];
    if (view.from !== r.start_date || view.to !== r.end_date)
        parts.push(`${tr('cost_actual_dates', 'фактически')} ${DateUtils.formatRange(view.from, view.to)} (${tr('cost_actual_dates_hint', 'первый заезд — последний выезд по броням')})`);
    if (today < view.from) parts.push(tr('cost_status_future', 'ещё не начался — всё прогноз по броням'));
    else if (today > view.to) parts.push(tr('cost_status_done', 'завершён — данные окончательные'));
    else {
        if (today < r.start_date) parts.push(`${tr('cost_status_early', 'ранние заезды, ретрит начнётся')} ${day(r.start_date)}`);
        else if (today > r.end_date) parts.push(tr('cost_status_late', 'ретрит закончился, ещё едят задержавшиеся'));
        else parts.push(`${tr('cost_status_day', 'идёт день')} ${daysBetween(r.start_date, today) + 1} ${tr('cost_status_of', 'из')} ${daysBetween(r.start_date, r.end_date) + 1}`);
        parts.push(`${tr('cost_status_forecast_from', 'с')} ${day(addDays(today, 1))} — ${tr('cost_status_forecast', 'прогноз по броням')}`);
    }
    return parts.join(' · ');
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

// Департамент людей из карточек — для разбивки вкушающих по департаментам
async function loadPersonDepts(ids) {
    const missing = [...new Set(ids)].filter(id => id && !personDept.has(id));
    for (let i = 0; i < missing.length; i += 150) {
        const part = missing.slice(i, i + 150);
        const { data, error } = await Layout.db.from('vaishnavas')
            .select('id, department_id, spiritual_name, first_name, last_name').in('id', part);
        if (error) { console.error('vaishnavas departments:', error); return; }
        part.forEach(id => personDept.set(id, null));
        (data || []).forEach(v => {
            personDept.set(v.id, v.department_id || null);
            personName.set(v.id, v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || '—');
        });
    }
}

async function loadGroupNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !groupNames.has(id));
    if (!missing.length) return;
    const { data } = await Layout.db.from('meal_groups').select('id, name').in('id', missing);
    (data || []).forEach(g => groupNames.set(g.id, g.name));
}

// Доход прасада ретрита — из отчёта по ретриту в финансах (блок «Прасад»). Нет прав — не показываем.
const incomeCache = new Map();
async function retreatIncome(retreatId) {
    if (incomeCache.has(retreatId)) return incomeCache.get(retreatId);
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: retreatId });
    const res = error ? null : data?.result;
    const inc = res?.report?.prasad?.totals?.income_base;
    const v = inc === undefined || inc === null ? null
        : { amount: Number(inc), objectId: res.object_id, groups: (res.report.prasad.income_by_category || []).map(c => c.category_id),
            expense: Number(res.report.prasad.totals.expense_base || 0),
            expenseGroups: (res.report.prasad.expense_by_category || []).map(c => c.category_id) };
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
        const [result, detail, , cash] = await Promise.all([
            KitchenCost.calculate(Layout.db, locationId, from, to),
            loadDetail(from, to),
            loadReconcile(from, to),
            state.mode === 'period' ? loadKitchenCash(from, to) : null
        ]);
        if (token !== calcToken) return;
        await Promise.all([loadPersonDepts(detail.map(x => x.vaishnava_id)),
                           loadGroupNames(detail.filter(x => x.kind === 'group').map(x => x.ref_id))]);

        // доход прасада ретритов: доля по дням питания (человеко-приёмы в окне / за весь ретрит)
        const incomes = {};
        const retreatIds = Object.keys(result.cells).filter(k => k.startsWith('retreat:')).map(k => k.slice(8));
        await Promise.all(retreatIds.map(async id => {
            const r = retreats.find(x => x.id === id);
            if (!r) return;
            const [income, span] = await Promise.all([retreatIncome(id), retreatSpan(r)]);
            // доля — по вкушающим ретрита в окне (не по меню: на будущие дни меню может ещё не быть);
            // в режиме «Ретрит» окно = весь ретрит, доход целиком
            let pmWindow = 0;
            for (const [d, day] of Object.entries(result.counts || {})) {
                if (d < from || d > to) continue;
                for (const m of ['breakfast', 'lunch']) {
                    const b = day.byEvent?.[m]?.[`retreat:${id}`];
                    if (b) pmWindow += ALL_BUCKETS.reduce((s2, k) => s2 + (b[k] || 0), 0);
                }
            }
            const share = state.mode === 'retreat' || !span.pm ? 1 : Math.min(1, pmWindow / span.pm);
            incomes[id] = income === null ? null
                : { full: income.amount, objectId: income.objectId, groups: income.groups, expense: income.expense, expenseGroups: income.expenseGroups, share };
        }));
        if (token !== calcToken) return;

        const postingIds = result.overheadLines.map(l => l.postingId).filter(Boolean);
        const opByPosting = new Map();
        if (postingIds.length) {
            const { data: ops } = await Layout.db.rpc('fin_kitchen_posting_operations', { p_posting_ids: postingIds });
            (ops || []).forEach(o => opByPosting.set(o.posting_id, o.operation_id));
        }
        if (token !== calcToken) return;

        view = { from, to, result, detail, incomes, opByPosting, directPostings: null, incomeOps: {}, expenseOps: {}, now: null, cash };
        expanded.clear();
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
    ['#summaryBox', '#tabsBox', '#kpiBox', '#sectionBar', '#qualityBanner'].forEach(sel => Layout.$(sel).classList.add('hidden'));
}

// ==================== ROWS ====================
// Строка сводки: { key, label, sub?, ev, buckets, retreatId? }
function rowDefs() {
    const cells = view.result.cells;
    if (state.mode === 'retreat') {
        const ev = `retreat:${state.retreatId}`;
        const statuses = new Set(statusOf().values());
        const statusRows = STATUS_ROWS.filter(r => statuses.has(r.status))
            .map(r => ({ key: `${ev}:st:${r.status}`, label: r.label(), ev, buckets: ALL_BUCKETS, status: r.status, sub: true }));
        const subs = ALL_BUCKETS.filter(b => !PART_BUCKETS.includes(b) && cells[ev]?.[b]?.personMeals)
            .map(b => ({ key: `${ev}:${b}`, label: BUCKET_LABELS[b](), ev, buckets: [b], sub: true }));
        return [{ key: ev, label: retreatName(state.retreatId), ev, buckets: ALL_BUCKETS, retreatId: state.retreatId, main: true }, ...statusRows, ...subs];
    }
    const retreatRows = Object.keys(cells).filter(k => k.startsWith('retreat:'))
        .map(ev => ({ key: ev, label: retreatName(ev.slice(8)), ev, buckets: ALL_BUCKETS, retreatId: ev.slice(8) }))
        .sort((a, b) => a.label.localeCompare(b.label, Layout.currentLang));
    const noneRows = NONE_ROWS.map(r => ({ key: r.key, label: r.label(), ev: 'none', buckets: r.buckets }))
        .filter(r => aggregate(cells, 'none', r.buckets).pm);
    return [...retreatRows, ...noneRows];
}

// Статус участника выбранного ретрита на сегодня: есть строка на сегодня — здесь
// (или «ожидается», если заезд не отмечен); все дни в прошлом — уехал; иначе — ожидается.
function statusOf() {
    if (view.statusOf) return view.statusOf;
    const today = DateUtils.toISO(new Date());
    const ev = `retreat:${state.retreatId}`;
    const span = new Map();   // key → { min, max, today: bucket | null }
    for (const x of view.detail) {
        if (`retreat:${x.retreat_id}` !== ev) continue;
        const key = x.vaishnava_id || x.ref_id;
        const p = span.get(key) || { min: x.d, max: x.d, today: null };
        if (x.d < p.min) p.min = x.d;
        if (x.d > p.max) p.max = x.d;
        if (x.d === today) p.today = x.bucket;
        span.set(key, p);
    }
    view.statusOf = new Map([...span].map(([key, p]) => [key,
        p.today ? (p.today === 'expected' ? 'expected' : 'here') : p.max < today ? 'left' : 'expected']));
    return view.statusOf;
}
const rowMatch = (row, x) => !row.status || statusOf().get(x.vaishnava_id || x.ref_id) === row.status;

// Затраты строки: обычная строка — готовые ячейки; строка статуса — по людям,
// все приёмы пищи × стоимость приёма пищи их категории (по статьям), сумма строк = итог
function rowAgg(row) {
    const cells = view.result.cells;
    if (!row.status) return aggregate(cells, row.ev, row.buckets);
    const acc = zero();
    for (const x of view.detail) {
        if (`retreat:${x.retreat_id}` !== row.ev || !row.buckets.includes(x.bucket) || !rowMatch(row, x)) continue;
        const c = cells[row.ev]?.[x.bucket];
        if (!c || !c.personMeals) continue;
        const n = x.kind === 'group' ? (Number(x.people) || 1) : 1;
        const meals = ((x.breakfast ? 1 : 0) + (x.lunch ? 1 : 0)) * n;
        if (!meals) continue;
        const k = meals / c.personMeals;
        acc.pm += meals; acc.food += c.food * k; acc.dish += c.dishware * k; acc.ext += c.external * k;
        acc.ovR += c.overheadRetreat * k; acc.ovG += c.overheadGeneral * k; acc.prov = acc.prov || c.provisional;
    }
    return acc;
}

// люди строки по данным eating_detail: кто ел, только завтраки/обеды, не питался
function peopleStats(row) {
    const persons = new Map();   // key → { bf, ln, n }
    for (const x of view.detail) {
        const ev = x.retreat_id ? `retreat:${x.retreat_id}` : 'none';
        if (ev !== row.ev || !row.buckets.includes(x.bucket) || !rowMatch(row, x)) continue;
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

// ⚠ у суммы — всегда с подсказкой при наведении, что именно не так
function warnMark(ps) {
    if (ps === 'ok') return '';
    const hint = ps === 'none'
        ? tr('cost_w_no_prices_all', 'Цены ещё не внесены ни на один продукт — продукты и посуда считаются как 0')
        : tr('cost_partial_hint', 'Не у всех продуктов есть цена или перевод единиц — см. «Проблемы»');
    return ` <span class="text-warning cursor-help" title="${e(hint)}">⚠</span>`;
}

function pricesState() {
    const r = view.result;
    if (!r.pricesLoaded) return 'none';
    return r.warnings.missingPrices.size || r.warnings.unresolvedUnits.size ? 'partial' : 'ok';
}

// ==================== RENDER ====================
function render() {
    renderQuality();
    renderKpis();
    renderSummary();
    renderTabs();
}

// ---------- Плашка «данные могут быть неточными» ----------
function renderQuality() {
    const w = view.result.warnings;
    const today = DateUtils.toISO(new Date());
    const noMenuPast = w.noMenu.filter(x => x.split(' ')[0] <= today).length;
    const noMenuFuture = w.noMenu.length - noMenuPast;
    // Правило ВГ: каждый пропуск — ссылкой туда, где его исправить
    const reasons = [];
    const link = (text, attrs) => `<a class="link" ${attrs}>${e(text)}</a>`;
    if (!view.result.pricesLoaded) reasons.push(link(tr('cost_q_no_prices', 'цены ещё не внесены — продукты и посуда считаются как 0'), 'href="prices.html"'));
    else if (w.missingPrices.size) reasons.push(link(`${tr('cost_q_some_prices', 'нет цены у продуктов')}: ${w.missingPrices.size}`, 'data-action="tab" data-tab="problems"'));
    if (noMenuPast) reasons.push(link(`${tr('cost_q_menu_past', 'меню не заведено на прошедшие приёмы пищи')}: ${noMenuPast}`, 'data-action="open-no-menu"'));
    if (noMenuFuture) reasons.push(link(`${tr('cost_q_menu_future', 'меню ещё не заведено на предстоящие приёмы пищи')}: ${noMenuFuture}`, 'data-action="open-no-menu"'));
    const monthName = ym => DateUtils.parseDate(ym + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '');
    if (w.payrollEstimated.length) reasons.push(link(`${tr('cost_q_payroll', 'зарплата предварительная, ещё не начислена')}: ${w.payrollEstimated.map(monthName).join(', ')}`, 'data-action="tab" data-tab="overhead"'));
    const box = Layout.$('#qualityBanner');
    if (!reasons.length) { box.classList.add('hidden'); return; }
    box.innerHTML = `<div class="alert alert-warning text-sm items-start">
        <div><div class="font-semibold">⚠ ${e(tr('cost_q_title', 'Данные могут быть неточными'))}</div>
        <ul class="list-disc ml-5 mt-1">${reasons.map(r => `<li>${r}</li>`).join('')}</ul></div>
        <a class="btn btn-sm shrink-0 whitespace-nowrap justify-self-end bg-base-100 border-base-100 hover:bg-base-200" data-action="tab" data-tab="completeness">${e(tr('cost_tab_completeness', 'Полнота данных'))} →</a>
    </div>`;
    box.classList.remove('hidden');
}

// Режим «Ретрит»: касса прасада (реальные деньги) + результат. Себестоимость — в таблице сводки ниже.
function renderCash() {
    const box = Layout.$('#kpiBox');
    box.className = 'grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4';
    const inc = view.incomes[state.retreatId];
    const whole = aggregate(view.result.cells, `retreat:${state.retreatId}`, ALL_BUCKETS);
    const ps = pricesState();
    const card = (label, value, sub, cls = '', action = '') => `<div class="bg-base-100 rounded-xl shadow-sm p-4 ${action ? 'cursor-pointer hover:shadow-md' : ''}" ${action}>
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls}">${value}</div>
        ${sub ? `<div class="text-xs opacity-60 mt-1">${sub}</div>` : ''}</div>`;
    const opsCard = (dir, label, amount, cls, sub) => card(label,
        inc ? `<span class="inline-block w-4 text-base opacity-60">${expanded.has(`cash:${dir}`) ? '▾' : '▸'}</span>${money(amount)}` : '—',
        sub, cls, inc ? `data-action="toggle-cash" data-dir="${dir}"` : '');
    const result = inc ? inc.full - total(whole) : null;
    const cards = [
        opsCard('in', tr('cost_cash_in', 'Получено за прасад'), inc?.full, 'text-blue-600', e(tr('cost_cash_in_hint', 'оплаты участников, по Финансам'))),
        opsCard('out', tr('cost_cash_out', 'Потрачено из кассы на прасад'), inc?.expense, 'text-red-600', e(tr('cost_cash_out_hint', 'расходы, отнесённые в Финансах на прасад ретрита'))),
        card(tr('cost_cash_balance', 'Сальдо'), inc ? money(inc.full - inc.expense) : '—', e(tr('cost_cash_balance_hint', 'получено − потрачено'))),
        card(tr('cost_result', 'Результат'), result === null || ps === 'none' ? '—' : money(result),
            ps === 'none' ? `⚠ <a class="link" href="prices.html">${e(tr('cost_result_after_prices', 'появится после внесения цен'))} →</a>`
                : e(tr('cost_result_hint', 'получено − себестоимость ретрита')),
            result === null || ps === 'none' ? '' : result < 0 ? 'text-error' : 'text-success')
    ];
    const open = ['in', 'out'].find(d => expanded.has(`cash:${d}`));
    const ops = open ? (open === 'in' ? view.incomeOps : view.expenseOps)[state.retreatId] : null;
    box.innerHTML = `<div class="col-span-full text-sm font-semibold uppercase tracking-wide opacity-60 -mb-1">${e(tr('cost_cash_title', 'Касса прасада — реальные деньги'))}</div>
        ${cards.join('')}
        ${open ? `<div class="col-span-full bg-base-100 rounded-xl shadow-sm p-3">
            <div class="text-sm font-medium mb-1">${e(open === 'in' ? tr('cost_income_ops', 'Приходы прасада ретрита') : tr('cost_expense_ops', 'Расходы прасада ретрита'))}</div>
            ${opsTable(ops)}</div>` : ''}`;
}

function renderKpis() {
    if (state.mode === 'retreat') renderCash(); else renderKitchenCash();
}

// ---------- Касса кухни (режим «Период») ----------
// Реальные деньги по датам: пришло за прасад, ушло со счетов «Кухни» (кафе не входит — решение ВГ).
// Остаток переходит из месяца в месяц и из года в год, считается от начала учёта в Финансах.
const CASH_TABS = ['cashMonths', 'cashYears'];
const monthTitle = ym => { const l = DateUtils.parseDate(ym + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', ''); return l.charAt(0).toUpperCase() + l.slice(1); };
const signed = v => `${v > 0 ? '+' : ''}${money(v)}`;
const signCls = v => v < 0 ? 'text-error' : v > 0 ? 'text-success' : '';

async function loadKitchenCash(from, to) {
    const today = DateUtils.toISO(new Date());
    const [all, before, ops] = await Promise.all([
        Layout.db.rpc('fin_kitchen_cash_months', { p_to: to > today ? to : today }),
        Layout.db.rpc('fin_kitchen_cash_months', { p_to: addDays(from, -1) }),
        Layout.db.rpc('fin_kitchen_cash_ops', { p_from: from, p_to: to })
    ]);
    if (all.error || before.error || ops.error) { console.error('Касса кухни:', all.error || before.error || ops.error); return null; }
    const rows = x => (x.data || []).map(m => ({ ym: m.month.slice(0, 7), income: Number(m.income), expense: Number(m.expense) }));
    const list = (ops.data || []).map(o => ({ ...o, amount: Number(o.amount_base) }));
    const sum = dir => list.filter(o => o.dir === dir).reduce((a, o) => a + o.amount, 0);
    const opening = rows(before).reduce((a, m) => a + m.income - m.expense, 0);
    return { months: rows(all), ops: list, opening, income: sum('in'), expense: sum('out') };
}

function renderKitchenCash() {
    const box = Layout.$('#kpiBox');
    const c = view.cash;
    if (!c) { box.classList.add('hidden'); return; }
    box.className = 'grid grid-cols-2 xl:grid-cols-4 gap-3 mb-4';
    const first = c.months[0]?.ym;
    const closing = c.opening + c.income - c.expense;
    const card = (label, value, sub, cls = '', action = '') => `<div class="bg-base-100 rounded-xl shadow-sm p-4 ${action ? 'cursor-pointer hover:shadow-md' : ''}" ${action}>
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls}">${value}</div>
        ${sub ? `<div class="text-xs opacity-60 mt-1">${sub}</div>` : ''}</div>`;
    const opsCard = (dir, label, amount, cls, sub) => card(label,
        `<span class="inline-block w-4 text-base opacity-60">${expanded.has(`kcash:${dir}`) ? '▾' : '▸'}</span>${money(amount)}`,
        sub, cls, `data-action="toggle-kcash" data-dir="${dir}"`);
    const teamNote = tr('cost_kcash_team_note', 'Минус — не обязательно убыток: из этих денег питаются и постоянная команда с волонтёрами, их питание прасадом не оплачивается.');
    const cards = [
        card(tr('cost_kcash_opening', 'Остаток на начало'), signed(c.opening),
            e(first ? `${tr('cost_kcash_on', 'на')} ${fmtDay(view.from)} · ${tr('cost_kcash_since', 'с начала учёта')} (${monthTitle(first).toLowerCase()})` : tr('cost_kcash_no_data', 'в Финансах ещё нет операций')),
            signCls(c.opening)),
        opsCard('in', tr('cost_kcash_in', 'Пришло за прасад'), c.income, 'text-blue-600', e(tr('cost_kcash_in_hint', 'оплаты за питание и пожертвования на прасад'))),
        opsCard('out', tr('cost_kcash_out', 'Ушло с кухни'), c.expense, 'text-red-600', e(tr('cost_kcash_out_hint', 'всё со счетов департамента «Кухня»; траты других департаментов не входят'))),
        card(tr('cost_kcash_closing', 'Остаток на конец'), `<span class="cursor-help" title="${e(teamNote)}">${signed(closing)}</span>`,
            `${e(tr('cost_kcash_for_period', 'за период'))} <span class="${signCls(c.income - c.expense)}">${signed(c.income - c.expense)}</span> · <a class="link" data-action="section" data-section="cash">${e(tr('cost_kcash_movement', 'движение денег'))} →</a>`,
            signCls(closing))
    ];
    const open = ['in', 'out'].find(d => expanded.has(`kcash:${d}`));
    box.innerHTML = `<div class="col-span-full text-sm font-semibold uppercase tracking-wide opacity-60 -mb-1">${e(tr('cost_kcash_title', 'Касса кухни — реальные деньги по датам поступления и оплаты'))}</div>
        ${cards.join('')}
        ${open ? `<div class="col-span-full bg-base-100 rounded-xl shadow-sm p-3">${kitchenCashOps(open)}</div>` : ''}`;
}

// Раскрытие «ёлочкой»: статья → операции со ссылкой в ДДС
function kitchenCashOps(dir) {
    const byCat = new Map();
    for (const o of view.cash.ops.filter(o => o.dir === dir)) (byCat.get(o.category_name) || byCat.set(o.category_name, []).get(o.category_name)).push(o);
    const cats = [...byCat.entries()].map(([name, list]) => ({ name, list, sum: list.reduce((a, o) => a + o.amount, 0) })).sort((a, b) => b.sum - a.sum);
    if (!cats.length) return `<div class="text-sm opacity-60 py-2">${e(tr('fin_drill_empty', 'Операций нет'))}</div>`;
    const rows = cats.map(cat => {
        const key = `kcat:${dir}:${cat.name}`;
        const isOpen = expanded.has(key);
        return `<tr class="cursor-pointer hover:bg-base-200/50 row-top ${isOpen ? 'row-open' : ''}" data-action="toggle-row" data-key="${e(key)}">
            <td>${toggleCell(key)}${e(cat.name)} <span class="text-xs opacity-60">(${cat.list.length})</span></td><td></td>
            <td class="text-right">${money(cat.sum)}</td></tr>${isOpen ? cat.list.map(o => `<tr class="text-sm row-child">
            <td class="pl-8">${o.operation_id ? `<a class="link link-hover" href="${DDS_URL(o.operation_id)}" target="_blank" rel="noopener" title="${e(tr('fin_open_in_dds', 'Открыть в ДДС'))}">${e(o.comment || o.participant || '—')}</a>` : e(o.comment || o.participant || '—')}
                ${o.comment && o.participant ? `<div class="text-xs opacity-60">${e(o.participant)}</div>` : ''}</td>
            <td class="whitespace-nowrap row-muted">${e(fmtDay(o.occurred_on))} · ${e(o.account_name)}</td>
            <td class="text-right">${money(o.amount)}</td></tr>`).join('') : ''}`;
    }).join('');
    return `<div class="text-sm font-medium mb-1">${e(dir === 'in' ? tr('cost_kcash_in', 'Пришло за прасад') : tr('cost_kcash_out', 'Ушло с кухни'))} · ${e(DateUtils.formatRange(view.from, view.to))}</div>
        <div class="overflow-x-auto"><table class="table table-sm w-full cost-table"><tbody>${rows}</tbody></table></div>`;
}

// Раздел «Касса»: движение денег по месяцам (годы выбранного периода) и по годам (все)
function renderCashMovement(byYear) {
    const c = view.cash;
    const body = Layout.$(byYear ? '#cashYearsBody' : '#cashMonthsBody');
    if (!c || !c.months.length) { body.innerHTML = `<tr><td colspan="6" class="text-center opacity-60 py-6">${e(tr('cost_kcash_no_data', 'в Финансах ещё нет операций'))}</td></tr>`; return; }
    // все месяцы подряд от начала учёта (пустые — нулём), остаток нарастающим итогом
    const map = new Map(c.months.map(m => [m.ym, m]));
    const seq = [];
    for (let ym = c.months[0].ym; ym <= c.months[c.months.length - 1].ym; ym = addDays(ym + '-01', 32).slice(0, 7)) seq.push(map.get(ym) || { ym, income: 0, expense: 0 });
    let bal = 0;
    const rows = seq.map(m => { const r = { key: m.ym, open: bal, income: m.income, expense: m.expense }; bal += m.income - m.expense; r.close = bal; return r; });
    let list = rows;
    if (byYear) {
        const ys = new Map();
        for (const r of rows) {
            const y = r.key.slice(0, 4);
            const a = ys.get(y) || ys.set(y, { key: y, open: r.open, income: 0, expense: 0, close: 0 }).get(y);
            a.income += r.income; a.expense += r.expense; a.close = r.close;
        }
        list = [...ys.values()];
    } else {
        const y1 = view.from.slice(0, 4), y2 = view.to.slice(0, 4);
        list = rows.filter(r => r.key.slice(0, 4) >= y1 && r.key.slice(0, 4) <= y2);
    }
    const inPeriod = r => byYear ? r.key >= view.from.slice(0, 4) && r.key <= view.to.slice(0, 4) : r.key >= view.from.slice(0, 7) && r.key <= view.to.slice(0, 7);
    body.innerHTML = list.map(r => `<tr class="${inPeriod(r) ? 'row-open' : ''}">
        <td class="font-medium">${e(byYear ? r.key : monthTitle(r.key))}</td>
        <td class="text-right ${signCls(r.open)}">${signed(r.open)}</td>
        <td class="text-right text-blue-600">${money(r.income)}</td>
        <td class="text-right text-red-600">${money(r.expense)}</td>
        <td class="text-right ${signCls(r.income - r.expense)}">${signed(r.income - r.expense)}</td>
        <td class="text-right font-semibold ${signCls(r.close)}">${signed(r.close)}</td></tr>`).join('');
}

function renderSummary() {
    const cells = view.result.cells;
    const ps = pricesState();
    const r = state.mode === 'retreat' ? retreats.find(x => x.id === state.retreatId) : null;
    // «Ретрит»: вместо строк статуса (они — на «Вкушающих») одна строка «Участники», если есть команда/волонтёры ретрита
    const rows = rowDefs().filter(x => !x.status);
    if (r && rows.length > 1) rows.splice(1, 0, { key: `${rows[0].ev}:part`, label: tr('cost_row_participants', 'Участники'),
        ev: rows[0].ev, buckets: PART_BUCKETS, sub: true });
    Layout.$('#summaryKicker').classList.toggle('hidden', !r);
    // ретрит идёт — под «Всего» показываем, сколько съедено на сегодня
    const running = r && view.from <= DateUtils.toISO(new Date()) && DateUtils.toISO(new Date()) <= view.to;
    if (running && !view.now) loadNow().then(() => view && renderSummary()).catch(err => console.error('На сегодня:', err));
    const title = r
        ? `${retreatName(state.retreatId)} · ${DateUtils.formatRange(r.start_date, r.end_date)}`
        : periodLabel(view.from, view.to);
    Layout.$('#summaryTitle').textContent = title;
    const sub = r ? retreatStatusLine(r) : '';
    Layout.$('#summarySub').textContent = sub;
    Layout.$('#summarySub').classList.toggle('hidden', !sub);

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
        ${isPeriod ? `<th class="text-right">${e(tr('cost_income', 'Доход прасада'))}</th>
        <th class="text-right">${e(tr('cost_result', 'Результат'))}</th>` : ''}
    </tr>`;

    const directCell = x => ps === 'none' ? `<span class="opacity-50">${e(tr('cost_no_prices', 'нет цен'))}</span>`
        : `${money(direct(x))}${warnMark(ps)}`;
    const grand = zero();
    let grandIncome = 0, anyIncome = false;
    const html = rows.map(row => {
        const x = rowAgg(row);
        if (!row.sub) Object.keys(grand).forEach(k => { if (k !== 'prov') grand[k] += x[k]; });
        const st = peopleStats(row);
        const inc = row.retreatId ? view.incomes[row.retreatId] : undefined;
        const income = inc ? inc.full * inc.share : null;
        if (income !== null && !row.sub) { grandIncome += income; anyIncome = true; }
        const perPart = row.retreatId && st.participants ? total(x) / st.participants : null;
        const days = isPeriod ? daysOf(row) : null;
        const cls = row.sub ? 'text-sm' : 'font-medium';
        const deptBucket = row.ev === 'none' && (row.buckets[0] === 'team' || row.buckets[0] === 'volunteers') ? row.buckets[0] : null;
        return `<tr class="${row.main ? 'bg-base-200/60 font-semibold' : ''} ${deptBucket ? 'cursor-pointer hover:bg-base-200/50' : ''}" ${deptBucket ? `data-action="open-dept" data-bucket="${deptBucket}" title="${e(tr('cost_to_departments', 'По департаментам →'))}"` : ''}>
            <td class="${cls} ${row.sub ? 'pl-8' : ''}">${deptBucket ? `<span class="link link-hover">${e(row.label)}</span>` : e(row.label)}${inc && inc.share < 0.999 ? ` <span class="text-xs opacity-60">(${Math.round(inc.share * 100)}% ${e(tr('cost_of_retreat', 'ретрита'))})</span>` : ''}</td>
            ${isPeriod ? `<td class="text-right text-sm">${days}</td>` : ''}
            <td class="text-right">${st.people ? num(st.people) : '—'}</td>
            <td class="text-right">${num(x.pm)}</td>
            <td class="text-right">${directCell(x)}</td>
            <td class="text-right">${money(overhead(x))}</td>
            <td class="text-right font-medium">${money(total(x))}${row.main && running && view.now?.toDate
                ? `<div class="text-xs font-normal opacity-60">${e(tr('cost_eaten_today', 'съедено на сегодня'))}: ${money(total(view.now.toDate))}</div>` : ''}</td>
            <td class="text-right">${x.pm ? money2(total(x) / x.pm) : '—'}</td>
            <td class="text-right">${perPart !== null && !row.sub ? money(perPart) : '—'}</td>
            ${isPeriod ? `<td class="text-right">${income !== null && !row.sub
                ? `<span class="link link-hover" data-action="toggle-income" data-retreat="${row.retreatId}" title="${e(tr('cost_show_income', 'Показать приходы'))}">${money(income)}</span>` : '—'}</td>
            <td class="text-right">${resultCell(income, x, row.sub, ps)}</td>` : ''}
        </tr>${row.retreatId && !row.sub && expanded.has(`income:${row.retreatId}`) ? `<tr><td colspan="11" class="bg-base-200/40 pl-8">
            <div class="text-sm font-medium mb-1">${e(tr('cost_income_ops', 'Приходы прасада ретрита'))}${inc && inc.share < 0.999 ? ` <span class="opacity-60">(${e(tr('cost_income_whole', 'весь ретрит; в период входит'))} ${Math.round(inc.share * 100)}%)</span>` : ''}</div>
            ${opsTable(view.incomeOps[row.retreatId])}</td></tr>` : ''}`;
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
    if (t2.overheadUnallocated > 0.5) lost.push(`${tr('cost_overhead_unallocated2', 'Накладные расходы за период, где не было ни одного вкушающего (не распределены)')}: ${money(t2.overheadUnallocated)}`);
    const lostHtml = lost.length && isPeriod
        ? lost.map(l => `<tr class="text-warning text-sm"><td colspan="11">${e(l)}</td></tr>`).join('') : '';

    Layout.$('#summaryBody').innerHTML = (html || `<tr><td colspan="11" class="text-center opacity-60 py-6">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`) + grandHtml + lostHtml;
    Layout.$('#summaryNote').textContent = isPeriod
        ? tr('cost_summary_note_period', 'Ретрит, который захватывает несколько месяцев, входит в период своей долей: расходы — по дням, доход прасада — по доле приёмов пищи. «На участника» — стоимость ретрита на одного участника без команды и волонтёров.')
        : tr('cost_summary_note_retreat', 'Ретрит целиком, включая дни раннего заезда и позднего выезда его участников, до конца — по броням. «На участника» — вся стоимость ретрита на одного участника без постоянной команды и волонтёров (они — на вкладке «Команда и волонтёры»).');
    Layout.$('#summaryBox').classList.remove('hidden');
}

function resultCell(income, x, sub, ps) {
    if (sub || income === null) return '—';
    if (ps === 'none') return `<span class="opacity-50" title="${e(tr('cost_result_no_prices', 'Пока нет цен, себестоимость занижена — результат не показываем'))}">—</span>`;
    const r = income - total(x);
    return `<span class="${r < 0 ? 'text-error' : 'text-success'} font-medium">${money(r)}</span>${warnMark(ps)}`;
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
// Правило (ВГ 24.09.2026): каждый в команде и каждый волонтёр принадлежит департаменту
function noDeptPeople() {
    const seen = new Map();
    for (const x of view.detail) {
        if (!x.vaishnava_id || (x.bucket !== 'team' && x.bucket !== 'volunteers')) continue;
        if (x.retreat_id) continue;   // приехал под ретрит — питание на ретрите, департамент не нужен
        if (!x.breakfast && !x.lunch) continue;
        if (personDept.get(x.vaishnava_id)) continue;
        seen.set(x.vaishnava_id, x.bucket);
    }
    return [...seen.entries()].map(([id, b]) => `${personName.get(id) || '—'} (${BUCKET_LABELS[b]().toLowerCase()})`)
        .sort((a, b) => a.localeCompare(b, 'ru'));
}

function problemCount() {
    const w = view.result.warnings;
    return w.missingPrices.size + w.unresolvedUnits.size + w.noMenu.length + w.noEaters.length
        + w.overheadNoBase.length + w.overheadUnallocated.length + w.laborUnlinked.length + w.recipesNoOutput.size
        + (w.overheadError ? 1 : 0) + (w.payrollEstimated.length ? 1 : 0) + (noDeptPeople().length ? 1 : 0);
}

function sectionList() {
    const problems = problemCount();
    return [
        { id: 'calc', label: tr('cost_section_calc', 'Расчёт') },
        state.mode === 'period' ? { id: 'cash', label: tr('cost_section_cash', 'Касса') } : null,
        { id: 'charts', label: tr('cost_section_charts', 'Графики') },
        { id: 'data', label: `${tr('cost_section_data', 'Данные')}${problems ? ` (${problems})` : ''}`, warn: problems > 0 }
    ].filter(Boolean);
}

function tabList() {
    if (state.section === 'data') {
        const problems = problemCount();
        return [
            { id: 'completeness', label: tr('cost_tab_completeness', 'Полнота данных') },
            { id: 'problems', label: `${tr('cost_tab_problems', 'Проблемы')}${problems ? ` (${problems})` : ''}`, warn: problems > 0 },
            { id: 'settings', label: tr('cost_tab_settings', 'Настройки расчёта') }
        ];
    }
    if (state.section === 'cash') return [
        { id: 'cashMonths', label: tr('cost_tab_cash_months', 'По месяцам') },
        { id: 'cashYears', label: tr('cost_tab_cash_years', 'По годам') }
    ];
    if (state.section !== 'calc') return [];
    return [
        { id: 'eaters', label: tr('cost_tab_eaters', 'Вкушающие') },
        { id: 'departments', label: tr('cost_tab_departments', 'Команда и волонтёры') },
        { id: 'direct', label: tr('cost_tab_direct', 'Прямые затраты') },
        { id: 'overhead', label: tr('cost_tab_overhead', 'Накладные') },
        // сверка — проверка всей кухни: закупки в ДДС не помечены ретритом, поэтому только в «Периоде»
        state.mode === 'period' ? { id: 'reconcile', label: tr('cost_reconcile_title', 'Сверка с ДДС') } : null
    ].filter(Boolean);
}

function renderTabs() {
    const sections = sectionList();
    if (!sections.some(x => x.id === state.section)) state.section = 'calc';
    Layout.$('#sectionBar').innerHTML = sections.map(x =>
        `<a role="tab" class="tab ${x.id === state.section ? 'tab-active' : ''} ${x.warn && x.id !== state.section ? 'text-warning' : ''}" data-action="section" data-section="${x.id}">${e(x.label)}</a>`).join('');
    Layout.$('#sectionBar').classList.remove('hidden');
    Layout.$('#summaryBox').classList.toggle('hidden', state.section !== 'calc');

    const tabs = tabList();
    const cur = state.section === 'data' ? 'dataTab' : state.section === 'cash' ? 'cashTab' : 'tab';
    if (tabs.length && !tabs.some(x => x.id === state[cur])) state[cur] = tabs[0].id;
    Layout.$('#tabBar').innerHTML = tabs.map(x =>
        `<a role="tab" class="tab ${x.id === state[cur] ? 'tab-active [--tab-bg:oklch(var(--b1))]' : ''} ${x.warn ? 'text-warning' : ''}" data-action="tab" data-tab="${x.id}">${e(x.label)}${HOW_SECTIONS[x.id] ? `<span class="how-q" data-action="how" data-sec="${HOW_SECTIONS[x.id]}" title="${e(tr('cost_how_q_hint', 'Нажмите, чтобы открыть подсказку: как считается'))}">?</span>` : ''}</a>`).join('');
    Layout.$('#tabBar').classList.toggle('hidden', !tabs.length);
    const panel = state.section === 'calc' ? state.tab : state.section === 'data' ? state.dataTab : state.section === 'cash' ? state.cashTab : state.section;
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== panel));
    Layout.$('#tabsBox').classList.remove('hidden');
    ({ eaters: renderEaters, departments: renderDepartments, direct: renderDirect, overhead: renderOverhead,
       reconcile: renderReconcile, settings: () => { renderKits(); renderThreshold(); renderGroups(); }, problems: renderWarnings,
       completeness: renderCompleteness, charts: renderCharts,
       cashMonths: () => renderCashMovement(false), cashYears: () => renderCashMovement(true) })[panel]?.();
}

// ---------- Полнота данных ----------
// Насколько можно доверять цифрам: что заполнено и что ещё нет. Каждая строка ведёт туда, где заполняют.
function renderCompleteness() {
    const r = view.result, w = r.warnings;
    const usedProducts = Object.keys(r.productNames || {}).length;
    const served = r.mealRecords.filter(m => !m.unallocated).length;
    const teamVol = new Map();
    for (const x of view.detail) {
        if (!x.vaishnava_id || (x.bucket !== 'team' && x.bucket !== 'volunteers') || (!x.breakfast && !x.lunch)) continue;
        if (x.retreat_id) continue;   // приехал под ретрит — департамент не нужен
        teamVol.set(x.vaishnava_id, !!personDept.get(x.vaishnava_id));
    }
    const months = new Set();
    for (let f = view.from.slice(0, 7) + '-01'; f <= view.to; f = addDays(monthEnd(f), 1)) months.add(f.slice(0, 7));
    const confirmed = costGroups.filter(g => g.cost_group).length;
    const items = [
        { label: tr('cost_c_prices', 'Цены продуктов из меню и посуды'), ok: usedProducts - w.missingPrices.size, total: usedProducts,
          href: 'prices.html', link: tr('nav_prices', 'Цены') },
        { label: tr('cost_c_units', 'Продукты, у которых сходятся единицы (плотность, вес штуки)'), ok: usedProducts - w.unresolvedUnits.size, total: usedProducts,
          href: 'products.html', link: tr('nav_products', 'Продукты') },
        { label: tr('cost_c_output', 'Рецепты с указанным выходом'), ok: (r.recipesUsed || 0) - w.recipesNoOutput.size, total: r.recipesUsed || 0,
          href: 'recipes.html', link: tr('nav_recipes', 'Рецепты') },
        { label: tr('cost_c_menu', 'Приёмы пищи, заведённые в меню'), ok: served, total: served + w.noMenu.length,
          href: 'menu.html', link: tr('nav_menu', 'Меню') },
        { label: tr('cost_c_depts', 'Команда и волонтёры с департаментом'), ok: [...teamVol.values()].filter(Boolean).length, total: teamVol.size,
          tab: 'problems', link: tr('cost_tab_problems', 'Проблемы') },
        { label: tr('cost_c_groups', 'Статьи расходов кухни с подтверждённой группой'), ok: confirmed, total: costGroups.length,
          tab: 'settings', link: tr('cost_tab_settings', 'Настройки расчёта') },
        { label: tr('cost_c_payroll', 'Месяцы с начисленной зарплатой (не оценкой)'), ok: months.size - w.payrollEstimated.filter(m => months.has(m)).length, total: months.size,
          href: '../finance/payroll.html', link: tr('fin_payroll', 'Зарплаты') },
        { label: tr('cost_c_unassigned', 'Расходы «на ретрит» с назначением'), ok: unassigned.length ? 0 : 1, total: 1, count: unassigned.length,
          tab: 'overhead', link: tr('cost_tab_overhead', 'Накладные') }
    ];
    Layout.$('#completenessBody').innerHTML = items.map(it => {
        const pct = it.total ? Math.round(it.ok / it.total * 100) : 100;
        const cls = pct >= 95 ? 'progress-success' : pct >= 60 ? 'progress-warning' : 'progress-error';
        const figure = it.count !== undefined ? (it.count ? `${it.count} ${tr('cost_c_without', 'без назначения')}` : tr('cost_c_all_ok', 'всё назначено'))
            : `${num(it.ok)} ${tr('cost_c_of', 'из')} ${num(it.total)}`;
        const go = it.href ? `<a class="link text-sm" href="${it.href}">${e(it.link)} →</a>`
            : `<a class="link text-sm" data-action="tab" data-tab="${it.tab}">${e(it.link)} →</a>`;
        return `<div class="grid grid-cols-1 md:grid-cols-[1fr_12rem_6rem_9rem] items-center gap-2 md:gap-4 py-2 border-b border-base-200">
            <div class="text-sm">${e(it.label)}</div>
            <progress class="progress ${cls} w-full" value="${pct}" max="100"></progress>
            <div class="text-sm font-medium md:text-right">${pct}% <span class="opacity-60 font-normal">· ${e(figure)}</span></div>
            <div class="md:text-right">${pct < 100 ? go : ''}</div>
        </div>`;
    }).join('');
}

// ---------- Ретрит сейчас ----------
// Потрачено на сегодня (расчёт с начала по сегодня) и прогноз до конца: оставшиеся приёмы пищи
// людей ретрита (по броням и регистрациям) × стоимость приёма пищи на сегодня.
// Ретрит идёт: себестоимость с начала ретрита по сегодня (для «съедено на сегодня» в сводке)
function loadNow() {
    if (view.nowLoading) return view.nowLoading;
    const v = view, today = DateUtils.toISO(new Date());
    v.nowLoading = KitchenCost.calculate(Layout.db, locationId, v.from, today)
        .then(res => { v.now = { toDate: aggregate(res.cells, `retreat:${state.retreatId}`, ALL_BUCKETS) }; });
    return v.nowLoading;
}

// ---------- Графики ----------
const CHART_JS = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
let chartLib = null;
const charts = [];
const BUCKET_COLORS = { team: '#10b981', volunteers: '#f59e0b', vips: '#f76a3b', guests: '#3b82f6', groups: '#8b5cf6', expected: '#94a3b8' };
const RETREAT_COLORS = ['#8b5cf6', '#ec4899', '#14b8a6', '#6366f1', '#84cc16', '#0ea5e9'];
const PART_COLORS = { food: '#f49800', dish: '#fbbf24', ext: '#fb7185', ov: '#64748b' };

function loadChartLib() {
    if (window.Chart) return Promise.resolve(window.Chart);
    if (chartLib) return chartLib;
    chartLib = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = CHART_JS; sc.onload = () => res(window.Chart); sc.onerror = rej;
        document.head.appendChild(sc);
    });
    return chartLib;
}

function chartCard(id, title, note) {
    return `<div class="bg-base-100 border border-base-200 rounded-xl p-4">
        <div class="font-semibold mb-1">${e(title)}</div>
        ${note ? `<div class="text-xs opacity-60 mb-2">${e(note)}</div>` : ''}
        <div class="relative h-72"><canvas id="${id}"></canvas></div></div>`;
}
const emptyCard = (title, text) => `<div class="bg-base-100 border border-base-200 rounded-xl p-4">
    <div class="font-semibold mb-1">${e(title)}</div><div class="h-72 flex items-center justify-center text-sm opacity-60 text-center px-6">${e(text)}</div></div>`;

async function renderCharts() {
    const box = Layout.$('#chartsBody');
    box.innerHTML = `<div class="py-6 text-center col-span-full"><span class="loading loading-spinner"></span></div>`;
    let Chart;
    try { Chart = await loadChartLib(); } catch { box.innerHTML = `<div class="alert alert-error text-sm">${e(tr('cost_charts_load_error', 'Не удалось загрузить графики'))}</div>`; return; }
    if (!view || state.section !== 'charts') return;
    charts.splice(0).forEach(c => c.destroy());

    const scope = scopeEvents();
    const ps = pricesState();
    const monthKeys = Object.keys(view.result.months || {}).sort();
    // «Август 2026», а не «авг. 26» — иначе 26 читается как число месяца
    const monthLabel = ym => { const l = DateUtils.parseDate(ym + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', ''); return l.charAt(0).toUpperCase() + l.slice(1); };
    const inScope = ev => !scope || scope.includes(ev);
    const parts = [];

    // 1. Стоимость приёма пищи по месяцам
    const mData = monthKeys.map(ym => {
        const acc = zero();
        for (const [ev, byB] of Object.entries(view.result.months[ym])) {
            if (!inScope(ev)) continue;
            for (const c of Object.values(byB)) addCell(acc, c);
        }
        return acc;
    });
    parts.push(monthKeys.length > 1 ? chartCard('chMonths', tr('cost_ch_months', 'Расходы на питание по месяцам'), tr('cost_ch_months_note', 'Столбик — сколько потрачено за месяц и из чего (цвета — в подписи снизу). Под месяцем — стоимость одного приёма пищи: расход месяца ÷ число приёмов пищи. Наведите на столбик — подробности.'))
        : emptyCard(tr('cost_ch_months', 'Расходы на питание по месяцам'), tr('cost_ch_need_months', 'Выберите период длиннее месяца — квартал или год')));

    // 2. Вкушающие по дням
    parts.push(chartCard('chDays', tr('cost_ch_days', 'Вкушающие по дням'), tr('cost_ch_days_note', 'Сколько человек ело в день (больше из завтрака и обеда)')));

    // 3. Топ-10 продуктов
    const byProduct = {};
    for (const rec of view.result.mealRecords) {
        if (rec.date < view.from || rec.date > view.to || !rec.eaters) continue;
        let share = 1;
        if (scope) share = Object.entries(rec.byEvent).filter(([ev]) => scope.includes(ev))
            .reduce((s, [, b]) => s + ALL_BUCKETS.reduce((x, k) => x + (b[k] || 0), 0), 0) / rec.eaters;
        for (const [pid, c] of Object.entries(rec.foodByProduct || {})) byProduct[pid] = (byProduct[pid] || 0) + c * share;
    }
    const top = Object.entries(byProduct).sort((a, b) => b[1] - a[1]).slice(0, 10);
    parts.push(top.length ? chartCard('chTop', tr('cost_ch_top', 'Топ-10 продуктов по деньгам'), tr('cost_ch_top_note', 'Сколько ушло на продукт по рецептам меню'))
        : emptyCard(tr('cost_ch_top', 'Топ-10 продуктов по деньгам'), ps === 'none' ? tr('cost_ch_need_prices', 'Появится, когда будут внесены цены') : tr('cost_nothing', 'За период нет данных')));

    // 4. Окупаемость ретритов
    const payRows = rowDefs().filter(r => r.retreatId && !r.sub).map(r => {
        const inc = view.incomes[r.retreatId];
        return { label: r.label, cost: total(aggregate(view.result.cells, r.ev, r.buckets)), income: inc ? inc.full * inc.share : null };
    }).filter(r => r.income !== null);
    parts.push(payRows.length ? chartCard('chPay', tr('cost_ch_payback', 'Окупаемость ретритов'), ps === 'none' ? tr('cost_ch_payback_noprices', 'Пока нет цен — себестоимость занижена') : tr('cost_ch_payback_note', 'Доход прасада против себестоимости'))
        : emptyCard(tr('cost_ch_payback', 'Окупаемость ретритов'), tr('cost_ch_no_retreat_income', 'В периоде нет ретритов с доходом прасада')));

    // 5. Закупки оборудования и инвентаря по месяцам
    const eq = {};
    for (const l of view.result.overheadLines) {
        if (!l.occurredOn || !/оборуд|инвентар/i.test(l.category || '')) continue;
        if (l.occurredOn < view.from || l.occurredOn > view.to) continue;
        const ym = l.occurredOn.slice(0, 7);
        (eq[ym] = eq[ym] || {})[l.category] = ((eq[ym] || {})[l.category] || 0) + l.amount;
    }
    const eqMonths = Object.keys(eq).sort();
    parts.push(eqMonths.length ? chartCard('chEquip', tr('cost_ch_equipment', 'Закупки оборудования и инвентаря'), tr('cost_ch_equipment_note', 'Покупки кухни по месяцам, по статьям'))
        : emptyCard(tr('cost_ch_equipment', 'Закупки оборудования и инвентаря'), tr('cost_ch_no_equipment', 'В периоде закупок оборудования нет')));

    box.innerHTML = parts.join('');
    const money0 = v => Number(v).toLocaleString(locale(), { maximumFractionDigits: 0 }) + ' ₹';
    const base = { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } } };
    const moneyTip = { callbacks: { label: c => `${c.dataset.label}: ${money0(c.parsed.y ?? c.parsed.x)}` } };

    // стоимость приёма пищи — второй строкой подписи под столбиком (линия между месяцами путала)
    const perMealText = x => x.pm ? `${money2(total(x) / x.pm)} ${tr('cost_ch_per_meal_short', 'за приём пищи')}` : '';
    if (monthKeys.length > 1) charts.push(new Chart(document.getElementById('chMonths'), {
        type: 'bar',
        data: { labels: monthKeys.map((ym, i) => [monthLabel(ym), perMealText(mData[i])]), datasets: [
            { type: 'bar', label: tr('cost_food', 'Продукты'), data: mData.map(x => x.food), backgroundColor: PART_COLORS.food, stack: 's' },
            { type: 'bar', label: tr('cost_dishware', 'Посуда'), data: mData.map(x => x.dish), backgroundColor: PART_COLORS.dish, stack: 's' },
            { type: 'bar', label: tr('cost_external', 'Готовое'), data: mData.map(x => x.ext), backgroundColor: PART_COLORS.ext, stack: 's' },
            { type: 'bar', label: tr('cost_overhead', 'Накладные'), data: mData.map(x => overhead(x)), backgroundColor: PART_COLORS.ov, stack: 's' }
        ] },
        options: { ...base, plugins: { ...base.plugins, tooltip: { callbacks: { ...moneyTip.callbacks,
                footer: items => { const x = mData[items[0].dataIndex];
                    return [`${tr('cost_total', 'Всего')}: ${money0(total(x))}`, `${num(x.pm)} ${tr('cost_person_meals', 'приёмов пищи').toLowerCase()}`, perMealText(x)]; } } } },
            scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: money0 } } } }
    }));

    // вкушающие по дням: ряды — ретриты (каждый своим цветом) и категории людей без события
    const dayKeys = Object.keys(view.result.counts || {}).filter(d => d >= view.from && d <= view.to).sort();
    const series = new Map();
    const addPoint = (key, label, color, i, v) => {
        const sr = series.get(key) || (series.set(key, { label, color, data: dayKeys.map(() => 0) }), series.get(key));
        sr.data[i] += v;
    };
    const retreatKeys = [...new Set(dayKeys.flatMap(d => Object.keys(view.result.counts[d].byEvent?.lunch || {}).concat(Object.keys(view.result.counts[d].byEvent?.breakfast || {}))))]
        .filter(k => k.startsWith('retreat:') && inScope(k));
    dayKeys.forEach((d, i) => {
        const day = view.result.counts[d].byEvent || {};
        const evs = new Set([...Object.keys(day.breakfast || {}), ...Object.keys(day.lunch || {})]);
        for (const ev of evs) {
            if (!inScope(ev)) continue;
            const bf = day.breakfast?.[ev] || {}, ln = day.lunch?.[ev] || {};
            if (ev === 'none' || scope) {
                for (const k of ALL_BUCKETS) {
                    const v = Math.max(bf[k] || 0, ln[k] || 0);
                    if (!v) continue;
                    const label = ev === 'none' ? (NONE_ROWS.find(r => r.buckets.includes(k))?.label() || k) : BUCKET_LABELS[k]();
                    addPoint(`${ev}|${k === 'vips' && ev === 'none' ? 'guests' : k}`, label, BUCKET_COLORS[k], i, v);
                }
            } else {
                const v = Math.max(ALL_BUCKETS.reduce((s, k) => s + (bf[k] || 0), 0), ALL_BUCKETS.reduce((s, k) => s + (ln[k] || 0), 0));
                addPoint(ev, retreatName(ev.slice(8)), RETREAT_COLORS[retreatKeys.indexOf(ev) % RETREAT_COLORS.length], i, v);
            }
        }
    });
    charts.push(new Chart(document.getElementById('chDays'), {
        type: 'bar',
        data: { labels: dayKeys.map(d => fmtDay(d).replace(/ \d{4}$/, '')), datasets: [...series.values()].map(sr => ({ label: sr.label, data: sr.data, backgroundColor: sr.color, stack: 's' })) },
        options: { ...base, scales: { x: { stacked: true, ticks: { maxTicksLimit: 12 } }, y: { stacked: true } } }
    }));

    if (top.length) charts.push(new Chart(document.getElementById('chTop'), {
        type: 'bar',
        data: { labels: top.map(([pid]) => view.result.productNames[pid] || pid), datasets: [{ label: tr('cost_food', 'Продукты'), data: top.map(([, v]) => v), backgroundColor: PART_COLORS.food }] },
        options: { ...base, indexAxis: 'y', plugins: { legend: { display: false }, tooltip: moneyTip }, scales: { x: { ticks: { callback: money0 } } } }
    }));

    if (payRows.length) charts.push(new Chart(document.getElementById('chPay'), {
        type: 'bar',
        data: { labels: payRows.map(r => r.label), datasets: [
            { label: tr('cost_income', 'Доход прасада'), data: payRows.map(r => r.income), backgroundColor: '#10b981' },
            { label: tr('cost_total', 'Себестоимость'), data: payRows.map(r => r.cost), backgroundColor: PART_COLORS.food }
        ] },
        options: { ...base, plugins: { ...base.plugins, tooltip: moneyTip }, scales: { y: { ticks: { callback: money0 } } } }
    }));

    if (eqMonths.length) {
        const cats = [...new Set(eqMonths.flatMap(ym => Object.keys(eq[ym])))];
        const catColors = ['#475569', '#0ea5e9', '#a855f7', '#f97316'];
        charts.push(new Chart(document.getElementById('chEquip'), {
            type: 'bar',
            data: { labels: eqMonths.map(monthLabel), datasets: cats.map((c, i) => ({ label: c, data: eqMonths.map(ym => eq[ym][c] || 0), backgroundColor: catColors[i % catColors.length], stack: 's' })) },
            options: { ...base, plugins: { ...base.plugins, tooltip: moneyTip }, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: money0 } } } }
        }));
    }
}

// ---------- Вкушающие ----------
function scopeEvents() {
    return state.mode === 'retreat' ? [`retreat:${state.retreatId}`] : null;   // null — все события
}

// Люди по строкам детализации: кто, сколько дней ел, завтраков, обедов, приёмов пищи и во что обошёлся.
// Стоимость человека = все его приёмы пищи × стоимость одного приёма пищи его ячейки
// (ретрит или «без события» × категория), поэтому сумма по людям = итог сводки.
function personRows(match) {
    const cells = view.result.cells;
    const rate = {};
    const rateOf = (ev, bucket) => {
        const k = `${ev}|${bucket}`;
        if (!(k in rate)) { const x = aggregate(cells, ev, [bucket]); rate[k] = x.pm ? total(x) / x.pm : 0; }
        return rate[k];
    };
    const people = new Map();
    for (const x of view.detail) {
        const ev = x.retreat_id ? `retreat:${x.retreat_id}` : 'none';
        if (!match(x, ev)) continue;
        const key = x.vaishnava_id || x.ref_id;
        const n = x.kind === 'group' ? (Number(x.people) || 1) : 1;
        const p = people.get(key) || { key, vaishnavaId: x.vaishnava_id, kind: x.kind, refId: x.ref_id, bucket: x.bucket,
                                       n, days: new Set(), bf: 0, ln: 0, pm: 0, cost: 0 };
        p.n = Math.max(p.n, n);
        if (x.breakfast || x.lunch) p.days.add(x.d);
        if (x.breakfast) p.bf += n;
        if (x.lunch) p.ln += n;
        const meals = (x.breakfast ? 1 : 0) + (x.lunch ? 1 : 0);
        p.pm += meals * n;
        p.cost += meals * n * rateOf(ev, x.bucket);
        people.set(key, p);
    }
    return [...people.values()];
}

function personLabel(p) {
    if (p.vaishnavaId) return personName.get(p.vaishnavaId) || '—';
    if (p.kind === 'group') return `${groupNames.get(p.refId) || tr('nav_groups', 'Группа')} (${p.n} ${tr('cost_people_short', 'чел.')})`;
    return tr('cost_unnamed_booking', 'Бронь без имени');
}

// Вложенная таблица людей для раскрытой строки
function peopleTable(list, withBucket) {
    if (!list.length) return `<div class="text-sm opacity-60 py-2">${e(tr('cost_nothing', 'За период нет данных'))}</div>`;
    const ps = pricesState();
    list.sort((a, b) => b.pm - a.pm || personLabel(a).localeCompare(personLabel(b), 'ru'));
    return `<table class="table table-xs w-full cost-table bg-base-100">
        <thead><tr><th>${e(tr('name', 'Имя'))}</th>${withBucket ? `<th></th>` : ''}
            <th class="text-right">${e(tr('cost_days', 'Дней'))}</th>
            <th class="text-right">${e(tr('breakfast', 'Завтраков'))}</th>
            <th class="text-right">${e(tr('lunch', 'Обедов'))}</th>
            <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
            <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr></thead>
        <tbody>${list.map(p => `<tr class="${p.pm ? '' : 'opacity-50'}">
            <td>${p.vaishnavaId ? `<a class="link link-hover" href="../vaishnavas/person.html?id=${p.vaishnavaId}">${e(personLabel(p))}</a>` : e(personLabel(p))}</td>
            ${withBucket ? `<td class="text-xs">${p.bucket === 'team' || p.bucket === 'volunteers'
                ? `<span class="badge badge-sm border-0 text-white" style="background:${BUCKET_COLORS[p.bucket]}">${e(BUCKET_LABELS[p.bucket]())}</span>`
                : `<span class="opacity-70">${e(BUCKET_LABELS[p.bucket]())}</span>`}</td>` : ''}
            <td class="text-right">${p.days.size}</td><td class="text-right">${p.bf}</td><td class="text-right">${p.ln}</td>
            <td class="text-right">${p.pm}</td>
            <td class="text-right">${money(p.cost)}${warnMark(ps)}</td></tr>`).join('')}</tbody></table>`;
}

const expanded = new Set();   // раскрытые строки: 'eaters:<key>' | 'dept:<id>' | 'income:<retreat>' | 'recon:<code>'
const DDS_URL = id => `../finance/dds.html?op=${encodeURIComponent(id)}`;

// Список операций ДДС (приходы или расходы) — строка ведёт в ДДС на эту операцию
function opsTable(ops) {
    if (!ops) return `<div class="py-2"><span class="loading loading-spinner loading-xs"></span></div>`;
    if (!ops.length) return `<div class="text-sm opacity-60 py-2">${e(tr('fin_drill_empty', 'Операций нет'))}</div>`;
    return `<table class="table table-xs w-full cost-table bg-base-100"><tbody>${ops.map(o => `
        <tr class="hover:bg-base-200/60">
            <td class="whitespace-nowrap w-24">${e(fmtDay(o.date))}</td>
            <td>${o.opId ? `<a class="link link-hover" href="${DDS_URL(o.opId)}" target="_blank" rel="noopener" title="${e(tr('fin_open_in_dds', 'Открыть в ДДС'))}">${e(o.title || '—')}</a>` : e(o.title || '—')}
                ${o.meta ? `<div class="text-xs opacity-60">${e(o.meta)}</div>` : ''}</td>
            <td class="text-right">${o.foreign ? `<span class="text-xs opacity-60">${e(o.foreign)}</span> ` : ''}${money(o.amount)}</td>
        </tr>`).join('')}</tbody></table>`;
}

// Операции кассы прасада ретрита (из отчёта по ретриту) — по всем статьям блока «Прасад»:
// dir 'in' — приходы, 'out' — расходы
async function loadIncomeOps(retreatId, dir = 'in') {
    const inc = view.incomes[retreatId];
    const store = dir === 'in' ? view.incomeOps : view.expenseOps;
    if (!inc || store[retreatId]) return;
    const parts = await Promise.all((dir === 'in' ? inc.groups : inc.expenseGroups).map(g => Layout.db.rpc('fin_get_report_drilldown',
        { p_object: inc.objectId, p_unit: 'prasad', p_direction: dir, p_group: g })));
    store[retreatId] = parts.flatMap(({ data }) => data?.ok ? data.result.rows : []).map(r => ({
        date: r.occurred_on, opId: r.operation_id, title: r.description || r.participant || r.reason || '—',
        meta: [r.description && r.participant ? r.participant : '', r.account].filter(Boolean).join(' · '),
        amount: Number(r.amount_base), foreign: r.currency !== 'INR' ? `${Number(r.amount).toLocaleString(locale())} ${r.currency}` : ''
    })).sort((a, b) => a.date.localeCompare(b.date));
}

async function loadDirectPostings() {
    if (view.directPostings) return;
    const { data, error } = await Layout.db.rpc('fin_kitchen_direct_postings', { p_from: view.from, p_to: view.to });
    view.directPostings = error ? [] : (data || []);
}
const toggleCell = key => `<span class="inline-block w-4 opacity-60">${expanded.has(key) ? '▾' : '▸'}</span>`;

function renderEaters() {
    const rows = rowDefs().filter(r => !r.sub || r.status || state.mode !== 'retreat');
    Layout.$('#eatersNote').classList.toggle('hidden', state.mode !== 'retreat');
    Layout.$('#eatersHead').innerHTML = `<tr><th></th>
        <th class="text-right">${e(tr('cost_people', 'Людей'))}</th>
        <th class="text-right">${e(tr('cost_ate_both', 'Завтраки и обеды'))}</th>
        <th class="text-right">${e(tr('cost_ate_bf_only', 'Только завтраки'))}</th>
        <th class="text-right">${e(tr('cost_ate_ln_only', 'Только обеды'))}</th>
        <th class="text-right">${e(tr('cost_ate_none', 'Не питались'))}</th>
        <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th></tr>`;
    Layout.$('#eatersBody').innerHTML = rows.map(row => {
        const s = peopleStats(row);
        const x = rowAgg(row);
        const key = `eaters:${row.key}`;
        const deptBucket = row.ev === 'none' && (row.buckets[0] === 'team' || row.buckets[0] === 'volunteers') ? row.buckets[0] : null;
        const deptLink = deptBucket ? ` <button class="btn btn-ghost btn-xs text-primary" data-action="open-dept" data-bucket="${deptBucket}">${e(tr('cost_to_departments', 'По департаментам →'))}</button>` : '';
        const open = expanded.has(key)
            ? `<tr><td colspan="7" class="bg-base-200/40 pl-8">${peopleTable(personRows((xr, ev) => ev === row.ev && row.buckets.includes(xr.bucket) && rowMatch(row, xr)), row.buckets.length > 1)}</td></tr>` : '';
        return `<tr class="${row.main ? 'bg-base-200/60 font-semibold' : ''} cursor-pointer hover:bg-base-200/50" data-action="toggle-row" data-key="${key}">
            <td class="${row.sub ? 'pl-8 text-sm' : ''}">${toggleCell(key)}${e(row.label)}${deptLink}</td>
            <td class="text-right">${num(s.people)}</td><td class="text-right">${num(s.both)}</td>
            <td class="text-right">${num(s.bfOnly)}</td><td class="text-right">${num(s.lnOnly)}</td>
            <td class="text-right ${s.none ? '' : 'opacity-40'}">${num(s.none)}</td>
            <td class="text-right">${num(x.pm)}</td></tr>${open}`;
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

// ---------- Команда и волонтёры по департаментам ----------
// Правило ВГ: у каждого в команде и каждого волонтёра есть департамент; расход на их питание
// по смыслу лежит на департаменте. Фильтр: все / команда / волонтёры.
let deptFilter = 'all';

function renderDepartments() {
    // В режиме «Ретрит» — не люди ретрита (они на «Вкушающих»), а постоянные команда и волонтёры,
    // евшие в те же дни: для сведения, в себестоимость ретрита не входят (решение ВГ 25.09).
    const isRetreat = state.mode === 'retreat';
    const buckets = deptFilter === 'team' ? ['team'] : deptFilter === 'volunteers' ? ['volunteers'] : ['team', 'volunteers'];
    const people = personRows((x, ev) => (!isRetreat || ev === 'none') && buckets.includes(x.bucket));
    Layout.$('#deptRetreatNote').classList.toggle('hidden', !isRetreat);
    const byDept = new Map();
    for (const p of people) {
        if (!p.pm && !p.days.size) continue;
        const id = (p.vaishnavaId && personDept.get(p.vaishnavaId)) || '';
        const list = byDept.get(id) || [];
        list.push(p);
        byDept.set(id, list);
    }
    const name = id => id ? (Layout.getName(departments.find(d => d.id === id) || {}) || '—') : tr('cost_no_department', 'Без департамента');
    const sumOf = list => list.reduce((acc, p) => ({ team: acc.team + (p.bucket === 'team' ? 1 : 0), vol: acc.vol + (p.bucket === 'volunteers' ? 1 : 0),
                                                     pm: acc.pm + p.pm, cost: acc.cost + p.cost }), { team: 0, vol: 0, pm: 0, cost: 0 });
    const list = [...byDept.entries()].map(([id, ppl]) => ({ id, ppl, s: sumOf(ppl) }))
        .sort((a, b) => (a.id === '') - (b.id === '') || b.s.cost - a.s.cost || name(a.id).localeCompare(name(b.id)));
    const months = Math.max(1, (DateUtils.parseDate(view.to) - DateUtils.parseDate(view.from)) / 86400000 / 30.44);
    const ps = pricesState();

    document.querySelectorAll('[data-action="dept-filter"]').forEach(b => b.classList.toggle('btn-active', b.dataset.filter === deptFilter));
    Layout.$('#deptHead').innerHTML = `<tr><th>${e(tr('cost_department', 'Департамент'))}</th>
        <th class="text-right">${e(tr('status_team', 'Команда'))}</th>
        <th class="text-right">${e(tr('category_volunteer', 'Волонтёры'))}</th>
        <th class="text-right">${e(tr('cost_person_meals', 'Приёмов пищи'))}</th>
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th>
        <th class="text-right">${e(tr('cost_per_month', 'В месяц'))}</th></tr>`;
    const grand = { team: 0, vol: 0, pm: 0, cost: 0 };
    Layout.$('#deptBody').innerHTML = list.map(({ id, ppl, s }) => {
        Object.keys(grand).forEach(k => grand[k] += s[k]);
        const key = `dept:${id}`;
        const open = expanded.has(key) ? `<tr><td colspan="6" class="bg-base-200/40 pl-8">${peopleTable(ppl, true)}</td></tr>` : '';
        return `<tr class="cursor-pointer hover:bg-base-200/50 ${id ? '' : 'text-warning'}" data-action="toggle-row" data-key="${key}">
            <td>${toggleCell(key)}${e(name(id))}</td>
            <td class="text-right">${s.team || '—'}</td><td class="text-right">${s.vol || '—'}</td>
            <td class="text-right">${num(s.pm)}</td>
            <td class="text-right font-medium">${money(s.cost)}${warnMark(ps)}</td>
            <td class="text-right">${money(s.cost / months)}</td></tr>${open}`;
    }).join('') + (list.length ? `<tr class="font-semibold border-t-2 border-base-300"><td>${e(tr('cost_total', 'Всего'))}</td>
        <td class="text-right">${grand.team}</td><td class="text-right">${grand.vol}</td><td class="text-right">${num(grand.pm)}</td>
        <td class="text-right">${money(grand.cost)}</td><td class="text-right">${money(grand.cost / months)}</td></tr>`
        : `<tr><td colspan="6" class="text-center opacity-60">${e(tr('cost_nothing', 'За период нет данных'))}</td></tr>`);
}

// ---------- Прямые затраты ----------
let directOnlyNoMenu = false;   // «Прямые затраты»: показать только приёмы пищи без меню

function renderDirect() {
    const scope = scopeEvents();
    const ps = pricesState();
    // Заголовок с подсказкой: пунктир — наведите, будет пояснение
    const hintTh = (label, hint) => `<th class="text-right"><span class="underline decoration-dotted cursor-help" title="${e(hint)}">${e(label)}</span></th>`;
    Layout.$('#directHead').innerHTML = `<tr><th>${e(tr('date', 'Дата'))}</th><th></th>
        ${scope ? hintTh(tr('cost_retreat_eaters', 'Ретрит'), tr('cost_retreat_eaters_hint', 'Сколько участников этого ретрита ело в этот приём пищи: гости, важные гости, волонтёры и команда, приехавшие под ретрит. Наведите на число — разбивка.')) : ''}
        ${hintTh(scope ? tr('cost_eaters_all', 'Вкушающих всего') : tr('cost_eaters', 'Вкушающих'), tr('cost_eaters_hint', 'Все, кто ел, по подсчёту из размещения — вместе с участниками ретрита, командой, волонтёрами и гостями. Наведите на число — разбивка.'))}
        ${hintTh(tr('cost_cook_portions', 'Порций (повар)'), tr('cost_cook_portions_hint', 'Число порций, которое повар сам внёс в меню. Продукты считаются на это число, а делятся между вкушающими.'))}
        <th class="text-right">${e(tr('cost_food', 'Продукты'))}</th>
        <th class="text-right">${e(tr('cost_dishware', 'Посуда'))}</th>
        <th class="text-right">${e(tr('cost_external', 'Готовое'))}</th>
        <th class="text-right">${e(tr('cost_total', 'Всего'))}</th></tr>`;

    // Разбивка вкушающих для подсказки: «Ретрит Художников: участники 1 · без события: волонтёры 20, команда 12»
    const breakdown = (byEvent, onlyScope) => Object.entries(byEvent || {})
        .filter(([ev]) => !onlyScope || !scope || scope.includes(ev))
        .map(([ev, b]) => {
            const parts = ALL_BUCKETS.filter(k => b[k]).map(k => `${(ev === 'none' ? (NONE_ROWS.find(r => r.buckets.includes(k))?.label() || k) : BUCKET_LABELS[k]()).toLowerCase()} ${b[k]}`);
            if (!parts.length) return '';
            return `${ev === 'none' ? tr('cost_no_event', 'без события') : retreatName(ev.slice(8))}: ${parts.join(', ')}`;
        }).filter(Boolean).join(' · ');
    const countOf = (byEvent, onlyScope) => Object.entries(byEvent || {})
        .filter(([ev]) => !onlyScope || !scope || scope.includes(ev))
        .reduce((s, [, b]) => s + ALL_BUCKETS.reduce((x, k) => x + (b[k] || 0), 0), 0);

    // Клик по «Завтрак»/«Обед» — меню этого дня, прокрутка к приёму пищи
    const menuLink = (d, meal) => `<a class="link link-hover" href="menu.html#day/${d}/${meal}" title="${e(tr('cost_open_menu', 'Открыть меню этого дня'))}">${e(MEAL_LABELS[meal]())}</a>`;

    // Все дни периода подряд: приём пищи без меню — серой строкой, чтобы пропуск был виден
    const byKey = new Map();
    for (const r of view.result.mealRecords) {
        const k = `${r.date}|${r.meal}`;
        (byKey.get(k) || byKey.set(k, []).get(k)).push(r);
    }
    const counts = view.result.counts || {};
    const sum = { food: 0, dish: 0, ext: 0 };
    const noMenu = [];
    const out = [];
    for (let d = view.from; d <= view.to; d = addDays(d, 1)) {
        for (const meal of ['breakfast', 'lunch']) {
            const recs = byKey.get(`${d}|${meal}`);
            if (!recs) {
                const byEvent = counts[d]?.byEvent?.[meal];
                const total = countOf(byEvent, false), n = countOf(byEvent, true);
                if (!(scope ? n : total)) continue;
                noMenu.push({ d, meal });
                out.push(`<tr class="opacity-60">
                    <td class="whitespace-nowrap">${e(fmtDay(d))}</td>
                    <td class="text-sm">${menuLink(d, meal)} <span class="badge badge-warning badge-xs">${e(tr('cost_no_menu', 'меню не внесено'))}</span></td>
                    ${scope ? `<td class="text-right" title="${e(breakdown(byEvent, true))}">${n}</td>` : ''}
                    <td class="text-right" title="${e(breakdown(byEvent, false))}">${total}</td>
                    <td class="text-right">—</td><td class="text-right">—</td><td class="text-right">—</td><td class="text-right">—</td><td class="text-right">—</td></tr>`);
                continue;
            }
            if (directOnlyNoMenu) continue;
            for (const r of recs) {
                const n = scope ? countOf(r.byEvent, true) : r.eaters;
                if (scope && !n) continue;
                const share = r.eaters ? n / r.eaters : 0;
                const food = r.food * share, dish = r.dishwarePerEater * n, ext = r.external * share;
                sum.food += food; sum.dish += dish; sum.ext += ext;
                const fullyExternal = !r.ownDishes && r.external > 0;
                const extTitle = r.externalNames.length ? r.externalNames.join(', ') : '';
                out.push(`<tr class="${r.unallocated ? 'text-warning' : ''}">
                    <td class="whitespace-nowrap">${e(fmtDay(r.date))}</td>
                    <td class="text-sm">${menuLink(r.date, r.meal)}${fullyExternal ? ` <span class="badge badge-info badge-xs">${e(tr('cost_fully_external', 'целиком со стороны'))}</span>` : ''}</td>
                    ${scope ? `<td class="text-right" title="${e(breakdown(r.byEvent, true))}">${n}</td>` : ''}
                    <td class="text-right" title="${e(breakdown(r.byEvent, false))}">${r.eaters || '—'}</td>
                    <td class="text-right">${r.portions ?? '—'}</td>
                    <td class="text-right">${ps === 'none' ? '—' : money(food)}</td>
                    <td class="text-right">${ps === 'none' ? '—' : money(dish)}</td>
                    <td class="text-right" title="${e(extTitle)}">${ext ? money(ext) : '—'}</td>
                    <td class="text-right font-medium">${money(food + dish + ext)}</td></tr>`);
            }
        }
    }

    // Пропусков нет (сменили ретрит/период) — фильтр «только без меню» снимаем, иначе таблица пустая
    if (!noMenu.length && directOnlyNoMenu) { directOnlyNoMenu = false; return renderDirect(); }

    // Правило ВГ: о любом пропуске данных — предупреждение сверху
    const warnBox = Layout.$('#directWarn');
    if (noMenu.length) {
        const days = new Set(noMenu.map(x => x.d)).size;
        const list = noMenu.map(x => `<a class="link" href="menu.html#day/${x.d}/${x.meal}">${e(fmtDay(x.d).replace(/ \d{4}$/, ''))} ${e(MEAL_LABELS[x.meal]().toLowerCase())}</a>`);
        warnBox.innerHTML = `<span><b>⚠ ${e(tr('cost_no_menu_title', 'Нет меню'))}: ${noMenu.length} ${e(tr('cost_meals_short', 'приёмов пищи'))}, ${days} ${e(tr('cost_days_short', 'дн.'))}</b>
            — ${e(tr('cost_no_menu_note', 'люди ели, но затраты на продукты по этим приёмам не посчитаны. Внесите меню на странице Меню.'))}
            <details class="mt-1"><summary class="cursor-pointer">${e(tr('cost_show_dates', 'Показать даты'))}</summary>${list.join(', ')}</details></span>
            <button class="btn btn-sm shrink-0 whitespace-nowrap ${directOnlyNoMenu ? 'btn-neutral' : 'bg-base-100 border-base-100 hover:bg-base-200'}" data-action="direct-only-nomenu">${e(directOnlyNoMenu ? tr('cost_show_all_meals', 'Показать все') : tr('cost_only_no_menu', 'Только без меню'))}</button>`;
    }
    warnBox.classList.toggle('hidden', !noMenu.length);

    Layout.$('#directBody').innerHTML = out.length
        ? out.join('') + `<tr class="font-semibold border-t-2 border-base-300"><td colspan="${scope ? 5 : 4}">${e(tr('cost_total', 'Всего'))}</td>
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

// Как посчитана доля строки накладных — текст подсказки на сумме (ВГ 25.09: «почему так посчитано»)
function overheadExplain(l, part) {
    if (l.unallocated) return tr('cost_ov_x_unallocated', 'За период расхода нет ни одного вкушающего — делить не на кого, расход не распределён.');
    const scope = scopeEvents();
    const pick = obj => scope ? scope.reduce((s, ev) => s + (obj[ev] || 0), 0) : Object.values(obj).reduce((s, v) => s + v, 0);
    const pm = pick(l.pmByEvent);
    const whoBase = l.kind === 'retreat_event' ? tr('cost_ov_x_base_retreat', 'приёмов пищи участников этого ретрита')
        : l.kind === 'retreat_period' && l.group === 'retreat' ? tr('cost_ov_x_base_retreats', 'приёмов пищи участников всех ретритов')
        : tr('cost_ov_x_base_all', 'приёмов пищи всех вкушающих (команда, волонтёры, гости, участники)');
    const whoPart = scope ? tr('cost_ov_x_part_retreat', 'приёмов пищи участников этого ретрита') : tr('cost_ov_x_part_period', 'приёмов пищи в выбранном периоде');
    return `${money(l.amount)} (${DateUtils.formatRange(l.from, l.to)}) ÷ ${num(l.base)} ${whoBase} = ${money2(l.rate)} ${tr('cost_ov_x_per_meal', 'за один приём пищи')}. `
        + `× ${num(pm)} ${whoPart} = ${money(part)}.`;
}

// Зарплата за месяц ещё не начислена — сумма ориентировочная: откуда взята и когда станет точной
function estimateHint(l) {
    const month = DateUtils.parseDate(l.from).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '');
    const b = l.estimateBasis || '';
    const basis = b === 'salary'
        ? `${tr('cost_est_from_salary', 'оклад, указанный у должности')} — ${money(l.amount)}`
        : b.startsWith('accrual:')
            ? `${tr('cost_est_from_last', 'последнее начисление за')} ${DateUtils.parseDate(b.slice(8) + '-01').toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '')} — ${money(l.amount)}`
            : money(l.amount);
    return `${tr('cost_est_hint1', 'Предварительная сумма: зарплата за')} ${month} ${tr('cost_est_hint2', 'ещё не начислена в финансах. Взято:')} ${basis}. `
        + tr('cost_est_hint3', 'Как только зарплату начислят (Финансы → Зарплата), здесь сама встанет настоящая сумма, и доля ретрита пересчитается.');
}

// Накладные: группы раскрываются на месте (правило ВГ) — Зарплаты → должность с именем → месяцы;
// остальные статьи → отдельные расходы со ссылкой в ДДС
function renderOverhead() {
    const scope = scopeEvents();
    const partHint = scope
        ? tr('cost_ov_part_hint_retreat', 'Каждый расход делится поровну на все приёмы пищи за свой период (зарплата — за месяц): сумма ÷ число приёмов пищи = ставка. Ретриту достаётся ставка × приёмы пищи его участников. Наведите на сумму — расчёт по строке.')
        : tr('cost_ov_part_hint_period', 'Каждый расход делится поровну на все приёмы пищи за свой период (зарплата — за месяц). Выбранному периоду достаётся ставка × его приёмы пищи. Наведите на сумму — расчёт по строке.');
    Layout.$('#overheadHead').innerHTML = `<tr><th>${e(tr('cost_reconcile_category', 'Статья'))}</th>
        <th>${e(tr('cost_ov_period', 'Период расхода'))}</th>
        <th>${e(tr('cost_ov_group', 'Как делится'))}</th>
        <th class="text-right">${e(tr('cost_ov_amount', 'Сумма'))}</th>
        <th class="text-right"><span class="underline decoration-dotted cursor-help" title="${e(partHint)}">${e(scope ? tr('cost_ov_to_retreat', 'На этот ретрит') : tr('cost_ov_to_period', 'В этот период'))}</span></th></tr>`;

    const items = view.result.overheadLines.map(l => {
        const part = scope ? scope.reduce((s, ev) => s + (l.byEvent[ev] || 0), 0) : l.allocated;
        if (!(part > 0.5) && !l.unallocated) return null;
        return { l, part };
    }).filter(Boolean);

    const howOf = l => l.unallocated ? tr('cost_ov_unallocated_short', 'не распределено — нет вкушающих')
        : l.kind === 'retreat_event' ? `${GROUP_LABELS.retreat()}: ${retreatName(l.retreatId)}`
        : l.kind === 'retreat_period' ? tr('cost_ov_retreats_of_period', 'на ретриты своего периода')
        : l.group === 'general' && l.kind !== 'general' ? `${GROUP_LABELS.general()} (${tr('cost_ov_no_retreat_eaters', 'людей ретрита не было')})`
        : GROUP_LABELS.general();
    const partCell = (l, part) => `<td class="text-right font-medium"><span class="underline decoration-dotted cursor-help" title="${e(overheadExplain(l, part))}">${money(part)}</span></td>`;
    const range = list => DateUtils.formatRange(list.reduce((m, x) => x.l.from < m ? x.l.from : m, list[0].l.from), list.reduce((m, x) => x.l.to > m ? x.l.to : m, list[0].l.to));
    const sumOf = list => list.reduce((a, x) => ({ amount: a.amount + x.l.amount, part: a.part + x.part }), { amount: 0, part: 0 });
    const groupRow = (key, labelHtml, list, depth, cls = '') => {
        const s = sumOf(list);
        const rowCls = [expanded.has(key) && 'row-open', depth ? 'row-child' : 'row-top', cls].filter(Boolean).join(' ');
        return `<tr class="cursor-pointer hover:bg-base-200/50 ${rowCls}" data-action="toggle-row" data-key="${key}">
            <td class="${depth ? 'pl-8' : ''}">${toggleCell(key)}${labelHtml} <span class="text-xs opacity-60">(${list.length})</span>${list.some(x => x.l.estimate) ? ` <span class="badge badge-warning badge-xs cursor-help" title="${e(tr('cost_est_group_hint', 'Часть месяцев — предварительно: зарплата ещё не начислена. Раскройте, наведите на пометку — откуда взята сумма.'))}">${e(tr('cost_estimate_approx', 'предварительно'))}</span>` : ''}</td>
            <td class="text-sm whitespace-nowrap ${depth ? 'row-muted' : ''}">${e(range(list))}</td><td></td>
            <td class="text-right">${money(s.amount)}</td>
            <td class="text-right font-medium">${money(s.part)}</td></tr>`;
    };
    const itemRow = ({ l, part }, labelHtml, pad) => `<tr class="${l.unallocated ? 'text-warning' : ''} text-sm row-child">
        <td class="${pad}">${labelHtml}${l.estimate ? ` <span class="badge badge-warning badge-xs cursor-help" title="${e(estimateHint(l))}">${e(tr('cost_estimate_approx', 'предварительно'))}</span>` : ''}${l.comment ? `<div class="text-xs opacity-60">${e(l.comment)}</div>` : ''}</td>
        <td class="whitespace-nowrap row-muted">${e(DateUtils.formatRange(l.from, l.to))}</td>
        <td class="row-muted">${e(howOf(l))}</td>
        <td class="text-right">${money(l.amount)}</td>
        ${partCell(l, part)}</tr>`;

    const out = [];
    // 1. Зарплаты: должность (с именем) → месяцы
    const pay = items.filter(x => x.l.category === 'payroll');
    if (pay.length) {
        out.push(groupRow('ov:payroll', `<b>${e(tr('cost_ov_salaries', 'Зарплаты'))}</b>`, pay, 0));
        if (expanded.has('ov:payroll')) {
            const byPos = new Map();
            for (const x of pay) {
                const k = `${x.l.label}|${x.l.personId || ''}`;
                (byPos.get(k) || byPos.set(k, []).get(k)).push(x);
            }
            // сначала старшие должности (больше оклад)
            const positions = [...byPos.entries()].sort((a, b) => Math.max(...b[1].map(x => x.l.amount)) - Math.max(...a[1].map(x => x.l.amount)));
            for (const [k, list] of positions) {
                const l0 = list[0].l;
                const who = l0.personName
                    ? ` — <a class="link link-hover" href="../vaishnavas/person.html?id=${e(l0.personId)}" target="_blank" rel="noopener">${e(l0.personName)}</a>` : '';
                const key = `ov:pos:${k}`;
                out.push(groupRow(key, `${e(l0.label)}${who}`, list, 1));
                if (expanded.has(key)) list.sort((a, b) => a.l.from.localeCompare(b.l.from))
                    .forEach(x => out.push(itemRow(x, e(DateUtils.parseDate(x.l.from).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }).replace(' г.', '')), 'pl-16')));
            }
        }
    }
    // 2. Остальные статьи: по сумме на ретрит, «Прочее» — в конце
    const byCat = new Map();
    for (const x of items.filter(x => x.l.category !== 'payroll')) {
        const c = x.l.category || tr('cost_ov_other', 'Прочее');
        (byCat.get(c) || byCat.set(c, []).get(c)).push(x);
    }
    const isOther = c => /^проч/i.test(c);
    const cats = [...byCat.entries()].sort((a, b) => isOther(a[0]) - isOther(b[0]) || sumOf(b[1]).part - sumOf(a[1]).part);
    for (const [c, list] of cats) {
        const key = `ov:cat:${c}`;
        out.push(groupRow(key, `<b>${e(c)}</b>`, list, 0, list.some(x => x.l.unallocated) ? 'text-warning' : ''));
        if (!expanded.has(key)) continue;
        list.sort((a, b) => (a.l.occurredOn || a.l.from).localeCompare(b.l.occurredOn || b.l.from)).forEach(x => {
            const opId = x.l.postingId ? view.opByPosting.get(x.l.postingId) : null;
            const text = x.l.occurredOn ? fmtDay(x.l.occurredOn) : c;
            const labelHtml = opId ? `<a class="link link-hover" href="${DDS_URL(opId)}" target="_blank" rel="noopener" title="${e(tr('fin_open_in_dds', 'Открыть в ДДС'))}">${e(text)}</a>` : e(text);
            out.push(itemRow(x, labelHtml, 'pl-8'));
        });
    }

    // Пропуски меню: накладные на эти приёмы пищи разложены, продуктов по ним нет (правило ВГ — предупреждать)
    const counts = view.result.counts || {};
    const noMenu = view.result.warnings.noMenu.filter(x => {
        const [d, m] = x.split(' ');
        if (d < view.from || d > view.to) return false;
        return !scope || scope.some(ev => ALL_BUCKETS.some(k => counts[d]?.byEvent?.[m]?.[ev]?.[k]));
    });
    const warnBox = Layout.$('#overheadWarn');
    warnBox.innerHTML = noMenu.length ? `<span><b>⚠ ${e(tr('cost_no_menu_title', 'Нет меню'))}: ${noMenu.length} ${e(tr('cost_meals_short', 'приёмов пищи'))}, ${new Set(noMenu.map(x => x.split(' ')[0])).size} ${e(tr('cost_days_short', 'дн.'))}</b>
        — ${e(tr('cost_ov_no_menu_note', 'люди ели, поэтому накладные на эти приёмы пищи разложены, но продукты по ним не посчитаны. Какие именно дни — на вкладке «Прямые затраты».'))}</span>
        <button class="btn btn-sm shrink-0 whitespace-nowrap bg-base-100 border-base-100 hover:bg-base-200" data-action="open-no-menu">${e(tr('cost_open_no_menu', 'Показать дни без меню'))}</button>` : '';
    warnBox.classList.toggle('hidden', !noMenu.length);

    const total = sumOf(items);
    Layout.$('#overheadBody').innerHTML = out.length
        ? out.join('') + `<tr class="font-semibold border-t-2 border-base-300"><td colspan="3">${e(tr('cost_total', 'Всего'))}</td><td class="text-right">${money(total.amount)}</td><td class="text-right">${money(total.part)}</td></tr>`
        : `<tr><td colspan="5" class="text-center opacity-60">${e(tr('cost_ov_none', 'Накладных расходов в периоде нет'))}</td></tr>`;
    renderUnassigned();
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
    parts.push(nonEmpty(tr('cost_w_no_department', 'Команда и волонтёры без департамента — укажите департамент в карточке человека'), noDeptPeople()));
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

async function loadThreshold() {
    const { data, error } = await Layout.db.rpc('kitchen_reconcile_threshold');
    if (!error && data !== null) reconcileThreshold = Number(data);
}

function renderThreshold() {
    const input = Layout.$('#thresholdInput');
    input.value = reconcileThreshold;
    // суперпользователю fin_* не выдаются автоматически — смотрим явное право
    input.disabled = !window.currentUser?.permissions?.includes('fin_admin');
}

async function saveThreshold(pct) {
    const { error } = await Layout.db.rpc('kitchen_set_reconcile_threshold', { p_pct: pct });
    if (error) { Layout.showNotification(errorText(error), 'error'); renderThreshold(); return; }
    reconcileThreshold = pct;
    Layout.showNotification(t('saved'), 'success');
    if (view) renderReconcile();
}

function renderReconcile() {
    const totals = view.result.totals;
    const noPrices = !view.result.pricesLoaded;
    Layout.$('#reconcileScope').innerHTML = `<b>${e(tr('cost_reconcile_scope', 'Вся кухня за'))} ${e(DateUtils.formatRange(view.from, view.to))}</b>
        <span class="opacity-60">— ${e(tr('cost_reconcile_scope_note', 'все, кто ел, и все закупки кухни — не только ретриты'))}</span>`;
    // Правило ВГ о пропусках: без цен расчёт = 0, разница ничего не значит — предупреждаем и не показываем её
    const warnBox = Layout.$('#reconcileWarn');
    warnBox.innerHTML = noPrices ? `<span><b>⚠ ${e(tr('cost_reconcile_no_prices', 'Цены не внесены — «Траты по меню» пока 0, сверка заработает после внесения цен'))}</b></span>
        <a class="btn btn-sm shrink-0 whitespace-nowrap bg-base-100 border-base-100 hover:bg-base-200" href="prices.html">${e(tr('nav_prices', 'Цены'))} →</a>` : '';
    warnBox.classList.toggle('hidden', !noPrices);
    let modelSum = 0, factSum = 0;
    const rows = RECONCILE_ROWS.map(r => {
        const actual = reconcileActuals.find(x => x.category_code === r.code);
        const model = r.modelKey ? Number(totals[r.modelKey] || 0) : null;
        const fact = Number(actual?.amount_base || 0);
        const name = actual?.category_name || tr('cost_cat_' + r.code, r.code);
        const diff = model === null ? null : model - fact;
        if (model !== null) { modelSum += model; factSum += fact; }
        const key = `recon:${r.code}`;
        const open = expanded.has(key) ? `<tr><td colspan="4" class="bg-base-200/40 pl-8">${opsTable(view.directPostings
            ? view.directPostings.filter(p => p.category_code === r.code).map(p => ({ date: p.occurred_on, opId: p.operation_id,
                title: p.comment || p.category_name, amount: Number(p.amount_base) })) : null)}</td></tr>` : '';
        return `<tr class="${fact ? 'cursor-pointer hover:bg-base-200/50' : ''}" ${fact ? `data-action="toggle-recon" data-key="${key}"` : ''}>
            <td class="text-sm">${fact ? toggleCell(key) : '<span class="inline-block w-4"></span>'}${e(name)}</td>
            <td class="text-right">${model === null ? '—' : money(model)}</td>
            <td class="text-right">${money(fact)}</td>
            <td class="text-right ${!noPrices && diff !== null && Math.abs(diff) > Math.max(fact, model || 0) * reconcileThreshold / 100 ? 'text-warning font-medium' : ''}">${diff === null ? `<span class="text-sm opacity-60">${e(tr('cost_reconcile_na', 'не сравнивается — закупка впрок'))}</span>` : noPrices ? '—' : money(diff)}</td>
        </tr>${open}`;
    }).join('') + `<tr class="font-semibold border-t-2 border-base-300">
        <td class="text-sm">${e(tr('cost_reconcile_total', 'Итого сопоставимых'))}</td>
        <td class="text-right">${money(modelSum)}</td>
        <td class="text-right">${money(factSum)}</td>
        <td class="text-right ${!noPrices && Math.abs(modelSum - factSum) > Math.max(factSum, modelSum) * reconcileThreshold / 100 ? 'text-warning' : ''}">${noPrices ? '—' : money(modelSum - factSum)}</td>
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
    try { localStorage.setItem('kitchen_cost_view', JSON.stringify({ mode: state.mode, step: state.step, retreatId: state.retreatId,
        section: state.section, tab: state.tab, dataTab: state.dataTab, cashTab: state.cashTab })); } catch { /* нет хранилища */ }
}

// ==================== ПАМЯТКА «КАК СЧИТАЕТСЯ» ====================
// «?» у вкладки открывает памятку на своём разделе
const HOW_SECTIONS = { eaters: 'eaters', departments: 'team', direct: 'direct', overhead: 'overhead',
                       reconcile: 'gaps', completeness: 'gaps', problems: 'gaps', settings: 'direct' };

function openHow(sec) {
    const panel = Layout.$('#howPanel');
    Layout.$('#howBackdrop').classList.remove('hidden');
    panel.classList.remove('translate-x-full');
    panel.setAttribute('aria-hidden', 'false');
    const target = sec && document.getElementById(`how-${sec}`);
    if (target) {
        target.open = true;
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 220);
    }
}

function closeHow() {
    Layout.$('#howBackdrop').classList.add('hidden');
    Layout.$('#howPanel').classList.add('translate-x-full');
    Layout.$('#howPanel').setAttribute('aria-hidden', 'true');
}

document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeHow(); });

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
        case 'toggle-row':
            if (ev.target.closest('a, button')) break;
            if (expanded.has(btn.dataset.key)) expanded.delete(btn.dataset.key); else expanded.add(btn.dataset.key);
            if (view && btn.dataset.key.startsWith('kcat:')) { renderKpis(); break; }
            if (view) renderTabs();
            break;
        case 'toggle-income': {
            const key = `income:${btn.dataset.retreat}`;
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            renderSummary();
            if (expanded.has(key)) loadIncomeOps(btn.dataset.retreat).then(() => view && renderSummary());
            ev.stopPropagation();
            break;
        }
        case 'toggle-cash': {
            // одна раскрытая сумма за раз: приходы или расходы
            const dir = btn.dataset.dir, key = `cash:${dir}`, was = expanded.has(key);
            expanded.delete('cash:in'); expanded.delete('cash:out');
            if (!was) expanded.add(key);
            renderCash();
            if (!was) loadIncomeOps(state.retreatId, dir).then(() => view && renderCash()).catch(err => {
                console.error('Операции кассы:', err);
                (dir === 'in' ? view.incomeOps : view.expenseOps)[state.retreatId] = [];
                renderCash();
            });
            break;
        }
        case 'toggle-kcash': {
            const key = `kcash:${btn.dataset.dir}`, was = expanded.has(key);
            expanded.delete('kcash:in'); expanded.delete('kcash:out');
            if (!was) expanded.add(key);
            renderKpis();
            break;
        }
        case 'toggle-recon': {
            const key = btn.dataset.key;
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            renderReconcile();
            if (expanded.has(key)) loadDirectPostings().then(() => view && renderReconcile());
            break;
        }
        case 'how':
            ev.preventDefault();
            openHow(btn.dataset.sec);
            break;
        case 'how-close':
            closeHow();
            break;
        case 'open-no-menu':
            directOnlyNoMenu = true;
            state.section = 'calc';
            state.tab = 'direct';
            saveState();
            if (view) renderTabs();
            break;
        case 'direct-only-nomenu':
            directOnlyNoMenu = !directOnlyNoMenu;
            renderDirect();
            break;
        case 'open-dept':
            deptFilter = btn.dataset.bucket || 'all';
            state.section = 'calc';
            state.tab = 'departments';
            saveState();
            if (view) renderTabs();
            break;
        case 'dept-filter':
            deptFilter = btn.dataset.filter;
            if (view) renderDepartments();
            break;
        case 'section':
            state.section = btn.dataset.section;
            saveState();
            if (view) renderTabs();
            break;
        case 'tab':
            if (DATA_TABS.includes(btn.dataset.tab)) { state.section = 'data'; state.dataTab = btn.dataset.tab; }
            else if (CASH_TABS.includes(btn.dataset.tab)) { state.section = 'cash'; state.cashTab = btn.dataset.tab; }
            else { if (state.section !== 'calc') state.section = 'calc'; state.tab = btn.dataset.tab; }
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
    if (ev.target.id === 'thresholdInput') {
        const pct = parseFloat(ev.target.value);
        if (pct >= 1 && pct <= 100) saveThreshold(pct); else renderThreshold();
        return;
    }
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

    const [{ data }, { data: deps }] = await Promise.all([
        Layout.db.from('retreats').select('id, name_ru, name_en, name_hi, start_date, end_date').order('start_date', { ascending: false }),
        Layout.db.from('departments').select('*')
    ]);
    retreats = data || [];
    departments = deps || [];

    // по умолчанию — ретрит, который идёт сейчас или закончился последним
    const today = DateUtils.toISO(new Date());
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('kitchen_cost_view') || '{}'); } catch { saved = {}; }
    state.mode = saved.mode === 'period' ? 'period' : 'retreat';
    state.section = ['calc', 'cash', 'charts', 'data'].includes(saved.section) ? saved.section : 'calc';
    state.cashTab = CASH_TABS.includes(saved.cashTab) ? saved.cashTab : 'cashMonths';
    state.tab = saved.tab || 'eaters';
    state.dataTab = DATA_TABS.includes(saved.dataTab) ? saved.dataTab : 'completeness';
    const current = retreats.find(r => r.start_date <= today && r.end_date >= today)
        || retreats.find(r => r.end_date < today);
    state.retreatId = retreats.some(r => r.id === saved.retreatId) ? saved.retreatId : (current?.id || '');
    setStep(['month', 'quarter', 'year'].includes(saved.step) ? saved.step : 'month', today);

    Layout.$('#costContent').classList.remove('hidden');
    await Promise.all([loadKits(), loadUnassigned(), loadGroups(), loadThreshold()]);
    updateUI();
    if (state.mode === 'period' || state.retreatId) calculate();
}

init();

})();
