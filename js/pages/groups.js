// ==================== GROUPS.JS ====================
// CRUD для meal_groups — внешние группы питающихся

(function() {
'use strict';

let groups = [];
let retreats = [];
let editingGroupId = null;

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

// Ретрит идёт в даты группы (хотя бы один общий день)
const fitsDates = (r, from, to) => !!from && !!to && r.start_date <= to && r.end_date >= from;

// Только ретриты, которые идут в даты группы, и с датами в скобках: «Сева-ретрит» 2026
// и 2027 иначе не различить. Уже выбранный остаётся в списке, даже если даты разошлись, —
// сохранить с ним не даст проверка в saveGroup.
function renderEventSelect() {
    const sel = Layout.$('#eventLinkSelect');
    const form = Layout.$('#groupForm');
    if (!sel || !form) return;
    const from = form.start_date.value, to = form.end_date.value;
    const selectedId = sel.value;
    const list = retreats.filter(r => r.id === selectedId || fitsDates(r, from, to))
        .sort((a, b) => a.start_date.localeCompare(b.start_date));
    const option = r => `<option value="${r.id}">${e(Layout.getName(r))} (${e(DateUtils.formatRange(r.start_date, r.end_date))})</option>`;
    const optgroup = (label, items) => items.length
        ? `<optgroup label="${e(label)}">` + items.map(option).join('') + '</optgroup>'
        : '';
    sel.innerHTML = `<option value="">${e(tr('group_event_none', 'Без события (самостоятельные гости)'))}</option>`
        + optgroup(tr('group_event_retreat', 'Наш ретрит'), list.filter(r => !r.is_external))
        + optgroup(tr('retreats_is_external', 'Стороннее мероприятие'), list.filter(r => r.is_external));
    sel.value = selectedId;

    const hint = Layout.$('#eventLinkHint');
    if (hint) hint.textContent = (!from || !to) ? tr('group_event_dates_first', 'сначала укажите даты') : '';
}

// Смена дат: пересобираем список; новой группе подставляем ретрит, если по датам подходит ровно один
function onGroupDatesChange() {
    const sel = Layout.$('#eventLinkSelect');
    const form = Layout.$('#groupForm');
    renderEventSelect();
    if (editingGroupId || sel.dataset.touched === '1' || sel.value) return;
    const fits = retreats.filter(r => fitsDates(r, form.start_date.value, form.end_date.value));
    const hint = Layout.$('#eventLinkHint');
    if (fits.length === 1) {
        sel.value = fits[0].id;
        if (hint) hint.textContent = tr('timeline_retreat_by_dates', 'подставлено по датам');
    } else if (fits.length > 1 && hint) {
        hint.textContent = tr('timeline_retreat_many', 'подходит несколько — выберите');
    }
}

function eventLabel(g) {
    if (!g.retreat_id) return '—';
    const r = retreats.find(x => x.id === g.retreat_id);
    return r ? Layout.getName(r) : '—';
}

// ==================== RENDER ====================
function renderGroups() {
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
                <td class="text-center font-semibold">${g.people_count}</td>
                <td class="text-center">${g.breakfast ? '✓' : '—'}</td>
                <td class="text-center">${g.lunch ? '✓' : '—'}</td>
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
function openGroupModal(groupId = null) {
    editingGroupId = groupId;
    const form = Layout.$('#groupForm');
    const title = Layout.$('#groupModalTitle');
    const deleteBtn = Layout.$('#deleteGroupBtn');

    form.reset();
    const sel = Layout.$('#eventLinkSelect');
    delete sel.dataset.touched;
    sel.value = '';

    if (groupId) {
        const g = groups.find(x => x.id === groupId);
        if (g) {
            title.textContent = t('edit_group');
            form.id.value = g.id;
            form.name.value = g.name || '';
            form.start_date.value = g.start_date || '';
            form.end_date.value = g.end_date || '';
            form.people_count.value = g.people_count || 1;
            renderEventSelect();   // список под даты группы, иначе её ретрита в нём нет
            form.event_link.value = g.retreat_id || '';
            form.breakfast.checked = g.breakfast !== false;
            form.lunch.checked = g.lunch !== false;
            form.notes.value = g.notes || '';
            deleteBtn.classList.remove('hidden');
        }
    } else {
        title.textContent = t('add_group');
        deleteBtn.classList.add('hidden');
    }
    renderEventSelect();

    Layout.$('#groupModal').showModal();
}

function closeModal() {
    Layout.$('#groupModal').close();
    editingGroupId = null;
}

async function saveGroup(ev) {
    ev.preventDefault();
    const form = Layout.$('#groupForm');

    const data = {
        name: form.name.value.trim(),
        start_date: form.start_date.value,
        end_date: form.end_date.value,
        people_count: parseInt(form.people_count.value) || 1,
        breakfast: form.breakfast.checked,
        lunch: form.lunch.checked,
        notes: form.notes.value.trim() || null,
        retreat_id: form.event_link.value || null
    };

    if (!data.name || !data.start_date || !data.end_date) return;
    if (data.start_date > data.end_date) {
        Layout.showNotification(t('groups_date_error'), 'error');
        return;
    }
    const retreat = data.retreat_id && retreats.find(r => r.id === data.retreat_id);
    if (retreat && !fitsDates(retreat, data.start_date, data.end_date)) {
        Layout.showNotification(tr('retreat_dates_mismatch', 'Даты не пересекаются с датами выбранного ретрита'), 'error');
        return;
    }

    try {
        if (editingGroupId) {
            const { error } = await Layout.db.from('meal_groups').update(data).eq('id', editingGroupId);
            if (error) throw error;
        } else {
            const { error } = await Layout.db.from('meal_groups').insert(data);
            if (error) throw error;
        }

        closeModal();
        groups = await loadGroups();
        renderGroups();
        Layout.showNotification(t('groups_saved'), 'success');
    } catch (err) {
        console.error('Error saving group:', err);
        Layout.showNotification(t('groups_save_error') + ': ' + err.message, 'error');
    }
}

async function deleteGroup() {
    if (!editingGroupId) return;
    if (!confirm(t('groups_delete_confirm'))) return;

    try {
        const { error } = await Layout.db.from('meal_groups').delete().eq('id', editingGroupId);
        if (error) throw error;

        closeModal();
        groups = await loadGroups();
        renderGroups();
        Layout.showNotification(t('groups_deleted'), 'success');
    } catch (err) {
        console.error('Error deleting group:', err);
        Layout.showNotification(t('groups_delete_error') + ': ' + err.message, 'error');
    }
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
        case 'close-modal':
            closeModal();
            break;
        case 'delete-group':
            deleteGroup();
            break;
    }
});

// ==================== INIT ====================
function updateUI() {
    Layout.updateAllTranslations();
    renderEventSelect();
    renderGroups();
}

window.onLanguageChange = () => updateUI();

async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'groups' });
    Layout.showLoader();

    [groups, retreats] = await Promise.all([loadGroups(), loadRetreats()]);
    renderEventSelect();

    const form = Layout.$('#groupForm');
    form.addEventListener('submit', saveGroup);
    form.start_date.addEventListener('change', onGroupDatesChange);
    form.end_date.addEventListener('change', onGroupDatesChange);
    Layout.$('#eventLinkSelect').addEventListener('change', ev => { ev.target.dataset.touched = '1'; });

    updateUI();
    Layout.hideLoader();
}

init();

})();
