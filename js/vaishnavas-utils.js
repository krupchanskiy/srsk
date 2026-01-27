// ==================== VAISHNAVAS UTILS ====================
// Общие функции для vaishnavas/index.html, team.html, guests.html

(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

const AVATAR_PLACEHOLDER = `<svg class="w-5 h-5 opacity-30" viewBox="0 0 122 313" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M102,16h-15v82c0,6,.1,12-.9,16-1,4.5-2.6,8-4.8,10.6-2,2.8-4.8,4.8-8.5,6-2.4,1-5.1,1.6-8.1,1.8-1,.2-2,.3-3,.3h-.6c-3.8-.2-7.2-.8-10.3-1.8-3.8-1.2-7-3.1-9.6-5.7-2.7-2.8-4.6-6.4-5.7-10.9-1.2-4.4-1.8-9.8-1.8-16.3V16H18.6v89c0,13.7,3.8,24,11.5,30.8,3.8,3.4,8.6,6,14.2,7.5,1.2.4,2.6.7,4.2,1-13.9,5-23.4,11.9-28.4,20.5-7,10.7-7.3,24.1-.6,40.5l41.3,100.4,39.9-100.4c6.4-16.3,6.2-29.8-.6-40.5-4.8-8.5-14-15.2-27.4-20.2,1.6-.4,3.2-.9,4.8-1.3,5.3-1.6,9.7-4.2,13.3-7.8,3.8-3.7,6.6-8.2,8.5-13.6,2-5.6,3-12.3,3-20V16M87.5,172.5c4,7.3,3.8,16.4-.6,27.4l-26.3,68.1-27.8-68.1c-4.6-11-4.8-20.2-.6-27.4,4.6-7.5,13.8-13,27.4-16.6,13.7,3.6,22.9,9.1,27.8,16.6"/></svg>`;

/** Имя и фамилия через пробел, или "без имени" */
function getDisplayName(person) {
    return [person.first_name, person.last_name].filter(Boolean).join(' ') || t('no_name');
}

/** Настройка поиска с debounce */
function setupSearch(state, renderFn) {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearch');

    input.addEventListener('input', Layout.debounce(() => {
        state.searchQuery = input.value.toLowerCase().trim();
        clearBtn.classList.toggle('hidden', !state.searchQuery);
        renderFn();
    }, 300));

    clearBtn.addEventListener('click', () => {
        input.value = '';
        state.searchQuery = '';
        clearBtn.classList.add('hidden');
        renderFn();
    });
}

/** Настройка кнопок фильтрации */
function setupFilters(state, renderFn, opts = {}) {
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.currentFilter = btn.dataset.filter;
            document.querySelectorAll('.filter-btn').forEach(b => {
                b.classList.toggle('active', b === btn);
                b.classList.toggle('btn-neutral', b === btn);
                b.classList.toggle('btn-ghost', b !== btn);
            });
            if (opts.updateUrl) {
                const url = new URL(window.location);
                if (state.currentFilter === 'all') {
                    url.searchParams.delete('filter');
                } else {
                    url.searchParams.set('filter', state.currentFilter);
                }
                history.replaceState(null, '', url);
            }
            renderFn();
        });
    });
}

/** Переключение сортировки */
function toggleSort(state, field, renderFn) {
    if (state.sortField === field) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.sortField = field;
        state.sortDirection = 'asc';
    }
    updateSortIcons(state);
    renderFn();
}

/** Обновление иконок сортировки */
function updateSortIcons(state) {
    document.querySelectorAll('.sort-icon').forEach(icon => {
        const field = icon.dataset.sort;
        if (field === state.sortField) {
            icon.classList.add('active');
            icon.textContent = state.sortDirection === 'asc' ? '↑' : '↓';
        } else {
            icon.classList.remove('active');
            icon.textContent = '↕';
        }
    });
}

/** Фильтрация по поисковому запросу (6 полей) */
function matchesSearch(person, searchQuery) {
    if (!searchQuery) return true;
    const name = getDisplayName(person).toLowerCase();
    const spiritual = (person.spiritual_name || '').toLowerCase();
    const phone = (person.phone || '').toLowerCase();
    const email = (person.email || '').toLowerCase();
    const country = (person.country || '').toLowerCase();
    const teacher = (person.spiritual_teacher || '').toLowerCase();
    return name.includes(searchQuery) || spiritual.includes(searchQuery) ||
        phone.includes(searchQuery) || email.includes(searchQuery) ||
        country.includes(searchQuery) || teacher.includes(searchQuery);
}

/** Сортировка списка по полю */
function sortPeople(list, state) {
    return list.sort((a, b) => {
        let aVal, bVal;
        if (state.sortField === 'name') {
            aVal = getDisplayName(a).toLowerCase();
            bVal = getDisplayName(b).toLowerCase();
        } else if (state.sortField === 'spiritual') {
            aVal = (a.spiritual_name || '').toLowerCase();
            bVal = (b.spiritual_name || '').toLowerCase();
        } else if (state.sortField === 'country') {
            aVal = (a.country || '').toLowerCase();
            bVal = (b.country || '').toLowerCase();
        } else if (state.sortField === 'teacher') {
            aVal = (a.spiritual_teacher || '').toLowerCase();
            bVal = (b.spiritual_teacher || '').toLowerCase();
        }

        if (aVal < bVal) return state.sortDirection === 'asc' ? -1 : 1;
        if (aVal > bVal) return state.sortDirection === 'asc' ? 1 : -1;
        return 0;
    });
}

/** Загрузка проживаний (stays) */
async function loadStays() {
    const { data } = await Layout.db
        .from('vaishnava_stays')
        .select('vaishnava_id, start_date, end_date')
        .order('start_date');

    const stays = {};
    (data || []).forEach(s => {
        if (!stays[s.vaishnava_id]) stays[s.vaishnava_id] = [];
        stays[s.vaishnava_id].push(s);
    });
    return stays;
}

/** Проверка присутствия на текущую дату */
function isPresent(personId, stays, today) {
    const personStays = stays[personId] || [];
    return personStays.some(s => s.start_date <= today && s.end_date >= today);
}

/** Рендер строки таблицы для человека */
function renderPersonRow(person, opts = {}) {
    const displayName = getDisplayName(person);
    const dept = person.departments;
    const showTeamBadge = opts.showTeamBadge !== false;
    const present = opts.isPresent || false;

    let badgeHtml = '';
    if (showTeamBadge && person.is_team_member) {
        badgeHtml = dept
            ? `<span class="badge badge-xs" style="background-color: ${e(dept.color)}20; color: ${e(dept.color)}; border-color: ${e(dept.color)}">${e(Layout.getName(dept))}</span>`
            : '<span class="badge badge-primary badge-xs">Команда</span>';
    }
    if (present) {
        badgeHtml += '<span class="badge badge-success badge-xs ml-1">Здесь</span>';
    }

    return `
        <tr class="hover cursor-pointer" onclick="window.location.href='person.html?id=${e(person.id)}'">
            <td>
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-base-200 flex items-center justify-center shrink-0">
                        ${AVATAR_PLACEHOLDER}
                    </div>
                    <div class="min-w-0">
                        <div class="font-medium truncate">${e(displayName)}</div>
                        ${badgeHtml}
                    </div>
                </div>
            </td>
            <td class="truncate">${e(person.spiritual_name || '')}</td>
            <td class="truncate">${e(person.country || '')}</td>
            <td class="truncate">${e(person.spiritual_teacher || '')}</td>
            <td class="truncate text-sm opacity-60">${e(person.phone || '')}</td>
            <td>
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
                </svg>
            </td>
        </tr>
    `;
}

/** Модальное окно: открыть/закрыть */
function openAddModal() {
    document.getElementById('addForm').reset();
    document.getElementById('addModal').showModal();
}

function closeAddModal() {
    document.getElementById('addModal').close();
}

/** Сохранение нового человека */
async function saveNewPerson(event, opts = {}) {
    event.preventDefault();
    const form = event.target;

    const data = {
        first_name: form.first_name.value || null,
        last_name: form.last_name.value || null,
        spiritual_name: form.spiritual_name.value || null,
        phone: form.phone.value || null
    };

    // is_team_member определяется по-разному на каждой странице
    if (opts.isTeamMember !== undefined) {
        data.is_team_member = opts.isTeamMember;
    } else if (form.is_team_member) {
        data.is_team_member = form.is_team_member.type === 'checkbox'
            ? form.is_team_member.checked
            : form.is_team_member.value === 'true';
    }

    if (!data.first_name && !data.spiritual_name) {
        alert(t('name_or_spiritual_required') || 'Укажите имя или духовное имя');
        return;
    }

    const { data: newPerson, error } = await Layout.db
        .from('vaishnavas')
        .insert(data)
        .select()
        .single();

    if (error) {
        console.error('Error adding person:', error);
        alert(t('error_saving') || 'Ошибка сохранения');
        return;
    }

    closeAddModal();
    window.location.href = `person.html?id=${newPerson.id}`;
}

// Экспорт
window.VaishnavasUtils = {
    getDisplayName,
    setupSearch,
    setupFilters,
    toggleSort,
    updateSortIcons,
    matchesSearch,
    sortPeople,
    loadStays,
    isPresent,
    renderPersonRow,
    openAddModal,
    closeAddModal,
    saveNewPerson,
    AVATAR_PLACEHOLDER
};

})();
