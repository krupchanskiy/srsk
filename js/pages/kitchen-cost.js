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
// section: calc | now | charts | data; tab — вкладка «Расчёта», dataTab — вкладка «Данных»
let state = { mode: 'retreat', step: 'month', retreatId: '', from: '', to: '', section: 'calc', tab: 'eaters', dataTab: 'completeness' };
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
            expense: Number(res.report.prasad.totals.expense_base || 0) };
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
                : { full: income.amount, objectId: income.objectId, groups: income.groups, expense: income.expense, share };
        }));
        if (token !== calcToken) return;

        const postingIds = result.overheadLines.map(l => l.postingId).filter(Boolean);
        const opByPosting = new Map();
        if (postingIds.length) {
            const { data: ops } = await Layout.db.rpc('fin_kitchen_posting_operations', { p_posting_ids: postingIds });
            (ops || []).forEach(o => opByPosting.set(o.posting_id, o.operation_id));
        }
        if (token !== calcToken) return;

        view = { from, to, result, detail, incomes, opByPosting, directPostings: null, incomeOps: {}, now: null };
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
    const reasons = [];
    if (!view.result.pricesLoaded) reasons.push(tr('cost_q_no_prices', 'цены ещё не внесены — продукты и посуда считаются как 0'));
    else if (w.missingPrices.size) reasons.push(`${tr('cost_q_some_prices', 'нет цены у продуктов')}: ${w.missingPrices.size}`);
    if (noMenuPast) reasons.push(`${tr('cost_q_menu_past', 'меню не заведено на прошедшие приёмы пищи')}: ${noMenuPast}`);
    if (noMenuFuture) reasons.push(`${tr('cost_q_menu_future', 'меню ещё не заведено на предстоящие приёмы пищи')}: ${noMenuFuture}`);
    if (w.payrollEstimated.length) reasons.push(`${tr('cost_q_payroll', 'зарплата взята оценкой')}: ${w.payrollEstimated.join(', ')}`);
    const box = Layout.$('#qualityBanner');
    if (!reasons.length) { box.classList.add('hidden'); return; }
    box.innerHTML = `<div class="alert alert-warning text-sm items-start">
        <div><div class="font-semibold">${e(tr('cost_q_title', 'Данные могут быть неточными'))}</div>
        <ul class="list-disc ml-5 mt-1">${reasons.map(r => `<li>${e(r)}</li>`).join('')}</ul></div>
        <a class="btn btn-sm btn-ghost" data-action="tab" data-tab="completeness">${e(tr('cost_tab_completeness', 'Полнота данных'))} →</a>
    </div>`;
    box.classList.remove('hidden');
}

// ---------- Главные цифры ----------
// Режим «Ретрит» — по ретриту; «Период» — итог периода (доход и результат — по ретритам периода).
function kpiNumbers() {
    const cells = view.result.cells;
    const rows = rowDefs().filter(r => !r.sub);
    const sum = zero();
    let income = 0, anyIncome = false, participants = 0;
    for (const row of rows) {
        const x = aggregate(cells, row.ev, row.buckets);
        Object.keys(sum).forEach(k => { if (k !== 'prov') sum[k] += x[k]; });
        const inc = row.retreatId ? view.incomes[row.retreatId] : null;
        if (inc) { income += inc.full * inc.share; anyIncome = true; }
        if (row.retreatId) participants += peopleStats(row).participants;
    }
    const retreatCost = rows.filter(r => r.retreatId).reduce((s, r) => s + total(aggregate(cells, r.ev, r.buckets)), 0);
    return { sum, income: anyIncome ? income : null, participants, retreatCost,
             people: state.mode === 'retreat' ? peopleStats(rows[0]).people : peopleTotal() };
}

function renderKpis() {
    const k = kpiNumbers();
    const ps = pricesState();
    const card = (label, value, sub, cls = '') => `<div class="bg-base-100 rounded-xl shadow-sm p-4">
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-2xl font-bold mt-1 ${cls}">${value}</div>
        ${sub ? `<div class="text-xs opacity-60 mt-1">${sub}</div>` : ''}</div>`;
    const warn = ps === 'none' ? ` <span class="text-sm text-error font-normal">${e(tr('cost_no_prices', 'нет цен'))}</span>`
        : warnMark(ps);
    const result = k.income === null ? null : k.income - (state.mode === 'retreat' ? total(k.sum) : k.retreatCost);
    const cards = [
        card(tr('cost_total', 'Всего'), money(total(k.sum)) + warn,
            `${e(tr('cost_direct', 'Прямые'))} ${money(direct(k.sum))} · ${e(tr('cost_overhead', 'Накладные'))} ${money(overhead(k.sum))}`),
        card(tr('cost_per_meal', 'На приём пищи'), k.sum.pm ? money2(total(k.sum) / k.sum.pm) : '—', `${num(k.sum.pm)} ${e(tr('cost_person_meals', 'приёмов пищи').toLowerCase())}`),
        card(tr('cost_per_participant', 'На участника'), k.participants ? money(k.retreatCost / k.participants) : '—',
            k.participants ? `${num(k.participants)} ${e(tr('cost_participants', 'участников').toLowerCase())}` : e(tr('cost_kpi_no_retreat', 'в периоде нет ретритов'))),
        card(tr('cost_income', 'Доход прасада'), k.income === null ? '—' : money(k.income),
            state.mode === 'period' && k.income !== null ? e(tr('cost_kpi_income_share', 'ретриты своей долей')) : ''),
        // ретрит ещё идёт: доход уже весь, а расход — только за прошедшие дни; итог — в прогнозе
        state.mode === 'retreat' && view.to >= DateUtils.toISO(new Date())
            ? card(tr('cost_result', 'Результат'), '—', `<a class="link" data-action="section" data-section="now">${e(tr('cost_kpi_see_forecast', 'ретрит идёт — прогноз в «Ретрит сейчас»'))}</a>`)
            : card(tr('cost_result', 'Результат'), result === null || ps === 'none' ? '—' : money(result),
                ps === 'none' ? e(tr('cost_result_no_prices', 'Пока нет цен, себестоимость занижена — результат не показываем')) : '',
                result === null || ps === 'none' ? '' : result < 0 ? 'text-error' : 'text-success'),
        card(tr('cost_people', 'Людей'), num(k.people), '')
    ];
    Layout.$('#kpiBox').innerHTML = cards.join('');
    Layout.$('#kpiBox').classList.remove('hidden');
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
        : `${money(direct(x))}${warnMark(ps)}`;
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
        const deptBucket = row.ev === 'none' && (row.buckets[0] === 'team' || row.buckets[0] === 'volunteers') ? row.buckets[0] : null;
        return `<tr class="${row.main ? 'bg-base-200/60 font-semibold' : ''} ${deptBucket ? 'cursor-pointer hover:bg-base-200/50' : ''}" ${deptBucket ? `data-action="open-dept" data-bucket="${deptBucket}" title="${e(tr('cost_to_departments', 'По департаментам →'))}"` : ''}>
            <td class="${cls} ${row.sub ? 'pl-8' : ''}">${deptBucket ? `<span class="link link-hover">${e(row.label)}</span>` : e(row.label)}${inc && inc.share < 0.999 ? ` <span class="text-xs opacity-60">(${Math.round(inc.share * 100)}% ${e(tr('cost_of_retreat', 'ретрита'))})</span>` : ''}</td>
            ${isPeriod ? `<td class="text-right text-sm">${days}</td>` : ''}
            <td class="text-right">${st.people ? num(st.people) : '—'}</td>
            <td class="text-right">${num(x.pm)}</td>
            <td class="text-right">${directCell(x)}</td>
            <td class="text-right">${money(overhead(x))}</td>
            <td class="text-right font-medium">${money(total(x))}</td>
            <td class="text-right">${x.pm ? money2(total(x) / x.pm) : '—'}</td>
            <td class="text-right">${perPart !== null && !row.sub ? money(perPart) : '—'}</td>
            <td class="text-right">${income !== null && !row.sub
                ? `<span class="link link-hover" data-action="toggle-income" data-retreat="${row.retreatId}" title="${e(tr('cost_show_income', 'Показать приходы'))}">${money(income)}</span>` : '—'}</td>
            <td class="text-right">${resultCell(income, x, row.sub, ps)}</td>
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
        state.mode === 'retreat' ? { id: 'now', label: tr('cost_section_now', 'Ретрит сейчас') } : null,
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
    if (state.section !== 'calc') return [];
    const multiMonth = view.from.slice(0, 7) !== view.to.slice(0, 7);
    return [
        { id: 'eaters', label: tr('cost_tab_eaters', 'Вкушающие') },
        { id: 'departments', label: tr('cost_tab_departments', 'Команда и волонтёры') },
        { id: 'direct', label: tr('cost_tab_direct', 'Прямые затраты') },
        { id: 'overhead', label: tr('cost_tab_overhead', 'Накладные') },
        multiMonth ? { id: 'months', label: tr('cost_tab_months', 'По месяцам') } : null,
        { id: 'reconcile', label: tr('cost_reconcile_title', 'Сверка с ДДС') }
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
    const cur = state.section === 'data' ? 'dataTab' : 'tab';
    if (tabs.length && !tabs.some(x => x.id === state[cur])) state[cur] = tabs[0].id;
    Layout.$('#tabBar').innerHTML = tabs.map(x =>
        `<a role="tab" class="tab ${x.id === state[cur] ? 'tab-active [--tab-bg:oklch(var(--b1))]' : ''} ${x.warn ? 'text-warning' : ''}" data-action="tab" data-tab="${x.id}">${e(x.label)}</a>`).join('');
    Layout.$('#tabBar').classList.toggle('hidden', !tabs.length);
    const panel = state.section === 'calc' ? state.tab : state.section === 'data' ? state.dataTab : state.section;
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== panel));
    Layout.$('#tabsBox').classList.remove('hidden');
    ({ eaters: renderEaters, departments: renderDepartments, direct: renderDirect, overhead: renderOverhead, months: renderMonths,
       reconcile: renderReconcile, settings: () => { renderKits(); renderThreshold(); renderGroups(); }, problems: renderWarnings,
       completeness: renderCompleteness, now: renderNow, charts: renderCharts })[panel]?.();
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
async function loadNow() {
    if (view.now || state.mode !== 'retreat') return;
    const today = DateUtils.toISO(new Date());
    const ev = `retreat:${state.retreatId}`;
    const pmOf = (from, to) => {
        let n = 0;
        for (const [d, day] of Object.entries(view.result.counts || {})) {
            if (d < from || d > to) continue;
            for (const m of ['breakfast', 'lunch']) { const b = day.byEvent?.[m]?.[ev]; if (b) n += ALL_BUCKETS.reduce((s, k) => s + (b[k] || 0), 0); }
        }
        return n;
    };
    const status = today < view.from ? 'before' : today > view.to ? 'after' : 'running';
    let toDate = null;
    if (status === 'running') {
        const res = await KitchenCost.calculate(Layout.db, locationId, view.from, today);
        toDate = aggregate(res.cells, ev, ALL_BUCKETS);
    }
    view.now = { status, today, toDate, remainingPm: status === 'running' ? pmOf(addDays(today, 1), view.to) : 0 };
}

function renderNow() {
    const box = Layout.$('#nowBody');
    if (!view.now) {
        box.innerHTML = `<div class="py-6 text-center"><span class="loading loading-spinner"></span></div>`;
        loadNow().then(() => view && state.section === 'now' && renderNow()).catch(err => {
            console.error('Ретрит сейчас:', err);
            box.innerHTML = `<div class="alert alert-error text-sm">${e(errorText(err))}</div>`;
        });
        return;
    }
    const n = view.now;
    const whole = aggregate(view.result.cells, `retreat:${state.retreatId}`, ALL_BUCKETS);
    const inc = view.incomes[state.retreatId];
    const ps = pricesState();
    const days = (a, b) => Math.round((DateUtils.parseDate(b) - DateUtils.parseDate(a)) / 86400000) + 1;
    const total_days = days(view.from, view.to);
    const card = (label, value, sub, cls = '') => `<div class="bg-base-200/50 rounded-xl p-4">
        <div class="text-xs uppercase tracking-wide opacity-60">${e(label)}</div>
        <div class="text-xl font-bold mt-1 ${cls}">${value}</div>${sub ? `<div class="text-xs opacity-60 mt-1">${sub}</div>` : ''}</div>`;
    const resCls = v => v < 0 ? 'text-error' : 'text-success';

    let head, cards;
    if (n.status === 'before') {
        head = `${tr('cost_now_before', 'Ретрит ещё не начался')} · ${tr('cost_now_starts_in', 'до начала')} ${days(n.today, view.from) - 1} ${tr('cost_days_short', 'дн.')}`;
        cards = [
            card(tr('cost_now_forecast_total', 'Прогноз себестоимости'), money(total(whole)), e(tr('cost_now_by_bookings', 'по броням и регистрациям'))),
            card(tr('cost_income', 'Доход прасада'), inc ? money(inc.full) : '—', ''),
            card(tr('cost_now_forecast_result', 'Прогноз результата'), inc && ps !== 'none' ? money(inc.full - total(whole)) : '—', '', inc && ps !== 'none' ? resCls(inc.full - total(whole)) : '')
        ];
    } else if (n.status === 'after') {
        head = tr('cost_now_after', 'Ретрит завершён — итог');
        cards = [
            card(tr('cost_total', 'Себестоимость'), money(total(whole)), `${num(whole.pm)} ${e(tr('cost_person_meals', 'приёмов пищи').toLowerCase())}`),
            card(tr('cost_now_dds', 'Расход прасада по кассе'), inc ? money(inc.expense) : '—', e(tr('cost_now_dds_hint', 'то, что в финансах отнесено на прасад ретрита'))),
            card(tr('cost_income', 'Доход прасада'), inc ? money(inc.full) : '—', ''),
            card(tr('cost_result', 'Результат'), inc && ps !== 'none' ? money(inc.full - total(whole)) : '—', '', inc && ps !== 'none' ? resCls(inc.full - total(whole)) : '')
        ];
    } else {
        const passed = days(view.from, n.today);
        const t0 = n.toDate ? total(n.toDate) : 0;
        const perMeal = n.toDate?.pm ? t0 / n.toDate.pm : 0;
        const forecastRest = n.remainingPm * perMeal;
        const forecast = t0 + forecastRest;
        head = `${tr('cost_now_running', 'Идёт')} ${passed}-${tr('cost_now_day', 'й день из')} ${total_days}`;
        cards = [
            card(tr('cost_now_spent', 'Потрачено на сегодня'), money(t0), `${num(n.toDate?.pm || 0)} ${e(tr('cost_person_meals', 'приёмов пищи').toLowerCase())} · ${money2(perMeal)} ${e(tr('cost_now_per_meal', 'за приём'))}`),
            card(tr('cost_now_dds', 'Расход прасада по кассе'), inc ? money(inc.expense) : '—', e(tr('cost_now_dds_hint', 'то, что в финансах отнесено на прасад ретрита'))),
            card(tr('cost_now_remaining', 'Осталось приёмов пищи'), num(n.remainingPm), `${e(tr('cost_now_forecast_rest', 'прогноз'))} ${money(forecastRest)}`),
            card(tr('cost_now_forecast_total', 'Прогноз себестоимости'), money(forecast), e(tr('cost_now_forecast_hint', 'потрачено + оставшиеся приёмы × стоимость приёма на сегодня'))),
            card(tr('cost_income', 'Доход прасада'), inc ? money(inc.full) : '—', e(tr('cost_now_income_hint', 'пришло за ретрит на сегодня'))),
            card(tr('cost_now_forecast_result', 'Прогноз результата'), inc && ps !== 'none' ? money(inc.full - forecast) : '—', '', inc && ps !== 'none' ? resCls(inc.full - forecast) : '')
        ];
    }
    const pct = n.status === 'after' ? 100 : n.status === 'before' ? 0 : Math.round(days(view.from, n.today) / total_days * 100);
    box.innerHTML = `<div class="flex flex-wrap items-center gap-3 mb-4">
            <div class="font-semibold">${e(head)}</div>
            <progress class="progress progress-primary w-56" value="${pct}" max="100"></progress>
            <span class="text-sm opacity-60">${e(DateUtils.formatRange(view.from, view.to))}</span>
        </div>
        ${ps === 'none' ? `<div class="alert alert-warning text-sm mb-4">${e(tr('cost_w_no_prices_all', 'Цены ещё не внесены ни на один продукт — продукты и посуда считаются как 0'))}</div>` : ''}
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">${cards.join('')}</div>`;
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
    const monthLabel = ym => { const l = DateUtils.parseDate(ym + '-01').toLocaleDateString(locale(), { month: 'short', year: '2-digit' }); return l.replace(' г.', ''); };
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
    parts.push(monthKeys.length > 1 ? chartCard('chMonths', tr('cost_ch_months', 'Стоимость приёма пищи по месяцам'), tr('cost_ch_months_note', 'Столбики — из чего складываются расходы месяца, линия — стоимость одного приёма пищи'))
        : emptyCard(tr('cost_ch_months', 'Стоимость приёма пищи по месяцам'), tr('cost_ch_need_months', 'Выберите период длиннее месяца — квартал или год')));

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

    if (monthKeys.length > 1) charts.push(new Chart(document.getElementById('chMonths'), {
        data: { labels: monthKeys.map(monthLabel), datasets: [
            { type: 'line', label: tr('cost_per_meal', 'На приём пищи'), data: mData.map(x => x.pm ? total(x) / x.pm : null), borderColor: '#111827', backgroundColor: '#111827', yAxisID: 'y1', tension: 0.3 },
            { type: 'bar', label: tr('cost_food', 'Продукты'), data: mData.map(x => x.food), backgroundColor: PART_COLORS.food, stack: 's' },
            { type: 'bar', label: tr('cost_dishware', 'Посуда'), data: mData.map(x => x.dish), backgroundColor: PART_COLORS.dish, stack: 's' },
            { type: 'bar', label: tr('cost_external', 'Готовое'), data: mData.map(x => x.ext), backgroundColor: PART_COLORS.ext, stack: 's' },
            { type: 'bar', label: tr('cost_overhead', 'Накладные'), data: mData.map(x => overhead(x)), backgroundColor: PART_COLORS.ov, stack: 's' }
        ] },
        options: { ...base, plugins: { ...base.plugins, tooltip: moneyTip },
            scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: money0 } },
                      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { callback: v => money0(v) } } } }
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
// Стоимость человека = его приёмы пищи из меню × стоимость одного приёма пищи его ячейки
// (ретрит или «без события» × категория), поэтому сумма по людям = итог сводки.
function personRows(match) {
    const cells = view.result.cells;
    const rate = {};
    const rateOf = (ev, bucket) => {
        const k = `${ev}|${bucket}`;
        if (!(k in rate)) { const x = aggregate(cells, ev, [bucket]); rate[k] = x.pm ? total(x) / x.pm : 0; }
        return rate[k];
    };
    // стоимость есть только у приёмов пищи из меню — дни без меню не считаем, иначе сумма разойдётся с итогом
    const served = view.served || (view.served = new Set(view.result.mealRecords.filter(r => !r.unallocated).map(r => `${r.date}|${r.meal}`)));
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
        const meals = (x.breakfast && served.has(`${x.d}|breakfast`) ? 1 : 0) + (x.lunch && served.has(`${x.d}|lunch`) ? 1 : 0);
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
            ${withBucket ? `<td class="text-xs opacity-70">${e(BUCKET_LABELS[p.bucket]())}</td>` : ''}
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

// Приходы прасада ретрита (операции из отчёта по ретриту) — по всем статьям блока «Прасад»
async function loadIncomeOps(retreatId) {
    const inc = view.incomes[retreatId];
    if (!inc || view.incomeOps[retreatId]) return;
    const parts = await Promise.all(inc.groups.map(g => Layout.db.rpc('fin_get_report_drilldown',
        { p_object: inc.objectId, p_unit: 'prasad', p_direction: 'in', p_group: g })));
    view.incomeOps[retreatId] = parts.flatMap(({ data }) => data?.ok ? data.result.rows : []).map(r => ({
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
        const key = `eaters:${row.key}`;
        const deptBucket = row.ev === 'none' && (row.buckets[0] === 'team' || row.buckets[0] === 'volunteers') ? row.buckets[0] : null;
        const deptLink = deptBucket ? ` <button class="btn btn-ghost btn-xs text-primary" data-action="open-dept" data-bucket="${deptBucket}">${e(tr('cost_to_departments', 'По департаментам →'))}</button>` : '';
        const open = expanded.has(key)
            ? `<tr><td colspan="7" class="bg-base-200/40 pl-8">${peopleTable(personRows((xr, ev) => ev === row.ev && row.buckets.includes(xr.bucket)), row.buckets.length > 1)}</td></tr>` : '';
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
    const scope = scopeEvents();
    const buckets = deptFilter === 'team' ? ['team'] : deptFilter === 'volunteers' ? ['volunteers'] : ['team', 'volunteers'];
    const people = personRows((x, ev) => (!scope || scope.includes(ev)) && buckets.includes(x.bucket));
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
        const opId = l.postingId ? view.opByPosting.get(l.postingId) : null;
        const labelHtml = opId ? `<a class="link link-hover" href="${DDS_URL(opId)}" target="_blank" rel="noopener" title="${e(tr('fin_open_in_dds', 'Открыть в ДДС'))}">${e(label)}</a>` : e(label);
        return { from: l.from, html: `<tr class="${l.unallocated ? 'text-warning' : ''}">
            <td class="text-sm">${labelHtml}${l.estimate ? ` <span class="badge badge-warning badge-xs">${e(tr('cost_estimate', 'оценка'))}</span>` : ''}${l.comment ? `<div class="text-xs opacity-60">${e(l.comment)}</div>` : ''}</td>
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
            <td class="text-right ${diff !== null && Math.abs(diff) > Math.max(fact, model || 0) * reconcileThreshold / 100 ? 'text-warning font-medium' : ''}">${diff === null ? e(tr('cost_reconcile_na', 'нет в модели')) : money(diff)}</td>
        </tr>${open}`;
    }).join('') + `<tr class="font-semibold border-t-2 border-base-300">
        <td class="text-sm">${e(tr('cost_reconcile_total', 'Итого сопоставимых'))}</td>
        <td class="text-right">${money(modelSum)}</td>
        <td class="text-right">${money(factSum)}</td>
        <td class="text-right ${Math.abs(modelSum - factSum) > Math.max(factSum, modelSum) * reconcileThreshold / 100 ? 'text-warning' : ''}">${money(modelSum - factSum)}</td>
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
        section: state.section, tab: state.tab, dataTab: state.dataTab })); } catch { /* нет хранилища */ }
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
        case 'toggle-row':
            if (ev.target.closest('a, button')) break;
            if (expanded.has(btn.dataset.key)) expanded.delete(btn.dataset.key); else expanded.add(btn.dataset.key);
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
        case 'toggle-recon': {
            const key = btn.dataset.key;
            if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
            renderReconcile();
            if (expanded.has(key)) loadDirectPostings().then(() => view && renderReconcile());
            break;
        }
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
    state.section = ['calc', 'now', 'charts', 'data'].includes(saved.section) ? saved.section : 'calc';
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
