// ==================== VAISHNAVAS UTILS ====================
// Общие функции для vaishnavas/index.html, team.html, guests.html

(function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

const AVATAR_PLACEHOLDER = `<svg class="w-5 h-5 opacity-30" viewBox="0 0 122 313" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M102,16h-15v82c0,6,.1,12-.9,16-1,4.5-2.6,8-4.8,10.6-2,2.8-4.8,4.8-8.5,6-2.4,1-5.1,1.6-8.1,1.8-1,.2-2,.3-3,.3h-.6c-3.8-.2-7.2-.8-10.3-1.8-3.8-1.2-7-3.1-9.6-5.7-2.7-2.8-4.6-6.4-5.7-10.9-1.2-4.4-1.8-9.8-1.8-16.3V16H18.6v89c0,13.7,3.8,24,11.5,30.8,3.8,3.4,8.6,6,14.2,7.5,1.2.4,2.6.7,4.2,1-13.9,5-23.4,11.9-28.4,20.5-7,10.7-7.3,24.1-.6,40.5l41.3,100.4,39.9-100.4c6.4-16.3,6.2-29.8-.6-40.5-4.8-8.5-14-15.2-27.4-20.2,1.6-.4,3.2-.9,4.8-1.3,5.3-1.6,9.7-4.2,13.3-7.8,3.8-3.7,6.6-8.2,8.5-13.6,2-5.6,3-12.3,3-20V16M87.5,172.5c4,7.3,3.8,16.4-.6,27.4l-26.3,68.1-27.8-68.1c-4.6-11-4.8-20.2-.6-27.4,4.6-7.5,13.8-13,27.4-16.6,13.7,3.6,22.9,9.1,27.8,16.6"/></svg>`;

const PAGE_SIZE = 50;

/** Заменить битое изображение на заглушку с инициалами */
window.replacePhotoWithPlaceholder = function(img) {
    const initials = img.dataset.initials || '?';
    const placeholder = document.createElement('div');
    placeholder.className = 'w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold';
    placeholder.textContent = initials;
    img.replaceWith(placeholder);
};

/** Глобальный обработчик клика по аватарам (event delegation для XSS-безопасности) */
document.addEventListener('click', function(event) {
    const avatarPhoto = event.target.closest('.avatar-photo');
    if (avatarPhoto && avatarPhoto.dataset.photoUrl) {
        event.stopPropagation();
        Layout.openPhotoModal(avatarPhoto.dataset.photoUrl);
    }
});

/** Имя и фамилия через пробел, или "без имени" */
function getDisplayName(person) {
    return [person.first_name, person.last_name].filter(Boolean).join(' ') || t('no_name');
}

/** Настройка поиска с debounce — серверный вариант (loadFn) */
function setupSearch(state, loadFn) {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearch');

    input.addEventListener('input', Layout.debounce(() => {
        state.searchQuery = input.value.trim();
        clearBtn.classList.toggle('hidden', !state.searchQuery);
        state.currentPage = 1;
        loadFn();
    }, 300));

    clearBtn.addEventListener('click', () => {
        input.value = '';
        state.searchQuery = '';
        clearBtn.classList.add('hidden');
        state.currentPage = 1;
        loadFn();
    });
}

/** Настройка кнопок фильтрации — серверный вариант (loadFn) */
function setupFilters(state, loadFn, opts = {}) {
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
            state.currentPage = 1;
            loadFn();
        });
    });
}

/** Переключение сортировки — серверный вариант (loadFn) */
function toggleSort(state, field, loadFn) {
    if (state.sortField === field) {
        state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        state.sortField = field;
        state.sortDirection = 'asc';
    }
    updateSortIcons(state);
    state.currentPage = 1;
    loadFn();
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

/** Фильтрация по поисковому запросу (6 полей) — клиентский вариант для совместимости */
function matchesSearch(person, searchQuery) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const name = getDisplayName(person).toLowerCase();
    const spiritual = (person.spiritual_name || '').toLowerCase();
    const phone = (person.phone || '').toLowerCase();
    const email = (person.email || '').toLowerCase();
    const country = (person.country || '').toLowerCase();
    const teacher = (person.spiritual_teacher || '').toLowerCase();
    return name.includes(q) || spiritual.includes(q) ||
        phone.includes(q) || email.includes(q) ||
        country.includes(q) || teacher.includes(q);
}

/** Применить серверный поиск к Supabase-запросу */
function applyServerSearch(query, searchQuery) {
    if (!searchQuery) return query;
    const q = `%${searchQuery}%`;
    return query.or(
        `first_name.ilike.${q},last_name.ilike.${q},spiritual_name.ilike.${q},phone.ilike.${q},email.ilike.${q},country.ilike.${q},spiritual_teacher.ilike.${q}`
    );
}

/** Применить серверную сортировку к Supabase-запросу */
function applyServerSort(query, state) {
    const SORT_FIELD_MAP = {
        name: 'first_name',
        spiritual: 'spiritual_name',
        country: 'country',
        teacher: 'spiritual_teacher'
    };
    const dbField = SORT_FIELD_MAP[state.sortField] || 'spiritual_name';
    return query.order(dbField, { ascending: state.sortDirection === 'asc', nullsFirst: false });
}

/** Сортировка списка по полю (клиентская — для совместимости) */
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

/** Загрузка проживаний (stays) - команда + гости */
async function loadStays() {
    // Загружаем периоды пребывания команды и регистрации гостей параллельно
    const [teamStaysRes, guestRegsRes] = await Promise.all([
        Layout.db
            .from('vaishnava_stays')
            .select('vaishnava_id, start_date, end_date')
            .order('start_date'),
        Layout.db
            .from('retreat_registrations')
            .select('id, vaishnava_id, retreats(name_ru, name_en, name_hi)')
            .eq('is_deleted', false)
    ]);

    if (teamStaysRes.error) {
        console.error('Ошибка загрузки vaishnava_stays:', teamStaysRes.error);
    }
    if (guestRegsRes.error) {
        console.error('Ошибка загрузки retreat_registrations:', guestRegsRes.error);
    }

    const stays = {};

    // Добавляем периоды команды
    (teamStaysRes.data || []).forEach(s => {
        if (!stays[s.vaishnava_id]) stays[s.vaishnava_id] = [];
        stays[s.vaishnava_id].push({ start_date: s.start_date, end_date: s.end_date });
    });

    // Загружаем трансферы для всех регистраций
    const registrationIds = (guestRegsRes.data || []).map(r => r.id);
    if (registrationIds.length > 0) {
        const { data: transfers } = await Layout.db
            .from('guest_transfers')
            .select('registration_id, direction, flight_datetime')
            .in('registration_id', registrationIds);

        // Группируем трансферы по registration_id
        const transfersByReg = {};
        (transfers || []).forEach(t => {
            if (!transfersByReg[t.registration_id]) {
                transfersByReg[t.registration_id] = { arrival: null, departure: null };
            }
            if (t.direction === 'arrival' && t.flight_datetime) {
                transfersByReg[t.registration_id].arrival = t.flight_datetime.split('T')[0];
            } else if (t.direction === 'departure' && t.flight_datetime) {
                transfersByReg[t.registration_id].departure = t.flight_datetime.split('T')[0];
            }
        });

        // Добавляем периоды гостей (используем личные даты прилета/вылета)
        (guestRegsRes.data || []).forEach(r => {
            const regTransfers = transfersByReg[r.id];
            if (regTransfers && (regTransfers.arrival || regTransfers.departure)) {
                if (!stays[r.vaishnava_id]) stays[r.vaishnava_id] = [];
                stays[r.vaishnava_id].push({
                    start_date: regTransfers.arrival || regTransfers.departure,
                    end_date: regTransfers.departure || regTransfers.arrival,
                    retreat: r.retreats // информация о ретрите
                });
            }
        });
    }

    console.log('Загружено периодов команды:', teamStaysRes.data?.length || 0);
    console.log('Загружено регистраций гостей:', guestRegsRes.data?.length || 0);
    console.log('Всего уникальных людей:', Object.keys(stays).length);

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
        if (dept) {
            // Валидация цвета перед вставкой в style
            const safeColor = Utils.isValidColor(dept.color) ? dept.color : '#6b7280';
            badgeHtml = `<span class="badge badge-xs" style="background-color: ${safeColor}20; color: ${safeColor}; border-color: ${safeColor}">${e(Layout.getName(dept))}</span>`;
        } else {
            badgeHtml = '<span class="badge badge-primary badge-xs">Команда</span>';
        }
    }
    if (present) {
        badgeHtml += '<span class="badge badge-success badge-xs ml-1">Здесь</span>';
    }

    // Аватар: фото или инициалы
    const photoUrl = person.photo_url;
    const initials = e((person.spiritual_name || displayName)
        .split(' ')
        .map(w => w[0])
        .join('')
        .substring(0, 2)
        .toUpperCase());

    const avatarHtml = photoUrl
        ? `<img src="${e(photoUrl)}" class="w-10 h-10 rounded-full object-cover cursor-pointer avatar-photo" alt="" data-initials="${initials}" data-photo-url="${e(photoUrl)}" onerror="replacePhotoWithPlaceholder(this)">`
        : `<div class="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold">${initials}</div>`;

    return `
        <tr class="hover cursor-pointer" onclick="window.location.href='person.html?id=${e(person.id)}'">
            <td>
                <div class="flex items-center gap-3">
                    ${avatarHtml}
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

/** Рендер пагинации */
function renderPagination(containerId, state, totalCount, loadFn) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    const page = state.currentPage;
    let html = '<div class="flex justify-center py-4"><div class="join">';

    // Кнопка «Назад»
    html += `<button class="join-item btn btn-sm ${page <= 1 ? 'btn-disabled' : ''}" data-page="${page - 1}">&laquo;</button>`;

    // Номера страниц
    const maxVisible = 7;
    let start = Math.max(1, page - Math.floor(maxVisible / 2));
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start < maxVisible - 1) {
        start = Math.max(1, end - maxVisible + 1);
    }

    if (start > 1) {
        html += `<button class="join-item btn btn-sm" data-page="1">1</button>`;
        if (start > 2) html += `<button class="join-item btn btn-sm btn-disabled">...</button>`;
    }

    for (let i = start; i <= end; i++) {
        html += `<button class="join-item btn btn-sm ${i === page ? 'btn-active' : ''}" data-page="${i}">${i}</button>`;
    }

    if (end < totalPages) {
        if (end < totalPages - 1) html += `<button class="join-item btn btn-sm btn-disabled">...</button>`;
        html += `<button class="join-item btn btn-sm" data-page="${totalPages}">${totalPages}</button>`;
    }

    // Кнопка «Вперёд»
    html += `<button class="join-item btn btn-sm ${page >= totalPages ? 'btn-disabled' : ''}" data-page="${page + 1}">&raquo;</button>`;
    html += '</div></div>';

    container.innerHTML = html;

    // Обработчик кликов
    container.querySelectorAll('[data-page]').forEach(btn => {
        btn.addEventListener('click', () => {
            const p = parseInt(btn.dataset.page);
            if (p >= 1 && p <= totalPages && p !== page) {
                state.currentPage = p;
                loadFn();
                // Скроллим наверх таблицы
                const table = document.querySelector('.bg-base-100.rounded-xl');
                if (table) table.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    });
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
        phone: form.phone.value || null,
        email: form.email?.value || null,
        telegram_username: form.telegram_username?.value || null
    };

    // is_team_member определяется по галочке в форме
    if (form.is_team_member) {
        data.is_team_member = form.is_team_member.type === 'checkbox'
            ? form.is_team_member.checked
            : form.is_team_member.value === 'true';
    }

    if (!data.first_name && !data.spiritual_name) {
        Layout.showNotification(t('name_or_spiritual_required') || 'Укажите имя или духовное имя', 'warning');
        return;
    }

    const { data: newPerson, error } = await Layout.db
        .from('vaishnavas')
        .insert(data)
        .select()
        .single();

    if (error) {
        Layout.handleError(error, 'Сохранение');
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
    applyServerSearch,
    applyServerSort,
    sortPeople,
    loadStays,
    isPresent,
    renderPersonRow,
    renderPagination,
    openAddModal,
    closeAddModal,
    saveNewPerson,
    AVATAR_PLACEHOLDER,
    PAGE_SIZE
};

})();
