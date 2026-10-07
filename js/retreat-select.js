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
    const prev = sel.dataset.prev === ARCHIVE ? '' : (sel.dataset.prev || '');
    sel.innerHTML = html(source(), prev, null, null, { all: true, noneLabel: noneLabel && noneLabel() });
    sel.value = prev;
    sel.dataset.prev = prev;
    sel.focus();
    sel.showPicker?.();
}, true);

window.RetreatSelect = { ARCHIVE, fits, html, mismatch, mismatchText, setSource };

})();
