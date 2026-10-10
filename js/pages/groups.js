// ==================== GROUPS.JS ====================
// CRUD для meal_groups — «Разовое питание» (ВГ, 02.10.2026): разовые приходы на день-два,
// в шахматку можно не заносить. Регулярных — в шахматку (бронь, в том числе без номера)

(function() {
'use strict';

let groups = [];
let retreats = [];

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
// Пока кэш переводов у пользователя не обновился, показываем русский текст, а не имя ключа
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const date = DateUtils.parseDate(dateStr);
    return date.toLocaleDateString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric'
    });
}

// ==================== DATA ====================
async function loadGroups() {
    const { data, error } = await Layout.db
        .from('meal_groups')
        .select('*')
        .order('start_date', { ascending: false });
    if (error) {
        console.error('Error loading groups:', error);
        return [];
    }
    return data || [];
}

async function loadRetreats() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date, is_external')
        .order('start_date', { ascending: false });
    if (error) {
        console.error('Error loading retreats:', error);
        return [];
    }
    return data || [];
}

function eventLabel(g) {
    if (!g.retreat_id) return '—';
    const r = retreats.find(x => x.id === g.retreat_id);
    return r ? Layout.getName(r) : '—';
}

// ⚠ Двойной счёт: человек записан здесь и на те же дни стоит в шахматке с питанием —
// кухня посчитает его дважды. Узнаём по имени записи = имя в карточке (у «Группы 10 человек»
// проверить нечего). Только текущие и будущие записи на одного человека: в записи на несколько
// человек имя — это тот, кто бронирует и платит, а едят его гости.
const norm = s => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\u0900-\u097f]+/g, ' ').trim();
async function checkDoubleCount() {
    const el = Layout.$('#doubleCountAlert');
    if (!el) return;
    const today = DateUtils.toISO(new Date());
    const actual = groups.filter(g => g.end_date >= today && (g.people_count || 1) <= 1);
    el.classList.add('hidden');
    if (!actual.length) return;
    const from = actual.map(g => g.start_date).sort()[0];
    const to = actual.map(g => g.end_date).sort().pop();
    const { data, error } = await Layout.db.from('residents')
        .select('check_in, check_out, meal_start_date, meal_end_date, vaishnavas(spiritual_name, first_name, last_name)')
        .in('status', ['confirmed', 'checked_out'])
        .not('vaishnava_id', 'is', null)
        .not('has_meals', 'is', false)
        .lte('check_in', to)
        .or(`check_out.is.null,check_out.gte.${from}`);
    if (error || !data?.length) return;
    const hits = [];
    for (const g of actual) {
        const name = norm(g.name);
        if (!name) continue;
        const r = data.find(x => {
            const v = x.vaishnavas || {};
            const names = [v.spiritual_name, `${v.first_name || ''} ${v.last_name || ''}`].map(norm).filter(Boolean);
            const s = x.meal_start_date || x.check_in, f = x.meal_end_date || x.check_out;
            return names.includes(name) && s <= g.end_date && (!f || f >= g.start_date);
        });
        if (r) hits.push({ g, r });
    }
    if (!hits.length) return;
    el.innerHTML = `<div><b>⚠ ${e(tr('one_time_meals_double_title', 'Записаны и здесь, и в шахматке с питанием'))}: ${hits.length}</b>
        <span class="opacity-80">— ${e(tr('one_time_meals_double_hint', 'кухня считает их дважды. Уберите запись здесь или сократите даты.'))}</span>
        <ul class="list-disc ml-5 mt-1">${hits.map(({ g, r }) =>
            `<li><a class="link" data-action="edit-group" data-id="${g.id}">${e(g.name)}</a> · ${formatDate(g.start_date)} — ${formatDate(g.end_date)}`
            + ` <span class="opacity-70">(${e(tr('one_time_meals_in_timeline', 'в шахматке'))}: ${formatDate(r.check_in)} — ${formatDate(r.check_out)})</span></li>`).join('')}</ul></div>`;
    el.classList.remove('hidden');
}

// ==================== RENDER ====================
function renderGroups() {
    checkDoubleCount();
    const tbody = Layout.$('#groupsTable');
    const noGroups = Layout.$('#noGroups');

    if (groups.length === 0) {
        tbody.innerHTML = '';
        noGroups.classList.remove('hidden');
        return;
    }

    noGroups.classList.add('hidden');

    const today = DateUtils.toISO(new Date());
    // Порядок: действующие (скоро заканчивающиеся выше) → будущие (ближайшие выше) → прошедшие (недавно закончившиеся выше)
    const rank = g => g.end_date < today ? 2 : g.start_date > today ? 1 : 0;
    const sorted = [...groups].sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 0) return a.end_date.localeCompare(b.end_date) || a.start_date.localeCompare(b.start_date);
        if (ra === 1) return a.start_date.localeCompare(b.start_date);
        return b.end_date.localeCompare(a.end_date);
    });

    tbody.innerHTML = sorted.map(g => {
        const isActive = g.start_date <= today && g.end_date >= today;
        const isPast = g.end_date < today;

        return `
            <tr class="${isPast ? 'opacity-50' : ''}">
                <td>
                    <div class="font-medium">${e(g.name)}</div>
                    ${isActive ? '<span class="badge badge-success badge-xs">active</span>' : ''}
                </td>
                <td class="whitespace-nowrap">${formatDate(g.start_date)} — ${formatDate(g.end_date)}</td>
                <td class="text-sm">${e(eventLabel(g))}</td>
                ${g.by_day
                    ? `<td class="text-center font-semibold whitespace-nowrap">${e(tr('mge_up_to', 'до'))} ${g.people_count}</td>
                       <td class="text-center text-xs opacity-70" colspan="2">${e(tr('mge_mode_days', 'По дням'))}</td>`
                    : `<td class="text-center font-semibold">${g.people_count}</td>
                       <td class="text-center">${g.breakfast ? '✓' : '—'}</td>
                       <td class="text-center">${g.lunch ? '✓' : '—'}</td>`}
                <td class="text-sm opacity-70 max-w-xs truncate">${e(g.notes || '')}</td>
                <td>
                    <button class="btn btn-ghost btn-sm btn-square" data-action="edit-group" data-id="${g.id}" data-permission="edit_preliminary">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

// ==================== MODAL ====================
// Окно записи — общее с шахматкой (js/meal-group-editor.js)
function openGroupModal(groupId = null) {
    const g = groupId ? groups.find(x => x.id === groupId) : null;
    MealGroupEditor.open(g, { onSaved: async () => { groups = await loadGroups(); renderGroups(); } });
}

// ==================== EVENT DELEGATION ====================
document.addEventListener('click', ev => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;

    switch (btn.dataset.action) {
        case 'open-group-modal':
            openGroupModal();
            break;
        case 'edit-group':
            openGroupModal(btn.dataset.id);
            break;
    }
});

// ==================== INIT ====================
function updateUI() {
    Layout.updateAllTranslations();
    renderGroups();
}

window.onLanguageChange = () => updateUI();

async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'groups' });
    Layout.showLoader();

    [groups, retreats] = await Promise.all([loadGroups(), loadRetreats()]);

    updateUI();
    Layout.hideLoader();
}

init();

})();
