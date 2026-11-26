// Финансы → «Итоги» (ВГ 24–26.11.2026): месяц, департамент, ретрит, сравнения, лист для Ачинтьи Кришны.
// Данные месяца — fin_itogi_month_rows (мигр. 827), раскрытие до операций — fin_itogi_month_ops (829),
// ретрит целиком — fin_get_retreat_report. Всё в рупиях по курсу на день операции.
(function () {
'use strict';

const e = s => Layout.escapeHtml(s == null ? '' : String(s));
const FIRST_MONTH = '2026-08-01';
const MONTH_NAMES = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
// «к октябрю», «к сентябрю» — дательный
const MONTH_DAT = ['январю','февралю','марту','апрелю','маю','июню','июлю','августу','сентябрю','октябрю','ноябрю','декабрю'];
const UTILITIES = ['Электричество', 'Вода', 'Насос', 'Интернет'];
const SHOP_CATS = ['Мурти', 'Касса Магазин', 'Пожертвования в магазин'];
const PAL = ['#2f7f6a','#c9743e','#5b7fb5','#9b5aa6','#c2a23a','#4fa39a','#b85a6a','#7a8a3a','#8a6a50','#6a6aa8','#999','#555','#bbb','#3f6f8f','#a0522d','#6b8e23'];
const COST_COMPONENTS = { food: 'Продукты', dish: 'Посуда', ext: 'Готовое со стороны', payroll: 'Зарплаты кухни',
    equipment: 'Оборудование', utilities: 'Газ и коммунальные', household: 'Хозтовары', retreat: 'Траты кухни на ретрит' };

const st = {
    tab: 'month', month: null, months: [], rows: {}, ops: {}, opsErr: {},
    depts: [], dept: null, retreats: [], retreat: null, reports: {},
    rSort: { k: 'inc', d: -1 }, rSel: new Set(), openMonthsRows: new Set()
};

// ==================== формат ====================
// Суммы полностью, с нулями и ₹ (ВГ 26.11): 4 895 000 ₹
const fmt = v => v == null || Number.isNaN(v) ? '—' : Math.round(Number(v)).toLocaleString('ru-RU') + ' ₹';
const fmtS = v => (v > 0 ? '+' : '') + fmt(v);
const sum = (list, f = x => x.amount) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const mLabel = iso => { const d = DateUtils.parseDate(iso); return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`; };
const mShort = iso => MONTH_NAMES[DateUtils.parseDate(iso).getMonth()];
const mDat = iso => MONTH_DAT[DateUtils.parseDate(iso).getMonth()];
const dShort = iso => { const d = DateUtils.parseDate(iso); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`; };
const dFull = iso => `${dShort(iso)}.${DateUtils.parseDate(iso).getFullYear()}`;
const curMonth = () => { const n = new Date(); return DateUtils.toISO(new Date(n.getFullYear(), n.getMonth(), 1)); };
function delta(cur, prev, goodUp) {
    if (prev == null || !prev) return '';
    if ((cur < 0) !== (prev < 0)) return '';   // при смене знака процент ничего не говорит
    const p = Math.round((cur - prev) / Math.abs(prev) * 100);
    const up = p >= 0;
    return `<span class="${up === goodUp ? 'up' : 'down'}">${up ? '+' : ''}${p}%</span>`;
}
const CUR_SIGN = { INR: '₹', USD: '$', EUR: '€', RUB: '₽' };

// ==================== загрузка ====================
async function loadRows(m) {
    if (st.rows[m]) return st.rows[m];
    const { data, error } = await Layout.db.rpc('fin_itogi_month_rows', { p_month: m });
    if (error) { Layout.handleError(error, 'Итоги'); return []; }
    st.rows[m] = (data || []).map(r => ({ ...r, amount: Number(r.amount) || 0 }));
    return st.rows[m];
}
async function loadOps(m) {
    if (st.ops[m]) return st.ops[m];
    if (st.opsErr[m]) return null;
    const { data, error } = await Layout.db.rpc('fin_itogi_month_ops', { p_month: m });
    if (error) { st.opsErr[m] = error.message || 'ошибка'; return null; }
    st.ops[m] = (data || []).map(r => ({ ...r, amount: Number(r.amount) || 0 }));
    return st.ops[m];
}
async function loadReport(id) {
    if (st.reports[id] !== undefined) return st.reports[id];
    const { data, error } = await Layout.db.rpc('fin_get_retreat_report', { p_retreat: id });
    st.reports[id] = error || !data?.ok || !data.result?.exists ? null : data.result;
    return st.reports[id];
}
const monthOut = m => (st.rows[m] || []).filter(r => r.side === 'out');
const monthIn = m => (st.rows[m] || []).filter(r => r.side === 'in');
const tot = (m, side) => sum((st.rows[m] || []).filter(r => r.side === side));
const prevOf = m => { const i = st.months.indexOf(m); return i > 0 ? st.months[i - 1] : null; };
function avgBefore(m, side) {
    const prev = st.months.slice(0, st.months.indexOf(m));
    return prev.length ? sum(prev, x => tot(x, side)) / prev.length : null;
}

// ==================== дерево ====================
// Узел: { name, amount, key, kids, nodata, hint }. key — поля строки, по которым ищутся операции.
function groupTree(rows, levelsOf, depth = 0, baseKey = {}) {
    const map = new Map();
    for (const r of rows) {
        const lv = levelsOf(r);
        if (depth >= lv.length) continue;
        const [f, v, label] = lv[depth];
        const k = String(v);
        let n = map.get(k);
        if (!n) map.set(k, n = { name: label || v || '—', amount: 0, key: { ...baseKey, [f]: v }, rows: [] });
        n.amount += r.amount;
        n.rows.push(r);
    }
    const out = [...map.values()];
    for (const n of out) { n.kids = groupTree(n.rows, levelsOf, depth + 1, n.key); delete n.rows; }
    return sortNodes(out);
}
function sortNodes(list) {
    return list.sort((a, b) => (a.nodata ? 1 : 0) - (b.nodata ? 1 : 0) || Math.abs(b.amount) - Math.abs(a.amount));
}

const INCOME_LABELS = { 'За прасад / талончики': 'Пожертвования за прасад / талончики', 'Оплата проживания (в не ретритов)': 'Проживание (вне ретритов)' };
const incomeLabel = (f, v) => f === 'sub' && INCOME_LABELS[v] ? INCOME_LABELS[v] : v;
const incomeLevels = r => {
    const lv = [['grp', r.grp], ['sub', r.sub, incomeLabel('sub', r.sub)]];
    if (r.item != null) lv.push(['item', r.item]);
    return lv;
};
// У «Ретритов» — ретрит → кто платил → статья (ВГ 26.11)
const expenseLevels = r => r.dept === 'Ретриты'
    ? [['dept', r.dept], ['sub', r.sub], ['item', r.item, 'Платил: ' + (r.item || '—')], ['grp', r.grp]]
    : [['dept', r.dept], ['grp', r.grp]];

function incomeTree(rows) {
    const nodes = groupTree(rows, incomeLevels);
    // строка «Пожертвования за прасад / талончики» — всегда, даже с нулём
    let don = nodes.find(n => n.key.grp === 'Пожертвования');
    if (!don) nodes.push(don = { name: 'Пожертвования', amount: 0, key: { grp: 'Пожертвования' }, kids: [] });
    if (!don.kids.some(k => k.key.sub === 'За прасад / талончики'))
        don.kids.push({ name: 'Пожертвования за прасад / талончики', amount: 0, key: { grp: 'Пожертвования', sub: 'За прасад / талончики' }, kids: [] });
    return sortNodes(nodes);
}
function expenseTree(rows) {
    const nodes = groupTree(rows, expenseLevels);
    // все департаменты списком, даже с нулём (ВГ 26.11)
    const names = [...st.depts, 'Ретриты', 'Общие траты ШРСК'];
    for (const d of names) if (!nodes.some(n => n.key.dept === d)) nodes.push({ name: d, amount: 0, key: { dept: d }, kids: [] });
    // электричество, вода, насос, интернет — строки «нет данных», пока не внесены
    const common = nodes.find(n => n.key.dept === 'Общие траты ШРСК');
    for (const u of UTILITIES) common.kids.push({ name: u, amount: null, nodata: true, kids: [], key: null });
    sortNodes(common.kids);
    return sortNodes(nodes);
}

// side — для поиска операций; color — цвет полоски; total — шкала верхнего уровня
function treeHtml(nodes, total, side, color, opts = {}) {
    return nodes.map(n => {
        const w = total ? Math.max(n.amount ? 1 : 0, Math.min(100, Math.round(Math.abs(n.amount || 0) / Math.abs(total) * 100))) : 0;
        const amt = n.nodata ? '<span class="nodata">нет данных</span>'
            : !n.amount ? '<span class="zero num">0 ₹</span>'
            : `<span class="num ${opts.amtCls || ''}">${fmt(n.amount)}</span>`;
        const head = `<summary><span class="chev">▶</span><span class="name">${e(n.name)}${n.hint ? ` <span class="note">· ${e(n.hint)}</span>` : ''}<span class="share"><i style="width:${w}%;background:${color}"></i></span></span>${amt}</summary>`;
        let body;
        if (n.kids?.length) body = treeHtml(n.kids, n.amount, side, color, { ...opts, amtCls: '' });
        else if (n.nodata) body = `<div class="ops note">Счёт ещё не внесён. Платит строительная касса; когда внесём — ляжет в департаменты по процентам.</div>`;
        else if (n.calc) body = `<div class="ops note">${e(n.calc)}</div>`;
        else if (n.drill) body = `<div class="ops" data-drill='${e(JSON.stringify(n.drill))}'></div>`;
        else if (n.key && n.amount) body = `<div class="ops" data-ops='${e(JSON.stringify({ m: opts.month || st.month, side, key: n.key, total: n.amount }))}'></div>`;
        else body = `<div class="ops note">Операций нет.</div>`;
        return `<details>${head}${body}</details>`;
    }).join('');
}

// раскрытие до операций — при открытии строки
document.addEventListener('toggle', ev => {
    const d = ev.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    const box = d.querySelector(':scope > .ops[data-ops], :scope > .ops[data-drill]');
    if (!box || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    if (box.dataset.ops) fillOps(box, JSON.parse(box.dataset.ops));
    else fillDrill(box, JSON.parse(box.dataset.drill));
}, true);

function opHtml(o) {
    const orig = o.currency && o.currency !== 'INR'
        ? `<div class="meta">${Number(o.amount_orig).toLocaleString('ru-RU')} ${CUR_SIGN[o.currency] || o.currency}</div>` : '';
    const part = o.amount_full != null && Math.abs(Number(o.amount_full) - o.amount) > 1
        ? `<div class="meta">из ${fmt(o.amount_full)}</div>` : '';
    const meta = [o.who, o.account, o.note].filter(Boolean).map(e).join(' · ');
    return `<a class="op" href="dds.html?op=${encodeURIComponent(o.operation_id)}" target="_blank" rel="noopener">
        <span class="num">${dFull(o.occurred_on)}</span>
        <span><span>${e(o.comment || '—')}</span>${meta ? `<div class="meta">${meta}</div>` : ''}</span>
        <span class="text-right"><span class="num ${o.amount < 0 ? 'c-out' : ''}">${fmt(o.amount)}</span>${part}${orig}</span></a>`;
}
async function fillOps(box, { m, side, key, total }) {
    box.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
    const ops = await loadOps(m);
    if (!ops) { box.innerHTML = `<div class="note">Раскрытие до операций пока недоступно: ${e(st.opsErr[m])}</div>`; return; }
    const list = ops.filter(o => o.side === side && Object.entries(key).every(([f, v]) => o[f] === v))
        .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || Math.abs(b.amount) - Math.abs(a.amount));
    const s = sum(list);
    const diff = total != null && Math.abs(s - total) > 1
        ? `<div class="warnbox mt-1"><b>⚠ Сумма операций ${fmt(s)} не сходится со строкой ${fmt(total)}</b></div>` : '';
    box.innerHTML = `<div class="note mb-1">${list.length} ${Layout.pluralize(list.length, { ru: ['операция', 'операции', 'операций'], en: ['operation', 'operations'], hi: 'ऑपरेशन' })} · ${fmt(s)} · клик открывает операцию в ДДС</div>${diff}${list.map(opHtml).join('')}`;
}
async function fillDrill(box, { object, unit, dir, group }) {
    box.innerHTML = '<span class="loading loading-spinner loading-xs"></span>';
    const { data, error } = await Layout.db.rpc('fin_get_report_drilldown', { p_object: object, p_unit: unit, p_direction: dir, p_group: group });
    if (error || !data?.ok) { box.innerHTML = `<div class="note">Не удалось загрузить: ${e(data?.error?.message || error?.message)}</div>`; return; }
    const rows = data.result.rows || [];
    box.innerHTML = `<div class="note mb-1">${rows.length} · ${fmt(data.result.total_base)} · весь ретрит</div>` + rows.map(r => opHtml({
        operation_id: r.operation_id, occurred_on: r.occurred_on, comment: r.description || r.reason,
        who: r.participant, account: r.account, currency: r.currency, amount_orig: r.amount, amount: Number(r.amount_base)
    })).join('');
}

// ==================== вкладка «Месяц» ====================
function utilWarn(m) {
    return `<div class="warnbox"><b>⚠ Нет данных за ${mShort(m).toLowerCase()}: ${UTILITIES.join(', ').toLowerCase()} (4 строки).</b>
        Строки стоят в «Общих тратах ШРСК» и встанут в департаменты по процентам, когда счёт будет внесён.</div>`;
}
function cmpLine(m, side, good) {
    const p = prevOf(m);
    if (!p) return 'первый месяц учёта, сравнивать не с чем';
    const cur = tot(m, side);
    const avg = avgBefore(m, side);
    return `к ${mDat(p)}: ${delta(cur, tot(p, side), good) || '—'} · к среднему: ${delta(cur, avg, good) || '—'}`;
}
function renderMonth() {
    const m = st.month;
    const ti = tot(m, 'in'), te = tot(m, 'out');
    const going = m === curMonth() ? '<div class="note">Месяц ещё идёт — цифры неполные.</div>' : '';
    document.getElementById('p-month').innerHTML = `
        <div class="box totals">
            <div><div class="lbl">Приход</div><div class="big num c-in">${fmt(ti)}</div><div class="cmp">${cmpLine(m, 'in', true)}</div></div>
            <div><div class="lbl">Расход</div><div class="big num c-out">${fmt(te)}</div><div class="cmp">${cmpLine(m, 'out', false)}</div></div>
            <div><div class="lbl">Итог месяца</div><div class="big num">${fmtS(ti - te)}</div><div class="cmp">в рупиях, по месяцу, к которому относится платёж</div>${going}</div>
        </div>
        ${utilWarn(m)}
        <div class="cols">
            <div class="box"><h2>Приход <span class="num c-in">${fmt(ti)}</span></h2>${treeHtml(incomeTree(monthIn(m)), ti, 'in', 'var(--bar-in)')}
                <p class="note mt-2">Ретрит в двух месяцах делится по дням. Предоплаты будущих ретритов, Клуб 108 и «Принято под сдачу» в приход не входят.</p></div>
            <div class="box"><h2>Расход по департаментам <span class="num c-out">${fmt(te)}</span></h2>${treeHtml(expenseTree(monthOut(m)), te, 'out', 'var(--bar-out)')}
                <p class="note mt-2">Трата стоит у департамента своего счёта. Трата с привязкой к ретриту — у «Ретритов» (кроме Кухни и Кафе), видно, кто платил. Зарплата, газ, аренда — по месяцу «за …» из комментария.</p></div>
        </div>
        <div class="box chart"><h2>Расход по месяцам</h2>${stackChart()}</div>`;
}

function deptNames() {
    const all = new Set();
    st.months.forEach(m => monthOut(m).forEach(r => all.add(r.dept)));
    const order = [...st.depts, 'Ретриты', 'Общие траты ШРСК'];
    return [...order.filter(d => all.has(d)), ...[...all].filter(d => !order.includes(d))];
}
const deptOut = (m, d) => sum(monthOut(m).filter(r => r.dept === d));
const deptIn = (m, d) => sum(monthIn(m).filter(r => r.dept === d));

function axisTicks(max) {
    const step = Math.pow(10, Math.floor(Math.log10(max || 1)));
    const s = [1, 2, 5, 10].map(k => k * step).find(x => max / x <= 5) || step * 10;
    const ticks = [];
    for (let v = 0; v <= max * 1.001; v += s) ticks.push(v);
    return ticks;
}
function stackChart() {
    const depts = deptNames();
    const W = 680, H = 250, L = 104, B = 26, T = 18;
    const totals = st.months.map(m => tot(m, 'out'));
    const max = Math.max(1, ...totals) * 1.1;
    const step = (W - L - 16) / st.months.length, bw = Math.min(90, step * 0.6);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Расход по месяцам по департаментам">`;
    for (const v of axisTicks(max)) { const y = H - B - v / max * (H - B - T); s += `<line x1="${L}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`; }
    st.months.forEach((m, i) => {
        let y0 = H - B; const x = L + i * step + (step - bw) / 2;
        depts.forEach((d, j) => { const v = deptOut(m, d); if (v <= 0) return; const h = v / max * (H - B - T); y0 -= h;
            s += `<rect x="${x}" y="${y0}" width="${bw}" height="${h}" fill="${PAL[j % PAL.length]}"><title>${e(d)}: ${fmt(v)}</title></rect>`; });
        s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${mShort(m)}</text><text x="${x + bw / 2}" y="${y0 - 4}" text-anchor="middle" style="fill:#1d2420;font-weight:600">${fmt(totals[i])}</text>`;
    });
    return s + '</svg><div class="legend">' + depts.map((d, j) => `<span><i style="background:${PAL[j % PAL.length]}"></i>${e(d)}</span>`).join('') + '</div>';
}
function pairChart(vals, label) {   // vals: [{m, in, out}]
    const W = 680, H = 210, L = 104, B = 26, T = 18;
    const max = Math.max(1, ...vals.map(v => Math.max(v.in, v.out))) * 1.15;
    const step = (W - L - 16) / vals.length, bw = Math.min(40, step * 0.3);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(label)}">`;
    for (const v of axisTicks(max)) { const y = H - B - v / max * (H - B - T); s += `<line x1="${L}" x2="${W - 8}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`; }
    vals.forEach((v, i) => {
        const cx = L + i * step + step / 2;
        [['in', -bw - 2, 'var(--bar-in)'], ['out', 2, 'var(--bar-out)']].forEach(([k, dx, c]) => {
            const val = Math.max(0, v[k]); const h = val / max * (H - B - T);
            s += `<rect x="${cx + dx}" y="${H - B - h}" width="${bw}" height="${h}" fill="${c}"><title>${fmt(v[k])}</title></rect>`;
            if (val) s += `<text x="${cx + dx + bw / 2}" y="${H - B - h - 4}" text-anchor="middle" style="fill:#1d2420;font-size:10px">${fmt(v[k])}</text>`;
        });
        s += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${mShort(v.m)}</text>`;
    });
    return s + '</svg><div class="legend"><span><i style="background:var(--bar-in)"></i>Приход</span><span><i style="background:var(--bar-out)"></i>Расход</span></div>';
}

// ==================== вкладка «Департамент» ====================
async function renderDept() {
    const m = st.month;
    const box = document.getElementById('p-dept');
    if (!st.dept || !st.depts.includes(st.dept)) st.dept = st.depts.includes('Кухня') ? 'Кухня' : st.depts[0];
    const d = st.dept;
    const outRows = monthOut(m).filter(r => r.dept === d);
    const inRows = monthIn(m).filter(r => r.dept === d);
    const te = sum(outRows), ti = sum(inRows), p = prevOf(m);
    box.innerHTML = `
        <div class="flex flex-wrap items-center gap-2"><label for="deptSelect" class="note">Департамент</label>
            <select id="deptSelect" class="select select-bordered select-sm font-semibold">${st.depts.map(x => `<option ${x === d ? 'selected' : ''}>${e(x)}</option>`).join('')}</select>
            <span class="note">· ${mLabel(m)}</span></div>
        <div class="tiles">
            <div class="tile"><div class="lbl">Выделено</div><div class="v num" id="allocTotal"><span class="loading loading-spinner loading-xs"></span></div><div class="s">выдачи ШРСК и от других департаментов</div></div>
            <div class="tile"><div class="lbl">Потрачено</div><div class="v num c-out">${fmt(te)}</div><div class="s">${p ? `к ${mDat(p)}: ${delta(te, deptOut(p, d), false) || '—'}` : '&nbsp;'}</div></div>
            <div class="tile"><div class="lbl">Приход</div><div class="v num c-in">${fmt(ti)}</div><div class="s">${inRows.length ? 'по статьям ниже' : 'приходов нет'}</div></div>
            <div class="tile"><div class="lbl">Результат</div><div class="v num">${inRows.length ? fmtS(ti - te) : '—'}</div><div class="s">${inRows.length ? (ti - te >= 0 ? 'прибыль' : 'убыток') : 'только траты'}</div></div>
        </div>
        <div class="box" id="allocBox"><h2>Выделено</h2><span class="loading loading-spinner loading-xs"></span></div>
        <div class="cols">
            <div class="box"><h2>Приход <span class="num c-in">${fmt(ti)}</span></h2>${inRows.length ? treeHtml(groupTree(inRows, incomeLevels, 0, { dept: d }), ti, 'in', 'var(--bar-in)') : '<p class="note">У департамента в этом месяце приходов нет.</p>'}</div>
            <div class="box"><h2>Потрачено <span class="num c-out">${fmt(te)}</span></h2>${outRows.length ? treeHtml(groupTree(outRows, r => [['dept', r.dept], ['grp', r.grp]]).flatMap(n => n.kids), te, 'out', 'var(--bar-out)') : '<p class="note">Трат нет — департамент в списке, чтобы было видно ноль.</p>'}
                <p class="note mt-2">Перекидка между департаментами — не приход и не расход: трата стоит у того, кто потратил; деньги от другого департамента видны строкой «Получено от департамента» в «Выделено».</p></div>
        </div>
        <div class="box chart"><h2>${e(d)} по месяцам</h2>${pairChart(st.months.map(x => ({ m: x, in: deptIn(x, d), out: deptOut(x, d) })), 'Приход и расход департамента по месяцам')}</div>`;
    document.getElementById('deptSelect').onchange = ev => { st.dept = ev.target.value; renderDept(); };

    const ops = await loadOps(m);
    if (st.tab !== 'dept' || st.dept !== d || st.month !== m) return;
    const allocBox = document.getElementById('allocBox');
    if (!ops) {
        document.getElementById('allocTotal').textContent = '—';
        allocBox.innerHTML = `<h2>Выделено</h2><p class="note">Пока недоступно: ${e(st.opsErr[m])}</p>`;
        return;
    }
    const alloc = ops.filter(o => o.side === 'alloc' && o.dept === d);
    const given = sum(alloc.filter(o => o.grp === 'Выдано ШРСК' || o.grp === 'Получено от департамента'));
    document.getElementById('allocTotal').textContent = fmt(given);
    const nodes = groupTree(alloc, o => [['grp', o.grp], ['sub', o.sub]]);
    const scale = Math.max(1, ...nodes.map(n => Math.abs(n.amount)));
    allocBox.innerHTML = `<h2>Выделено <span class="num">${fmt(given)}</span></h2>
        ${nodes.length ? treeHtml(nodes, scale, 'alloc', 'var(--bar-in)') : '<p class="note">Выдач в этом месяце не было.</p>'}
        <p class="note mt-2">«Выдано ШРСК» — с Кассы ДДС, Кассы ДДС у ГХ, ИП и карт ИП. «Сдано в кассу» и «Передано департаменту» — с минусом. Обмен валют внутри департамента не считается.</p>`;
}

// ==================== вкладка «Ретрит» ====================
function retreatParts(rep, retreat) {
    const r = rep.report;
    const sub = (main, part) => {
        const by = new Map((part || []).map(x => [x.category_id, Number(x.base_total) || 0]));
        return (main || []).map(x => ({ ...x, base_total: (Number(x.base_total) || 0) - (by.get(x.category_id) || 0) }))
            .filter(x => Math.abs(x.base_total) > 0.5);
    };
    let inc = sub(sub(r.income_by_category, r.cafe?.income_by_category), r.prasad?.income_by_category);
    let exp = sub(sub(r.expense_by_category, r.cafe?.expense_by_category), r.prasad?.expense_by_category);
    const shop = inc.filter(x => SHOP_CATS.includes(x.name));
    // «Принято под сдачу» / «Сдача участнику» — пара сдачи, не деньги ретрита
    inc = inc.filter(x => !SHOP_CATS.includes(x.name) && x.name !== 'Принято под сдачу');
    exp = exp.filter(x => x.name !== 'Сдача участнику');
    const cost = r.prasad_cost?.data;
    const included = cost && cost.included != null ? Number(cost.included) : null;
    const comps = cost?.components ? (cost.settings?.components || Object.keys(cost.components))
        .map(k => ({ name: COST_COMPONENTS[k] || k, base_total: Number(cost.components[k]) || 0 })).filter(x => Math.abs(x.base_total) > 0.5) : [];
    const gaps = cost?.gaps ? (cost.gaps.noMenu || 0) + (cost.gaps.missingPrices || 0) : 0;
    const val = (list, id) => sum(list.filter(x => x.category_id === id), x => x.base_total);
    const n = {
        org: val(inc, 'org_fee'), acc: val(inc, 'accommodation'),
        food: sum(r.prasad?.income_by_category || [], x => x.base_total),
        cafe: Number(r.cafe?.totals?.income_base) || 0,
        shop: sum(shop, x => x.base_total),
        retIn: sum(inc, x => x.base_total), retOut: sum(exp, x => x.base_total),
        cafeOut: Number(r.cafe?.totals?.expense_base) || 0, cost: included,
        people: r.participants?.count || null
    };
    n.oth = n.retIn - n.org - n.acc;
    n.inc = n.retIn + n.food + n.cafe + n.shop;
    n.exp = n.retOut + n.cafeOut;
    n.res = n.inc - n.retOut - (n.cost || 0) - n.cafeOut;
    n.pp = n.people ? n.inc / n.people : null;
    const days = DateUtils.parseDate(retreat.end_date) - DateUtils.parseDate(retreat.start_date);
    n.days = Math.round(days / 86400000) + 1;
    return { r, inc, exp, shop, comps, included, gaps, n, object: rep.object_id };
}
const catNodes = (list, drill) => sortNodes(list.map(x => ({ name: x.name === 'Без привязки к блоку' ? 'Аванс, не распределён' : x.name,
    amount: x.base_total, kids: [], drill: drill && x.category_id ? { ...drill, group: x.category_id } : null })));

async function renderRetreat() {
    const box = document.getElementById('p-retreat');
    if (!st.retreats.length) { box.innerHTML = '<p class="note">Ретритов с августа 2026 нет.</p>'; return; }
    if (!st.retreat) st.retreat = st.retreats[st.retreats.length - 1].id;
    const rt = st.retreats.find(x => x.id === st.retreat);
    const sel = `<div class="flex flex-wrap items-center gap-2"><label for="retSelect" class="note">Ретрит</label>
        <select id="retSelect" class="select select-bordered select-sm font-semibold max-w-full">${st.retreats.map(x => `<option value="${x.id}" ${x.id === rt.id ? 'selected' : ''}>${e(x.name_ru)}</option>`).join('')}</select>
        <span class="note">· ${dFull(rt.start_date)}–${dFull(rt.end_date)} · весь ретрит, без деления на месяцы</span></div>`;
    box.innerHTML = sel + '<div class="text-center py-6"><span class="loading loading-spinner loading-md"></span></div>';
    const bind = () => { document.getElementById('retSelect').onchange = ev => { st.retreat = ev.target.value; renderRetreat(); }; };
    bind();
    const rep = await loadReport(rt.id);
    await Promise.all(st.months.filter(m => m <= rt.end_date && DateUtils.toISO(new Date(DateUtils.parseDate(m).getFullYear(), DateUtils.parseDate(m).getMonth() + 1, 0)) >= rt.start_date).map(loadRows));
    if (st.tab !== 'retreat' || st.retreat !== rt.id) return;
    if (!rep) { box.innerHTML = sel + '<p class="note">По ретриту нет финансовых данных.</p>'; bind(); return; }
    const P = retreatParts(rep, rt), n = P.n;
    const drill = unit => dir => ({ object: P.object, unit, dir });
    const part = (title, inList, outList, opts = {}) => {
        const i = sum(inList, x => x.amount), o = opts.outNoData ? 0 : sum(outList, x => x.amount);
        const scale = Math.max(i, o, 1);
        return `<div class="box"><h2>${title} <span class="num">${opts.outNoData ? '—' : fmtS(i - o)}</span></h2>
            <div class="note">Пришло ${fmt(i)} · ушло ${opts.outNoData ? 'не посчитано' : fmt(o)}</div>
            ${inList.length ? treeHtml([{ name: 'Пришло', amount: i, kids: inList }], scale, 'in', 'var(--bar-in)', { amtCls: 'c-in' }) : '<p class="note">Приходов нет.</p>'}
            ${opts.outNoData ? '<p class="note mt-1">Себестоимость не посчитана.</p>' : outList.length ? treeHtml([{ name: 'Ушло', amount: o, kids: outList }], scale, 'out', 'var(--bar-out)', { amtCls: 'c-out' }) : '<p class="note">Трат нет.</p>'}
            ${opts.foot || ''}</div>`;
    };
    const costLink = `<p class="note mt-2">Прасад — начислено против себестоимости по меню. <a class="link link-primary" href="../kitchen/cost.html?retreat=${rt.id}" target="_blank" rel="noopener">Себестоимость подробно →</a></p>`;
    const pIn = catNodes(P.r.prasad?.income_by_category || [], drill('prasad')('in')).map(x => x.name === 'Прасад - пожертвование' ? { ...x, name: 'Пожертвования за прасад / талончики' } : x.name === 'Питание' ? { ...x, name: 'Получено за питание' } : x);
    const pOut = P.comps.length ? sortNodes(P.comps.map(x => ({ name: x.name, amount: x.base_total, kids: [], calc: 'Расчёт по меню и вкушающим, не операции. Подробно — на странице «Себестоимость».' }))) : [];
    const pay = P.r.participants;
    box.innerHTML = sel + `
        <div class="box totals">
            <div><div class="lbl">Пришло</div><div class="big num c-in">${fmt(n.inc)}</div><div class="cmp">ретрит, прасад, кафе, магазин и мурти</div></div>
            <div><div class="lbl">Ушло</div><div class="big num c-out">${fmt(n.retOut + (n.cost || 0) + n.cafeOut)}</div><div class="cmp">прасад — по себестоимости</div></div>
            <div><div class="lbl">Итог ретрита</div><div class="big num">${fmtS(n.res)}</div><div class="cmp">${n.people ? `${n.people} участников · на одного: пришло ${fmt(n.inc / n.people)}, ушло ${fmt((n.retOut + (n.cost || 0) + n.cafeOut) / n.people)}` : 'участников в отчёте нет'}</div></div>
        </div>
        ${P.included == null ? `<div class="warnbox"><b>⚠ Себестоимость прасада не посчитана</b> — итог ретрита без неё. <a class="link" href="../kitchen/cost.html?retreat=${rt.id}">Открыть «Себестоимость» →</a></div>`
          : P.gaps ? `<div class="warnbox"><b>⚠ В себестоимости прасада пропуски: ${P.gaps}</b> (нет меню или цен). <a class="link" href="../kitchen/cost.html?retreat=${rt.id}">Исправить в «Себестоимости» →</a></div>` : ''}
        <div class="cols">
            ${part('Ретрит', catNodes(P.inc, drill('retreat')('in')), catNodes(P.exp, drill('retreat')('out')))}
            ${part('Прасад', pIn, pOut, { outNoData: P.included == null, foot: costLink })}
        </div>
        <div class="cols">
            ${part('Кафе', catNodes(P.r.cafe?.income_by_category || [], drill('cafe')('in')), catNodes(P.r.cafe?.expense_by_category || [], drill('cafe')('out')))}
            <div class="box"><h2>Магазин и мурти <span class="num c-in">${fmt(n.shop)}</span></h2>
                ${P.shop.length ? treeHtml(catNodes(P.shop, drill('retreat')('in')), n.shop, 'in', 'var(--bar-in)') : '<p class="note">Продаж на ретрите не было.</p>'}
                <p class="note mt-2">Доход Магазина и Мастерской во время ретрита, в итог ретрита входит приходом.</p></div>
        </div>
        ${pay ? `<div class="box"><h2>Расчёты с участниками</h2><div class="tiles">
            <div class="tile"><div class="lbl">Начислено</div><div class="v num">${fmt(pay.charged)}</div></div>
            <div class="tile"><div class="lbl">Оплачено</div><div class="v num c-in">${fmt(pay.paid)}</div></div>
            <div class="tile"><div class="lbl">Долг</div><div class="v num c-out">${fmt(pay.debt_total)}</div><div class="s">${(pay.debtors || []).length} чел.</div></div>
            <div class="tile"><div class="lbl">Аванс</div><div class="v num">${fmt(pay.advance_total)}</div><div class="s">${Number(pay.advance_total) ? 'внесён, не распределён' : 'всё распределено'}</div></div></div>
            ${(pay.debtors || []).length ? `<table class="t mt-2"><tbody>${pay.debtors.map(x => `<tr><td>${e(x.name)}</td><td class="num c-out">${fmt(x.debt)}</td></tr>`).join('')}</tbody></table>` : ''}</div>` : ''}
        ${monthSplitHtml(rt, P)}`;
    bind();
}
function monthSplitHtml(rt, P) {
    const name = rt.name_ru, obj = P.r.object?.display_name || name;
    // месяцы ретрита + месяцы, где по нему что-то проведено позже (процент отделу продаж и т.п.)
    const ms = st.months.filter(m => st.rows[m] && ((m <= rt.end_date && DateUtils.toISO(new Date(DateUtils.parseDate(m).getFullYear(), DateUtils.parseDate(m).getMonth() + 1, 0)) >= rt.start_date)
        || st.rows[m].some(r => r.dept === 'Ретриты' && r.sub === name)));
    if (!ms.length) return '';
    const isMine = r => r.sub === name || (r.sub || '').startsWith(name + ' — часть');
    const cols = new Map();   // колонка → {m: сумма}
    const add = (col, m, v) => { if (!cols.has(col)) cols.set(col, {}); cols.get(col)[m] = (cols.get(col)[m] || 0) + v; };
    for (const m of ms) {
        for (const r of monthIn(m)) {
            if (r.grp === 'Ретриты' && isMine(r)) add(r.item, m, r.amount);
            else if (['Кафе', 'Магазин', 'Мурти'].includes(r.grp) && r.sub === obj) add(r.grp, m, r.amount);
        }
        for (const r of monthOut(m)) if (r.dept === 'Ретриты' && r.sub === name) add('Расход ретрита', m, -r.amount);
    }
    if (!cols.size) return '';
    const days = m => { const d0 = DateUtils.parseDate(m), d1 = new Date(d0.getFullYear(), d0.getMonth() + 1, 0);
        const a = Math.max(d0, DateUtils.parseDate(rt.start_date)), b = Math.min(d1, DateUtils.parseDate(rt.end_date));
        return b < a ? 0 : Math.round((b - a) / 86400000) + 1; };
    const names = [...cols.keys()];
    return `<div class="box"><h2>Из них по месяцам</h2><div class="overflow-x-auto"><table class="t"><thead><tr><th>Месяц</th><th>Дней</th>${names.map(c => `<th>${e(c)}</th>`).join('')}</tr></thead><tbody>
        ${ms.map(m => `<tr><td>${mLabel(m)}</td><td>${days(m) ? `${days(m)} из ${P.n.days}` : 'после ретрита'}</td>${names.map(c => { const v = cols.get(c)[m]; return `<td class="num ${v < 0 ? 'c-out' : ''}">${v ? fmt(v) : '<span class="zero">0 ₹</span>'}</td>`; }).join('')}</tr>`).join('')}
        </tbody></table></div><p class="note mt-2">Эти же цифры стоят во вкладке «Месяц». Оплаты участников и спонсора делятся по дням ретрита, кафе и магазин — по дате выручки, расходы — по дате.</p></div>`;
}

// ==================== вкладка «Сравнение месяцев» ====================
function renderMonths() {
    // сравниваем выбранный месяц с предыдущим и со средним за месяцы до него
    const ms = st.months, ix = ms.indexOf(st.month), last = st.month, prev = ms[ix - 1];
    const depts = deptNames();
    const avgOf = vs => ix > 0 ? sum(vs.slice(0, ix), x => x) / ix : null;
    const row = (name, fn, good, cls = '', id = '') => {
        const vs = ms.map(fn);
        return `<tr class="${cls}" ${id ? `data-mrow="${e(id)}"` : ''}><td>${id ? (st.openMonthsRows.has(id) ? '▾ ' : '▸ ') : ''}${e(name)}</td>${vs.map((v, i) => `<td class="num" ${i === ix ? 'style="font-weight:700"' : ''}>${v ? fmt(v) : '<span class="zero">0 ₹</span>'}</td>`).join('')}
            <td class="num">${prev ? delta(vs[ix], vs[ix - 1], good) : ''}</td><td class="num">${delta(vs[ix], avgOf(vs), good)}</td></tr>`;
    };
    const subRows = d => {
        const cats = [...new Set(ms.flatMap(m => monthOut(m).filter(r => r.dept === d).map(r => r.grp)))];
        const byCat = (m, c) => sum(monthOut(m).filter(r => r.dept === d && r.grp === c));
        return cats.sort((a, b) => byCat(last, b) - byCat(last, a)).map(c => row(c, m => byCat(m, c), false, 'sub')).join('');
    };
    document.getElementById('p-months').innerHTML = `
        <div class="box"><h2>Месяцы рядом <span class="note">в рупиях</span></h2>
        <div class="overflow-x-auto"><table class="t"><thead><tr><th>Строка</th>${ms.map(m => `<th>${mShort(m)}${m === curMonth() ? ' (идёт)' : ''}</th>`).join('')}
            <th>${prev ? `${mShort(last)} к ${mDat(prev)}` : ''}</th><th>к среднему</th></tr></thead><tbody>
        ${row('Приход', m => tot(m, 'in'), true, 'grp')}${row('Расход', m => tot(m, 'out'), false, 'grp')}${row('Итог', m => tot(m, 'in') - tot(m, 'out'), true, 'grp')}
        <tr><td colspan="${ms.length + 3}" class="note" style="text-align:left">Расход по департаментам — клик раскрывает по статьям</td></tr>
        ${depts.map(d => row(d, m => deptOut(m, d), false, 'click', d) + (st.openMonthsRows.has(d) ? subRows(d) : '')).join('')}
        </tbody></table></div>
        <p class="note mt-2">Сравнивается месяц, выбранный вверху (${mShort(last)}). «К среднему» — к среднему за месяцы до него с августа 2026. ${ms.includes(curMonth()) ? 'Текущий месяц ещё идёт — сравнение с ним неполное.' : ''}</p></div>
        <div class="box chart"><h2>Приход и расход по месяцам</h2>${pairChart(ms.map(m => ({ m, in: tot(m, 'in'), out: tot(m, 'out') })), 'Приход и расход по месяцам')}</div>
        <div class="box chart"><h2>Расход по департаментам</h2>${stackChart()}</div>`;
    document.querySelectorAll('#p-months tr[data-mrow]').forEach(tr => tr.onclick = () => {
        const id = tr.dataset.mrow; st.openMonthsRows.has(id) ? st.openMonthsRows.delete(id) : st.openMonthsRows.add(id); renderMonths();
    });
}

// ==================== вкладка «Сравнение ретритов» ====================
async function renderRetreats() {
    const box = document.getElementById('p-retreats');
    box.innerHTML = '<div class="text-center py-6"><span class="loading loading-spinner loading-md"></span></div>';
    await Promise.all(st.retreats.map(r => loadReport(r.id)));
    if (st.tab !== 'retreats') return;
    const cols = [['name', 'Ретрит'], ['dates', 'Даты'], ['days', 'Дней'], ['people', 'Участников'], ['org', 'Оргвзнос'], ['acc', 'Проживание'], ['food', 'Прасад'],
        ['cafe', 'Кафе'], ['shop', 'Магазин и мурти'], ['oth', 'Прочее'], ['inc', 'Приход'], ['retOut', 'Расход ретрита'], ['cost', 'Себестоимость прасада'],
        ['cafeOut', 'Расход кафе'], ['res', 'Итог'], ['pp', 'Приход на участника']];
    const rows = st.retreats.filter(r => st.reports[r.id]).map(r => ({ id: r.id, name: r.name_ru, dates: `${dShort(r.start_date)}–${dShort(r.end_date)}`, start: r.start_date, ...retreatParts(st.reports[r.id], r).n }));
    const { k, d } = st.rSort;
    rows.sort((a, b) => { const x = a[k], y = b[k]; if (x == null) return 1; if (y == null) return -1; return (k === 'dates' ? a.start.localeCompare(b.start) : x > y ? 1 : x < y ? -1 : 0) * d; });
    const cell = (r, key) => {
        if (key === 'name') return `<a href="#" class="link link-primary" data-goret="${r.id}">${e(r.name)}</a>`;
        if (key === 'dates') return e(r.dates);
        if (key === 'days' || key === 'people') return r[key] ?? '—';
        if (key === 'cost' && r.cost == null) return '<span class="nodata">нет данных</span>';
        if (key === 'res') return `<b>${fmtS(r.res)}</b>${r.cost == null ? ' ⚠' : ''}`;
        return r[key] ? fmt(r[key]) : (r[key] === 0 ? '<span class="zero">0 ₹</span>' : '—');
    };
    const sel = rows.filter(r => st.rSel.has(r.id));
    box.innerHTML = `<div class="box"><h2>Ретриты рядом <span class="note">в рупиях · клик по заголовку — сортировка</span></h2>
        <div class="overflow-x-auto"><table class="t"><thead><tr><th></th>${cols.map(([key, t]) => `<th class="sort" data-k="${key}">${t}${k === key ? (d < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead><tbody>
        ${rows.map(r => `<tr><td><input type="checkbox" class="checkbox checkbox-xs rsel" data-id="${r.id}" ${st.rSel.has(r.id) ? 'checked' : ''} aria-label="Сравнить ${e(r.name)}"></td>${cols.map(([key]) => `<td class="${key === 'name' || key === 'dates' ? '' : 'num'}">${cell(r, key)}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
        <p class="note mt-2">Ретрит целиком, без деления на месяцы. Итог = приход − расход ретрита − себестоимость прасада − расход кафе. Отметьте 2–3 ретрита галочкой — ниже появится сравнение.</p></div>
        ${sel.length >= 2 ? `<div class="box chart"><h2>Сравнение: ${sel.map(r => e(r.name)).join(' · ')}</h2>${retreatChart(sel)}</div>` : ''}`;
    box.querySelectorAll('th.sort').forEach(th => th.onclick = () => { const key = th.dataset.k; st.rSort = { k: key, d: st.rSort.k === key ? -st.rSort.d : -1 }; renderRetreats(); });
    box.querySelectorAll('.rsel').forEach(c => c.onchange = () => { c.checked ? st.rSel.add(c.dataset.id) : st.rSel.delete(c.dataset.id); renderRetreats(); });
    box.querySelectorAll('[data-goret]').forEach(a => a.onclick = ev => { ev.preventDefault(); st.retreat = a.dataset.goret; show('retreat'); });
}
function retreatChart(sel) {
    const parts = [['org', 'Оргвзнос', '#2f7f6a'], ['acc', 'Проживание', '#5b7fb5'], ['food', 'Прасад', '#c9743e'], ['cafe', 'Кафе', '#c2a23a'], ['shop', 'Магазин и мурти', '#9b5aa6'], ['oth', 'Прочее', '#999']];
    const W = 680, rowH = 56, L = 190, H = sel.length * rowH + 16;
    const max = Math.max(1, ...sel.map(r => Math.max(r.inc, r.retOut + (r.cost || 0) + r.cafeOut))) * 1.25;
    const sc = v => Math.max(0, v) / max * (W - L - 10);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Приход и расход выбранных ретритов">`;
    sel.forEach((r, i) => {
        const y = 8 + i * rowH; let x = L;
        s += `<text x="${L - 8}" y="${y + 16}" text-anchor="end" style="fill:#1d2420">${e(r.name.length > 26 ? r.name.slice(0, 25) + '…' : r.name)}</text>`;
        parts.forEach(([k, t, c]) => { const w = sc(r[k]); if (!w) return; s += `<rect x="${x}" y="${y}" width="${w}" height="20" fill="${c}"><title>${t}: ${fmt(r[k])}</title></rect>`; x += w; });
        s += `<text x="${x + 6}" y="${y + 15}" style="fill:#1d2420;font-weight:600">${fmt(r.inc)}</text>`;
        const out = r.retOut + (r.cost || 0) + r.cafeOut, w = sc(out);
        s += `<rect x="${L}" y="${y + 24}" width="${w}" height="12" fill="var(--bar-out)"><title>Ушло: ${fmt(out)}</title></rect><text x="${L + w + 6}" y="${y + 34}" style="font-size:10px">ушло ${fmt(out)}</text>`;
    });
    return s + '</svg><div class="legend">' + parts.map(([, t, c]) => `<span><i style="background:${c}"></i>${t}</span>`).join('') + '<span><i style="background:var(--bar-out)"></i>Ушло (расход + себестоимость + кафе)</span></div>';
}

// ==================== вкладка «Лист» ====================
function renderSheet() {
    const m = st.month, p = prevOf(m), ti = tot(m, 'in'), te = tot(m, 'out');
    const inc = incomeTree(monthIn(m));
    const exp = expenseTree(monthOut(m)).filter(n => n.amount);
    const inRows = inc.filter(n => n.amount).map(n => `<tr><td><b>${e(n.name)}</b></td><td class="num"><b>${fmt(n.amount)}</b></td></tr>` +
        n.kids.filter(k => k.amount).map(k => `<tr class="lvl2"><td>${e(k.name)}</td><td class="num">${fmt(k.amount)}</td></tr>`).join('')).join('');
    const expRows = exp.map(n => {
        const top = n.kids.filter(k => k.amount > 0).slice(0, 3).map(k => k.name.replace(/^Платил: /, '')).join(', ');
        return `<tr><td><b>${e(n.name)}</b>${top ? `<div style="font-size:.7rem">${e(top)}</div>` : ''}</td><td class="num">${fmt(n.amount)}</td><td class="num">${p ? delta(n.amount, deptOut(p, n.key.dept), false).replace(/class="(up|down)"/, '') : ''}</td></tr>`;
    }).join('');
    document.getElementById('p-sheet').innerHTML = `
        <div class="flex flex-wrap gap-2 items-center no-print"><button type="button" class="btn btn-sm btn-primary" id="printBtn">Печать / сохранить в PDF</button>
            <span class="note">Лист за выбранный месяц — одна страница A4, чтобы отправить Ачинтье Кришне в Телеграм.</span></div>
        <div class="sheet">
            <h3>Итоги ШРСК · ${mLabel(m)}</h3>
            <div class="sub">В рупиях, по месяцу, к которому относится платёж${m === curMonth() ? ' · месяц ещё идёт' : ''}</div>
            <div class="kpi"><div><small>Приход</small>${fmt(ti)}</div><div><small>Расход</small>${fmt(te)}</div><div><small>Итог</small>${fmtS(ti - te)}</div>
                ${p ? `<div><small>Расход к ${mDat(p)}</small>${delta(te, tot(p, 'out'), false).replace(/<[^>]+>/g, '')}</div>` : ''}</div>
            <div class="two">
                <div><table class="t"><thead><tr><th>Приход</th><th>Сумма</th></tr></thead><tbody>${inRows}</tbody></table></div>
                <div><table class="t"><thead><tr><th>Расход</th><th>Сумма</th><th>${p ? `к ${mDat(p)}` : ''}</th></tr></thead><tbody>${expRows}</tbody></table></div>
            </div>
            <p style="margin-top:12px;font-size:.78rem">⚠ Электричество, вода, насос, интернет: данных пока нет. Департаменты без трат в листе не показаны.</p>
        </div>`;
    document.getElementById('printBtn').onclick = () => window.print();
}

// ==================== общее ====================
const renders = { month: renderMonth, dept: renderDept, retreat: renderRetreat, months: renderMonths, retreats: renderRetreats, sheet: renderSheet };
function show(tab) {
    st.tab = tab;
    document.querySelectorAll('#tabs .tab').forEach(a => a.classList.toggle('tab-active', a.dataset.tab === tab));
    Object.keys(renders).forEach(k => { document.getElementById('p-' + k).hidden = k !== tab; });
    try { localStorage.setItem('itogi_tab', tab); } catch (_) { /* без хранилища — не страшно */ }
    renders[tab]();
}

async function init() {
    await Layout.init({ module: 'finance', menuId: 'fin_itogi', itemId: 'fin_itogi' });
    if (!window.currentUser?.is_superuser) {
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('denied').classList.remove('hidden');
        document.getElementById('tabs').classList.add('hidden');
        return;
    }
    // месяцы с августа 2026 по текущий
    const months = [];
    for (let d = DateUtils.parseDate(FIRST_MONTH); DateUtils.toISO(d) <= curMonth(); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(DateUtils.toISO(d));
    st.months = months;
    const cm = curMonth();
    // по умолчанию — прошлый, законченный месяц (лист уходит в начале месяца)
    st.month = months.length > 1 && months.at(-1) === cm ? months.at(-2) : months.at(-1);
    const sel = document.getElementById('monthSelect');
    sel.innerHTML = months.slice().reverse().map(m => `<option value="${m}" ${m === st.month ? 'selected' : ''}>${mLabel(m)}${m === cm ? ' (идёт)' : ''}</option>`).join('');

    const [deps, rets] = await Promise.all([
        Layout.db.from('fin_departments').select('name').order('name'),
        Layout.db.from('retreats').select('id, name_ru, start_date, end_date')
            .gte('start_date', '2001-01-01').gte('end_date', FIRST_MONTH).lte('start_date', DateUtils.toISO(new Date())).order('start_date'),
        ...months.map(loadRows)
    ]);
    if (deps.error) Layout.handleError(deps.error, 'Департаменты');
    if (rets.error) Layout.handleError(rets.error, 'Ретриты');
    st.depts = (deps.data || []).map(x => x.name).filter(n => !/\(личный\)/.test(n));
    st.retreats = rets.data || [];

    document.getElementById('loading').classList.add('hidden');
    sel.onchange = () => { st.month = sel.value; renders[st.tab](); };
    document.querySelectorAll('#tabs .tab').forEach(a => a.onclick = () => show(a.dataset.tab));
    document.getElementById('sheetBtn').onclick = () => show('sheet');
    let tab = 'month';
    try { tab = localStorage.getItem('itogi_tab') || 'month'; } catch (_) { /* нет хранилища */ }
    show(renders[tab] ? tab : 'month');
}

init();
})();
