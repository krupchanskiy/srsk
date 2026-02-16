// ==================== GROUPS.JS ====================
// CRUD для meal_groups — внешние группы питающихся

(function() {
'use strict';

let groups = [];
let editingGroupId = null;

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

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

    tbody.innerHTML = groups.map(g => {
        const today = DateUtils.toISO(new Date());
        const isActive = g.start_date <= today && g.end_date >= today;
        const isPast = g.end_date < today;

        return `
            <tr class="${isPast ? 'opacity-50' : ''}">
                <td>
                    <div class="font-medium">${e(g.name)}</div>
                    ${isActive ? '<span class="badge badge-success badge-xs">active</span>' : ''}
                </td>
                <td class="whitespace-nowrap">${formatDate(g.start_date)} — ${formatDate(g.end_date)}</td>
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

    if (groupId) {
        const g = groups.find(x => x.id === groupId);
        if (g) {
            title.textContent = t('edit_group');
            form.id.value = g.id;
            form.name.value = g.name || '';
            form.start_date.value = g.start_date || '';
            form.end_date.value = g.end_date || '';
            form.people_count.value = g.people_count || 1;
            form.breakfast.checked = g.breakfast !== false;
            form.lunch.checked = g.lunch !== false;
            form.notes.value = g.notes || '';
            deleteBtn.classList.remove('hidden');
        }
    } else {
        title.textContent = t('add_group');
        deleteBtn.classList.add('hidden');
    }

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
        notes: form.notes.value.trim() || null
    };

    if (!data.name || !data.start_date || !data.end_date) return;
    if (data.start_date > data.end_date) {
        Layout.showNotification(t('groups_date_error'), 'error');
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
    renderGroups();
}

window.onLanguageChange = () => updateUI();

async function init() {
    await Layout.init({ module: 'housing', menuId: 'placement', itemId: 'groups' });
    Layout.showLoader();

    groups = await loadGroups();

    Layout.$('#groupForm').addEventListener('submit', saveGroup);

    updateUI();
    Layout.hideLoader();
}

init();

})();
