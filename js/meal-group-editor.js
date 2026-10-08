// ==================== MEAL-GROUP-EDITOR.JS ====================
// Окно записи «Разового питания» (meal_groups) — одно на страницу «Разовое питание»
// и на шахматку (ВГ, 08.10.2026): что поправили в одном месте, видно в другом.
// «Одинаково каждый день» — как раньше: число людей × галочки.
// «По дням» — таблица meal_group_days: дата · завтраков · обедов · примечание к дню
// (примечание уходит поварам). Кухня считает по таблице (eating_detail, миграция 640).
// Нужны: Layout, DateUtils, RetreatSelect (js/retreat-select.js).

(function() {
'use strict';

const LONG_DAYS = 3;   // порог «разового» прихода (ВГ, 02.10)

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов у пользователя не обновился, показываем русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return !v || v === key ? fallback : v; };

let retreats = [];
let editing = null;          // запись, которую правим (null — новая)
let days = new Map();        // дата → { b, l, note } — значения таблицы, переживают смену дат
let byDay = false;
let onSaved = null;
let retreatsLoaded = false;

// ==================== РАЗМЕТКА ====================
function ensureDialog() {
    if (document.getElementById('mgeModal')) return;
    const icon = d => `<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;
    document.body.insertAdjacentHTML('beforeend', `
    <dialog id="mgeModal" class="modal">
        <div class="modal-box max-w-xl relative">
            <button type="button" class="btn btn-sm btn-circle btn-ghost absolute right-2 top-2" data-mge="close">✕</button>
            <h3 class="font-bold text-lg mb-4" id="mgeTitle"></h3>
            <form id="mgeForm" class="space-y-4" novalidate>
                <div>
                    <label class="label"><span class="label-text font-medium" data-mge-t="group_name">Кто пришёл</span><span class="text-error ml-1">*</span></label>
                    <input type="text" name="name" class="input input-bordered w-full" required />
                </div>
                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="label"><span class="label-text font-medium" data-mge-t="start_date">Дата начала</span><span class="text-error ml-1">*</span></label>
                        <input type="date" name="start_date" class="input input-bordered w-full" required />
                    </div>
                    <div>
                        <label class="label"><span class="label-text font-medium" data-mge-t="end_date">Дата окончания</span><span class="text-error ml-1">*</span></label>
                        <input type="date" name="end_date" class="input input-bordered w-full" required />
                    </div>
                </div>
                <div>
                    <label class="label"><span class="label-text font-medium" data-mge-t="group_event">Событие</span><span class="label-text-alt opacity-60" id="mgeEventHint"></span></label>
                    <select name="event_link" id="mgeEvent" class="select select-bordered w-full"></select>
                    <span class="text-xs text-amber-700 mt-1 block hidden" id="mgeEventWarn"></span>
                    <span class="label-text-alt opacity-60 mt-1 block" data-mge-t="group_event_hint">Нужно, чтобы посчитать затраты на питание по ретриту или мероприятию. Если пришли не на ретрит и не на мероприятие — «Без события».</span>
                </div>

                <div class="flex items-center justify-between flex-wrap gap-2">
                    <span class="label-text font-medium" data-mge-t="mge_meals">Питание</span>
                    <div class="join">
                        <button type="button" class="btn btn-sm join-item" data-mge="mode-same" data-mge-t="mge_mode_same">Одинаково каждый день</button>
                        <button type="button" class="btn btn-sm join-item" data-mge="mode-days" data-mge-t="mge_mode_days">По дням</button>
                    </div>
                </div>

                <div id="mgeSame" class="space-y-3">
                    <div>
                        <label class="label"><span class="label-text font-medium" data-mge-t="people_count">Кол-во человек</span><span class="text-error ml-1">*</span></label>
                        <input type="number" name="people_count" class="input input-bordered w-full" min="1" value="1" />
                    </div>
                    <div class="flex gap-6">
                        <label class="label cursor-pointer gap-2">
                            <input type="checkbox" name="breakfast" class="checkbox checkbox-primary" checked />
                            <span class="label-text" data-mge-t="breakfast">Завтрак</span>
                        </label>
                        <label class="label cursor-pointer gap-2">
                            <input type="checkbox" name="lunch" class="checkbox checkbox-primary" checked />
                            <span class="label-text" data-mge-t="lunch">Обед</span>
                        </label>
                    </div>
                </div>

                <div id="mgeDays" class="hidden">
                    <div class="flex flex-wrap items-center gap-2 mb-2">
                        <button type="button" class="btn btn-xs btn-outline gap-1" data-mge="fill-down">
                            ${icon('M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01')}<span data-mge-t="mge_fill_down">Пустые дни — как предыдущий</span></button>
                        <span class="text-xs opacity-60" data-mge-t="mge_paste_hint">Можно вставить столбики из Google-таблицы: встаньте в клетку и Cmd+V</span>
                    </div>
                    <div class="border border-base-300 rounded-lg overflow-hidden">
                        <table class="table table-sm">
                            <thead><tr class="bg-base-200">
                                <th data-mge-t="date">Дата</th>
                                <th class="text-center" data-mge-t="mge_breakfasts">Завтраков</th>
                                <th class="text-center" data-mge-t="mge_lunches">Обедов</th>
                                <th class="w-8"></th>
                            </tr></thead>
                            <tbody id="mgeDaysBody"></tbody>
                        </table>
                    </div>
                    <p class="text-xs opacity-60 mt-1" data-mge-t="mge_days_hint">0 — в этот день приём не нужен. Кухня берёт числа из этой таблицы, примечание к дню видят повара.</p>
                </div>

                <div>
                    <label class="label"><span class="label-text font-medium" data-mge-t="notes">Заметки</span></label>
                    <textarea name="notes" rows="2" class="textarea textarea-bordered w-full"></textarea>
                </div>

                <div class="modal-action">
                    <button type="button" class="btn btn-error btn-outline hidden" id="mgeDelete" data-mge="delete" data-mge-t="delete">Удалить</button>
                    <div class="flex-1"></div>
                    <button type="button" class="btn btn-ghost" data-mge="close" data-mge-t="cancel">Отмена</button>
                    <button type="submit" class="btn btn-primary" data-mge-t="save">Сохранить</button>
                </div>
            </form>
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>
    </dialog>`);

    const modal = document.getElementById('mgeModal');
    const form = document.getElementById('mgeForm');
    modal.addEventListener('click', onClick);
    form.addEventListener('submit', save);
    form.start_date.addEventListener('change', onDatesChange);
    form.end_date.addEventListener('change', onDatesChange);
    form.event_link.addEventListener('change', ev => { ev.target.dataset.touched = '1'; showEventWarn(); renderDays(); });
    const body = document.getElementById('mgeDaysBody');
    body.addEventListener('input', onDayInput);
    body.addEventListener('paste', onPaste);
}

function translate() {
    document.querySelectorAll('#mgeModal [data-mge-t]').forEach(el => {
        const v = t(el.dataset.mgeT);
        if (v && v !== el.dataset.mgeT) el.textContent = v;
    });
}

// ==================== ДАННЫЕ ====================
async function loadRetreats() {
    if (retreatsLoaded) return;
    const [{ data, error }, { data: factEnds }] = await Promise.all([
        Layout.db.from('retreats')
            .select('id, name_ru, name_en, name_hi, start_date, end_date, is_external')
            .order('start_date', { ascending: false }),
        Layout.db.from('retreat_fact_end').select('retreat_id, fact_end')
    ]);
    if (error) { console.error('Error loading retreats:', error); return; }
    const factEnd = new Map((factEnds || []).map(f => [f.retreat_id, f.fact_end]));
    retreats = (data || []).map(r => ({ ...r, fact_end: factEnd.get(r.id) || r.end_date }));
    retreatsLoaded = true;
}

const shift = (iso, n) => { const d = DateUtils.parseDate(iso); d.setDate(d.getDate() + n); return DateUtils.toISO(d); };
function dateList(from, to) {
    const out = [];
    if (!from || !to || from > to) return out;
    for (let d = from; d <= to && out.length < 400; d = shift(d, 1)) out.push(d);
    return out;
}
const num = v => Math.max(0, parseInt(v, 10) || 0);

// ==================== СОБЫТИЕ ====================
const noneLabel = () => tr('group_event_none', 'Без события');

function renderEvent() {
    const form = document.getElementById('mgeForm');
    const sel = form.event_link;
    const selected = sel.value;
    sel.innerHTML = RetreatSelect.html(retreats, selected, form.start_date.value, form.end_date.value, { noneLabel: noneLabel() });
    sel.value = selected;
    showEventWarn();
}

function showEventWarn() {
    const form = document.getElementById('mgeForm');
    const warn = document.getElementById('mgeEventWarn');
    const bad = RetreatSelect.mismatch(retreats, form.event_link.value, form.start_date.value, form.end_date.value);
    warn.textContent = bad ? RetreatSelect.mismatchText() : '';
    warn.classList.toggle('hidden', !bad);
}

// Смена дат: пересобираем список; новой записи подставляем ретрит, если по датам подходит ровно один
function onDatesChange() {
    const form = document.getElementById('mgeForm');
    const sel = form.event_link;
    renderEvent();
    renderDays();
    const hint = document.getElementById('mgeEventHint');
    hint.textContent = '';
    if (editing || sel.dataset.touched === '1' || sel.value) return;
    const fits = retreats.filter(r => RetreatSelect.fits(r, form.start_date.value, form.end_date.value));
    if (fits.length === 1) {
        sel.value = fits[0].id;
        showEventWarn();
        hint.textContent = tr('timeline_retreat_by_dates', 'подставлено по датам');
    } else if (fits.length > 1) {
        hint.textContent = tr('timeline_retreat_many', 'подходит несколько — выберите');
    }
}

// ==================== ПЕРЕКЛЮЧАТЕЛЬ ====================
function setMode(on) {
    const form = document.getElementById('mgeForm');
    // «По дням» впервые: заполняем таблицу тем, что стояло «одинаково»
    if (on && !byDay) {
        const n = num(form.people_count.value) || 1;
        for (const d of dateList(form.start_date.value, form.end_date.value)) {
            if (!days.has(d)) days.set(d, { b: form.breakfast.checked ? n : 0, l: form.lunch.checked ? n : 0, note: '' });
        }
    }
    byDay = on;
    document.getElementById('mgeSame').classList.toggle('hidden', on);
    document.getElementById('mgeDays').classList.toggle('hidden', !on);
    document.querySelector('[data-mge="mode-same"]').classList.toggle('btn-primary', !on);
    document.querySelector('[data-mge="mode-days"]').classList.toggle('btn-primary', on);
    renderDays();
}

// ==================== ТАБЛИЦА ПО ДНЯМ ====================
const noteIcon = 'M7 8h10M7 12h6m-9 8l3.5-3H18a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v9a2 2 0 002 2h1v3z';
let openNotes = new Set();   // дни, у которых сейчас раскрыто поле примечания

function renderDays() {
    if (!byDay) return;
    const form = document.getElementById('mgeForm');
    const list = dateList(form.start_date.value, form.end_date.value);
    const body = document.getElementById('mgeDaysBody');
    if (!list.length) {
        body.innerHTML = `<tr><td colspan="4" class="text-center opacity-60 py-4">${e(tr('group_event_dates_first', 'сначала укажите даты'))}</td></tr>`;
        return;
    }
    const retreat = retreats.find(r => r.id === form.event_link.value);
    const lang = Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-GB' : 'ru-RU';
    const label = d => DateUtils.parseDate(d).toLocaleDateString(lang, { day: 'numeric', month: 'short' });
    const wd = d => DateUtils.parseDate(d).toLocaleDateString(lang, { weekday: 'short' });
    let sumB = 0, sumL = 0;
    body.innerHTML = list.map(d => {
        const v = days.get(d) || { b: 0, l: 0, note: '' };
        sumB += v.b; sumL += v.l;
        const mark = retreat && d === retreat.start_date ? tr('mge_retreat_start', 'начало ретрита')
                   : retreat && d === retreat.end_date ? tr('mge_retreat_end', 'конец ретрита') : '';
        const hasNote = !!(v.note || '').trim();
        const open = openNotes.has(d) || false;
        return `
        <tr data-d="${d}" class="${mark ? 'bg-primary/5' : ''}">
            <td class="whitespace-nowrap">${e(label(d))} <span class="text-xs opacity-50">${e(wd(d))}</span>
                ${mark ? `<span class="text-xs text-primary ml-1">${e(mark)}</span>` : ''}</td>
            <td class="text-center"><input type="number" min="0" inputmode="numeric" class="input input-bordered input-sm w-20 text-center" data-k="b" value="${v.b}"></td>
            <td class="text-center"><input type="number" min="0" inputmode="numeric" class="input input-bordered input-sm w-20 text-center" data-k="l" value="${v.l}"></td>
            <td><button type="button" class="btn btn-ghost btn-xs btn-square ${hasNote ? 'text-primary' : 'opacity-40'}" data-mge="note" data-d="${d}"
                    title="${e(tr('mge_day_note', 'Примечание к дню (видят повара)'))}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="${hasNote ? 'currentColor' : 'none'}" fill-opacity="${hasNote ? '0.15' : '0'}" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="${noteIcon}"/></svg>
            </button></td>
        </tr>
        ${open ? `<tr data-note-row="${d}"><td colspan="4" class="pt-0">
            <input type="text" class="input input-bordered input-sm w-full" data-k="note" data-d="${d}" value="${e(v.note || '')}"
                   placeholder="${e(tr('mge_day_note_ph', 'Например: 19 человек приедут позже — отложить порции'))}">
        </td></tr>` : ''}`;
    }).join('') + `
        <tr class="font-semibold border-t-2 border-base-300">
            <td>${e(tr('total', 'Всего'))}</td>
            <td class="text-center" id="mgeSumB">${sumB}</td>
            <td class="text-center" id="mgeSumL">${sumL}</td>
            <td></td>
        </tr>`;
}

function updateSums() {
    const form = document.getElementById('mgeForm');
    const list = dateList(form.start_date.value, form.end_date.value);
    let b = 0, l = 0;
    for (const d of list) { const v = days.get(d); if (v) { b += v.b; l += v.l; } }
    const sb = document.getElementById('mgeSumB'), sl = document.getElementById('mgeSumL');
    if (sb) sb.textContent = b;
    if (sl) sl.textContent = l;
}

function onDayInput(ev) {
    const el = ev.target;
    const d = el.dataset.d || el.closest('tr[data-d]')?.dataset.d;
    if (!d || !el.dataset.k) return;
    const v = days.get(d) || { b: 0, l: 0, note: '' };
    if (el.dataset.k === 'note') v.note = el.value;
    else v[el.dataset.k] = num(el.value);
    days.set(d, v);
    if (el.dataset.k !== 'note') updateSums();
}

// Вставка из таблицы: строки — дни подряд с этой клетки; один столбик — в эту колонку,
// два — завтраки и обеды. «46 и 19» → 65: числа в клетке складываем (так писали в таблице)
function onPaste(ev) {
    const el = ev.target;
    if (!el.dataset.k || el.dataset.k === 'note') return;
    const text = ev.clipboardData?.getData('text') || '';
    const rows = text.replace(/\r/g, '').split('\n').filter(s => s.trim() !== '');
    if (rows.length < 2 && !text.includes('\t')) return;   // одно число — обычная вставка
    ev.preventDefault();
    const cellNum = s => (String(s).match(/\d+/g) || []).reduce((a, x) => a + Number(x), 0);
    const form = document.getElementById('mgeForm');
    const list = dateList(form.start_date.value, form.end_date.value);
    let i = list.indexOf(el.closest('tr[data-d]').dataset.d);
    for (const row of rows) {
        if (i < 0 || i >= list.length) break;
        const cells = row.split('\t');
        const v = days.get(list[i]) || { b: 0, l: 0, note: '' };
        if (cells.length >= 2 && el.dataset.k === 'b') { v.b = cellNum(cells[0]); v.l = cellNum(cells[1]); }
        else v[el.dataset.k] = cellNum(cells[0]);
        days.set(list[i], v);
        i++;
    }
    renderDays();
}

function fillDown() {
    const form = document.getElementById('mgeForm');
    let prev = null;
    for (const d of dateList(form.start_date.value, form.end_date.value)) {
        const v = days.get(d) || { b: 0, l: 0, note: '' };
        if (!v.b && !v.l && prev) { v.b = prev.b; v.l = prev.l; days.set(d, v); }
        if (v.b || v.l) prev = v;
    }
    renderDays();
}

function toggleNote(d) {
    if (openNotes.has(d)) openNotes.delete(d); else openNotes.add(d);
    renderDays();
    if (openNotes.has(d)) document.querySelector(`#mgeDaysBody input[data-k="note"][data-d="${d}"]`)?.focus();
}

// ==================== ОТКРЫТЬ / СОХРАНИТЬ ====================
// group — запись meal_groups (или null — новая); opts: { onSaved, focusDate, defaults }
async function open(group, opts = {}) {
    ensureDialog();
    translate();
    await loadRetreats();
    editing = group || null;
    onSaved = opts.onSaved || null;
    days = new Map();
    openNotes = new Set();
    byDay = false;

    const form = document.getElementById('mgeForm');
    form.reset();
    const sel = form.event_link;
    delete sel.dataset.touched;
    sel.innerHTML = '';
    document.getElementById('mgeEventHint').textContent = '';
    document.getElementById('mgeTitle').textContent = group ? tr('edit_group', 'Изменить запись') : tr('add_group', 'Добавить');
    document.getElementById('mgeDelete').classList.toggle('hidden', !group);

    const g = group || opts.defaults || {};
    form.name.value = g.name || '';
    form.start_date.value = g.start_date || '';
    form.end_date.value = g.end_date || '';
    form.people_count.value = g.people_count || 1;
    form.breakfast.checked = g.breakfast !== false;
    form.lunch.checked = g.lunch !== false;
    form.notes.value = g.notes || '';
    renderEvent();
    sel.value = g.retreat_id || '';
    showEventWarn();

    if (group?.by_day) {
        const { data, error } = await Layout.db.from('meal_group_days')
            .select('d, breakfast, lunch, note').eq('group_id', group.id);
        if (error) { Layout.handleError(error, tr('nav_groups', 'Разовое питание')); return; }
        for (const r of data || []) {
            days.set(r.d, { b: r.breakfast, l: r.lunch, note: r.note || '' });
            if ((r.note || '').trim()) openNotes.add(r.d);
        }
    }
    // запись уже «По дням» — дни без чисел так и остаются пустыми, не заполняем «одинаково»
    byDay = !!group?.by_day;
    setMode(byDay);

    document.getElementById('mgeModal').showModal();
    if (opts.focusDate && byDay) {
        const row = document.querySelector(`#mgeDaysBody tr[data-d="${opts.focusDate}"]`);
        if (row) {
            row.classList.add('bg-warning/20');
            row.querySelector('input[data-k="b"]')?.focus({ preventScroll: true });
            // после анимации появления окна, иначе прокрутка промахивается
            setTimeout(() => row.scrollIntoView({ block: 'center' }), 250);
        }
    }
}

function close() {
    document.getElementById('mgeModal')?.close();
    editing = null;
}

async function save(ev) {
    ev.preventDefault();
    const form = document.getElementById('mgeForm');
    const list = dateList(form.start_date.value, form.end_date.value);
    const data = {
        name: form.name.value.trim(),
        start_date: form.start_date.value,
        end_date: form.end_date.value,
        notes: form.notes.value.trim() || null,
        retreat_id: form.event_link.value || null,
        by_day: byDay
    };
    if (!data.name || !data.start_date || !data.end_date) {
        Layout.showNotification(tr('fill_required', 'Заполните обязательные поля'), 'error');
        return;
    }
    if (data.start_date > data.end_date) {
        Layout.showNotification(t('groups_date_error'), 'error');
        return;
    }

    let dayRows = [];
    if (byDay) {
        dayRows = list.map(d => ({ d, ...(days.get(d) || { b: 0, l: 0, note: '' }) }))
            .filter(r => r.b || r.l || (r.note || '').trim())
            .map(r => ({ d: r.d, breakfast: r.b, lunch: r.l, note: (r.note || '').trim() || null }));
        if (!dayRows.some(r => r.breakfast || r.lunch)) {
            Layout.showNotification(tr('mge_days_empty', 'В таблице нет ни одного завтрака или обеда'), 'error');
            return;
        }
        // для списка и старых отчётов: «до N человек», галочки — был ли такой приём хоть раз
        data.people_count = Math.max(1, ...dayRows.map(r => Math.max(r.breakfast, r.lunch)));
        data.breakfast = dayRows.some(r => r.breakfast > 0);
        data.lunch = dayRows.some(r => r.lunch > 0);
    } else {
        data.people_count = num(form.people_count.value) || 1;
        data.breakfast = form.breakfast.checked;
        data.lunch = form.lunch.checked;
    }

    // Дольше 3 дней без события — скорее всего ходит регулярно: место такому в шахматке (ВГ, 02.10).
    // Запись с событием и так видна в шахматке полосой (ВГ, 08.10)
    if (list.length > LONG_DAYS && !data.retreat_id && !confirm(tr('one_time_meals_long_warn',
        'Запись на %n дн. Если человек ходит регулярно или живёт у нас — заведите его в шахматку (бронь, можно без номера). Всё равно сохранить здесь?').replace('%n', list.length))) {
        return;
    }

    try {
        let id = editing?.id;
        if (id) {
            const { error } = await Layout.db.from('meal_groups').update(data).eq('id', id);
            if (error) throw error;
        } else {
            const { data: row, error } = await Layout.db.from('meal_groups').insert(data).select('id').single();
            if (error) throw error;
            id = row.id;
        }
        // таблица по дням: заменяем целиком; без «По дням» — убираем, чтобы не висела
        const { error: delErr } = await Layout.db.from('meal_group_days').delete().eq('group_id', id);
        if (delErr) throw delErr;
        if (byDay && dayRows.length) {
            const { error: insErr } = await Layout.db.from('meal_group_days')
                .insert(dayRows.map(r => ({ ...r, group_id: id })));
            if (insErr) throw insErr;
        }
        close();
        Layout.showNotification(t('groups_saved'), 'success');
        if (onSaved) await onSaved(id);
    } catch (err) {
        console.error('Error saving meal group:', err);
        Layout.showNotification(t('groups_save_error') + ': ' + err.message, 'error');
    }
}

async function remove() {
    if (!editing) return;
    if (!confirm(t('groups_delete_confirm'))) return;
    const { error } = await Layout.db.from('meal_groups').delete().eq('id', editing.id);
    if (error) {
        Layout.showNotification(t('groups_delete_error') + ': ' + error.message, 'error');
        return;
    }
    const id = editing.id;
    close();
    Layout.showNotification(t('groups_deleted'), 'success');
    if (onSaved) await onSaved(id);
}

function onClick(ev) {
    const btn = ev.target.closest('[data-mge]');
    if (!btn) return;
    switch (btn.dataset.mge) {
        case 'close': close(); break;
        case 'delete': remove(); break;
        case 'mode-same': setMode(false); break;
        case 'mode-days': setMode(true); break;
        case 'fill-down': fillDown(); break;
        case 'note': toggleNote(btn.dataset.d); break;
    }
}

window.MealGroupEditor = { open, close };

})();
