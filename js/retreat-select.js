// ==================== RETREAT-SELECT.JS ====================
// Выбор ретрита для записи по её датам — одно правило на всех страницах (ВГ, 08.10.2026):
// шахматка (заселение и бронь), «Бронирования», «Разовое питание».
//   1) «Наш ретрит» / «Стороннее мероприятие» — идут в эти даты;
//   2) «Предстоящие» — ещё не закончились: группа приезжает за несколько дней до ретрита
//      (Дикша-ретрит: питание с 7.10, ретрит с 12.10) — раньше его не было в списке;
//   3) «Архив / все ретриты…» — раскрывает все по годам, новые сверху.
// Несовпадение дат — предупреждение под полем, не запрет.
// Конец нашего ретрита — fact_end, если страница его загрузила (миграции 603, 605).

(function() {
'use strict';

const ARCHIVE = '__all_retreats__';

const tf = (key, fallback) => { const v = Layout.t(key); return !v || v === key ? fallback : v; };
const endOf = r => r.is_external ? r.end_date : (r.fact_end || r.end_date);

function fits(r, from, to) {
    return !!r && !!from && r.start_date <= (to || from) && endOf(r) >= from;
}

// retreats — массив ретритов страницы; noneLabel — текст пустого пункта
function html(retreats, selectedId, from, to, { all = false, noneLabel } = {}) {
    const e = s => Layout.escapeHtml(s);
    const external = tf('retreats_is_external', 'Стороннее мероприятие');
    // Вне раздела «наш/сторонний» стороннее мероприятие помечаем в самой строке
    const option = (r, mark) => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${e(Layout.getName(r))}${mark && r.is_external ? ' · ' + e(external) : ''} (${DateUtils.formatRange(r.start_date, r.end_date)})</option>`;
    const optgroup = (label, items, mark) => items.length
        ? `<optgroup label="${e(label)}">` + items.map(r => option(r, mark)).join('') + '</optgroup>' : '';
    const none = `<option value="">${e(noneLabel || tf('timeline_no_retreat', '— без ретрита —'))}</option>`;
    // «Гости без события» (служебный, 2000 год) — это «без ретрита»
    const real = retreats.filter(r => r.start_date && !r.start_date.startsWith('2000-'));
    if (all) {
        const sorted = [...real].sort((a, b) => b.start_date.localeCompare(a.start_date));
        const years = [...new Set(sorted.map(r => r.start_date.slice(0, 4)))];
        return none + years.map(y => optgroup(y, sorted.filter(r => r.start_date.startsWith(y)), true)).join('');
    }
    const byStart = (a, b) => a.start_date.localeCompare(b.start_date);
    const list = real.filter(r => r.id === selectedId || fits(r, from, to)).sort(byStart);
    const today = DateUtils.toISO(new Date());
    const upcoming = real.filter(r => !list.includes(r) && endOf(r) >= today).sort(byStart);
    return none
        + optgroup(tf('group_event_retreat', 'Наш ретрит'), list.filter(r => !r.is_external))
        + optgroup(external, list.filter(r => r.is_external))
        + optgroup(tf('retreat_select_upcoming', 'Предстоящие'), upcoming, true)
        + `<option value="${ARCHIVE}">${e(tf('timeline_retreat_archive', 'Архив / все ретриты…'))}</option>`;
}

// Список «по ретриту» для фильтров и отчётов — один стандарт на всех страницах (ВГ, 23.10.2026):
//   «Гости без события» (если есть) → «Предстоящие» (наши, ещё не закончились, ближайший
//   сверху) → «Сторонние мероприятия» (тоже не закончились) → «Архив (N)…» — прошедшие
//   свёрнуты и раскрываются по годам, новые сверху. Выбранный архивный ретрит виден сразу.
// Для каждого ретрита нужны start_date, end_date, is_external (и fact_end, если есть).
function filterHtml(retreats, selectedId, { noneLabel, noneValue = '', head = '', archive = false } = {}) {
    const e = s => Layout.escapeHtml(s);
    const option = r => `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${e(Layout.getName(r))}${shortDates(r)}</option>`;
    const optgroup = (label, items) => items.length
        ? `<optgroup label="${e(label)}">` + items.map(option).join('') + '</optgroup>' : '';
    const today = DateUtils.toISO(new Date());
    const dated = retreats.filter(r => r.start_date);
    const top = dated.filter(r => r.start_date.startsWith('2000-'));
    const real = dated.filter(r => !top.includes(r));
    const byStart = (a, b) => a.start_date.localeCompare(b.start_date);
    const live = real.filter(r => endOf(r) >= today).sort(byStart);
    const past = real.filter(r => endOf(r) < today).sort((a, b) => b.start_date.localeCompare(a.start_date));
    const open = archive || past.some(r => r.id === selectedId);
    const years = [...new Set(past.map(r => r.start_date.slice(0, 4)))];
    return (head || (noneLabel != null ? `<option value="${e(noneValue)}">${e(noneLabel)}</option>` : ''))
        + top.map(option).join('')
        + optgroup(tf('retreat_select_upcoming', 'Предстоящие'), live.filter(r => !r.is_external))
        + optgroup(tf('retreat_select_external', 'Сторонние мероприятия'), live.filter(r => r.is_external))
        + (open
            ? years.map(y => optgroup(`${tf('retreat_select_archive', 'Архив')} ${y}`, past.filter(r => r.start_date.startsWith(y)))).join('')
            : past.length ? `<option value="${ARCHIVE}">${e(tf('retreat_select_archive', 'Архив'))} (${past.length})…</option>` : '');
}

// « (30.08–12.09.2027)» — коротко, как в Финансах
function shortDates(r) {
    const s = r.start_date, f = r.end_date;
    if (!s || !f || s.startsWith('2000-')) return '';
    const dm = d => `${d.slice(8, 10)}.${d.slice(5, 7)}`;
    return ` (${s.slice(0, 4) === f.slice(0, 4) ? dm(s) : `${dm(s)}.${s.slice(0, 4)}`}–${dm(f)}.${f.slice(0, 4)})`;
}

// Фактическое окончание (мигр. 603): ретрит в «Предстоящих», пока живут его люди.
// Грузим один раз на страницу и дорисовываем списки, когда пришло.
let factEnds = null;
function loadFactEnds() {
    factEnds = factEnds || Promise.resolve(Layout.db?.from('retreat_fact_end').select('retreat_id, fact_end'))
        .then(res => new Map((res?.data || []).map(x => [x.retreat_id, x.fact_end])))
        .catch(() => new Map());
    return factEnds;
}

// Заполнить список по стандарту; «Архив…» раскроется в нём же (обработчик ниже).
// Без noneLabel первый пункт из вёрстки («Все ретриты», data-i18n) остаётся как есть.
function fill(sel, retreats, opts = {}) {
    if (!sel) return;
    if (opts.noneLabel === undefined && !opts.head) {
        const first = sel._retreatFill?.opts.head ?? (sel.options[0]?.outerHTML || '');
        opts = { ...opts, head: first, noneValue: sel.options[0]?.value ?? '' };
    }
    const state = { retreats, opts };
    sel._retreatFill = state;
    sel.innerHTML = filterHtml(retreats, opts.selected, opts);
    if (opts.selected != null) sel.value = opts.selected;
    if (retreats.some(r => !r.is_external && r.fact_end === undefined)) loadFactEnds().then(map => {
        retreats.forEach(r => { if (r.fact_end === undefined) r.fact_end = map.get(r.id) || null; });
        if (sel._retreatFill !== state) return;
        const value = sel.value;
        sel.innerHTML = filterHtml(retreats, value, opts);
        sel.value = value;
    });
}

// Выбрать ретрит из кода: архивный сам раскроет архив
function setValue(sel, id) {
    if (!sel?._retreatFill) { if (sel) sel.value = id || ''; return; }
    const { retreats, opts } = sel._retreatFill;
    fill(sel, retreats, { ...opts, selected: id || (opts.noneValue ?? '') });
}

function mismatch(retreats, id, from, to) {
    const r = id && retreats.find(x => x.id === id);
    return !!r && !!from && !fits(r, from, to);
}

function mismatchText() {
    return tf('retreat_dates_mismatch', 'Даты не пересекаются с датами выбранного ретрита');
}

// «Архив / все ретриты…» — раскрываем все ретриты в этом же списке. Ловим на захвате,
// до onchange самого списка: служебное значение не должно дойти до сохранения.
// Прежнее значение запоминаем при входе в список: раскрыли архив и ничего не выбрали —
// остаётся тот ретрит, что был. Ретриты для списка страница отдаёт через setSource.
let source = () => [];
let noneLabel = null;
function setSource(fn, opts = {}) { source = fn; noneLabel = opts.noneLabel || null; }

document.addEventListener('focusin', ev => {
    if (ev.target instanceof HTMLSelectElement) ev.target.dataset.prev = ev.target.value;
}, true);
document.addEventListener('change', ev => {
    const sel = ev.target;
    if (!(sel instanceof HTMLSelectElement) || sel.value !== ARCHIVE) return;
    ev.stopPropagation();
    const none = sel._retreatFill?.opts.noneValue ?? '';
    const prev = sel.dataset.prev === ARCHIVE ? none : (sel.dataset.prev ?? none);
    if (sel._retreatFill) {
        const { retreats, opts } = sel._retreatFill;
        sel.innerHTML = filterHtml(retreats, prev, { ...opts, archive: true });
    } else sel.innerHTML = html(source(), prev, null, null, { all: true, noneLabel: noneLabel && noneLabel() });
    sel.value = prev;
    sel.dataset.prev = prev;
    sel.focus();
    try { sel.showPicker?.(); } catch (_) { /* без жеста пользователя браузер не откроет */ }
}, true);

window.RetreatSelect = { ARCHIVE, fits, html, filterHtml, fill, setValue, mismatch, mismatchText, setSource };

})();
