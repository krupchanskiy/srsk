// Профиль вайшнава
// Управление данными персоны, периодами проживания, регистрациями на ретриты

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
let person = null;
let stays = [];
let registrations = [];
let departments = [];
let teamMembers = [];
let spiritualTeachers = [];
let buildings = [];
let isEditMode = false;

const today = new Date().toISOString().split('T')[0];

// Страны
const COUNTRIES = [
    { code: 'RU', ru: 'Россия', en: 'Russia', hi: 'रूस' },
    { code: 'IN', ru: 'Индия', en: 'India', hi: 'भारत' },
    { code: 'UA', ru: 'Украина', en: 'Ukraine', hi: 'यूक्रेन' },
    { code: 'BY', ru: 'Беларусь', en: 'Belarus', hi: 'बेलारूस' },
    { code: 'KZ', ru: 'Казахстан', en: 'Kazakhstan', hi: 'कजाखस्तान' },
    { code: 'UZ', ru: 'Узбекистан', en: 'Uzbekistan', hi: 'उज़्बेकिस्तान' },
    { code: 'DE', ru: 'Германия', en: 'Germany', hi: 'जर्मनी' },
    { code: 'US', ru: 'США', en: 'USA', hi: 'अमेरिका' },
    { code: 'IL', ru: 'Израиль', en: 'Israel', hi: 'इज़राइल' },
    { code: 'GB', ru: 'Великобритания', en: 'United Kingdom', hi: 'यूनाइटेड किंगडम' }
];

async function init() {
    await Layout.init({ module: 'housing', menuId: 'vaishnavas', itemId: 'vaishnavas_all' });

    const params = new URLSearchParams(window.location.search);
    const personId = params.get('id');

    if (!personId) {
        window.location.href = 'index.html';
        return;
    }

    Layout.showLoader();
    // Сначала загружаем справочники, чтобы select'ы были заполнены
    await Promise.all([
        loadDepartments(),
        loadBuildingsAndRooms()
    ]);
    populateCountriesList();
    // Потом загружаем человека (renderPerson установит значения в select'ы)
    await loadPerson(personId);
    // Параллельно загружаем историю
    await Promise.all([
        loadStays(personId),
        loadRegistrations(personId)
    ]);
    Layout.hideLoader();
}

async function loadPerson(personId) {
    const { data, error } = await Layout.db
        .from('vaishnavas')
        .select('*, departments(id, name_ru, name_en, name_hi, color), senior:vaishnavas!senior_id(id, spiritual_name, first_name, last_name)')
        .eq('id', personId)
        .single();

    if (error || !data) {
        console.error('Error loading person:', error);
        window.location.href = 'index.html';
        return;
    }

    person = data;
    renderPerson();
}

async function loadDepartments() {
    const [deptData, teamRes, teachersRes, knownTeachersRes] = await Promise.all([
        Cache.getOrLoad('departments', async () => {
            const { data, error } = await Layout.db.from('departments').select('*').order('sort_order');
            if (error) { console.error('Error loading departments:', error); return null; }
            return data;
        }),
        Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name')
            .eq('is_team_member', true).eq('is_deleted', false).order('spiritual_name'),
        Layout.db.from('vaishnavas').select('spiritual_teacher')
            .not('spiritual_teacher', 'is', null).eq('is_deleted', false),
        Layout.db.from('spiritual_teachers').select('name_ru, name_en').order('sort_order')
    ]);
    departments = deptData || [];
    teamMembers = teamRes.data || [];
    // Объединяем известных гуру + уникальные из БД вайшнавов
    const knownGurus = (knownTeachersRes.data || []).map(t => Layout.currentLang === 'en' ? t.name_en : t.name_ru);
    const customTeachers = (teachersRes.data || []).map(v => v.spiritual_teacher).filter(Boolean);
    spiritualTeachers = [...new Set([...knownGurus, ...customTeachers])];
    populateDepartmentsSelect();
    populateSeniorsSelect();
}

async function loadStays(personId) {
    const { data } = await Layout.db
        .from('vaishnava_stays')
        .select('*')
        .eq('vaishnava_id', personId)
        .order('start_date', { ascending: false });
    stays = data || [];
    renderStays();
}

async function loadRegistrations(personId) {
    const { data } = await Layout.db
        .from('retreat_registrations')
        .select(`
            *,
            retreats(id, name_ru, name_en, name_hi, start_date, end_date),
            guest_transfers(*),
            guest_accommodations(*)
        `)
        .eq('vaishnava_id', personId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false });
    registrations = data || [];

    // Load residents (actual accommodation) for each registration
    if (registrations.length > 0) {
        const retreatIds = registrations.map(r => r.retreat_id).filter(Boolean);
        if (retreatIds.length > 0) {
            const { data: residentsData } = await Layout.db
                .from('residents')
                .select('retreat_id, room_id, rooms(number, buildings(name_ru, name_en, name_hi))')
                .eq('vaishnava_id', personId)
                .in('retreat_id', retreatIds)
                .in('status', ['active', 'confirmed']);

            // Map residents to registrations
            if (residentsData) {
                residentsData.forEach(res => {
                    const reg = registrations.find(r => r.retreat_id === res.retreat_id);
                    if (reg) {
                        reg.resident = res;
                    }
                });
            }
        }
    }

    renderRegistrations();
}

function renderPerson() {
    if (!person) return;

    const fullName = [person.first_name, person.last_name].filter(Boolean).join(' ') || t('no_name');
    const initials = (person.first_name?.[0] || '') + (person.last_name?.[0] || '');

    // Breadcrumb
    document.getElementById('breadcrumbName').textContent = person.spiritual_name || fullName;

    // View mode - Name
    if (person.spiritual_name) {
        document.getElementById('viewName').textContent = person.spiritual_name;
        document.getElementById('viewSecondaryName').textContent = fullName !== t('no_name') ? fullName : '';
    } else {
        document.getElementById('viewName').textContent = fullName;
        document.getElementById('viewSecondaryName').textContent = '';
    }

    // Edit mode - Name
    document.getElementById('editFirstName').value = person.first_name || '';
    document.getElementById('editLastName').value = person.last_name || '';
    document.getElementById('editSpiritualName').value = person.spiritual_name || '';

    // Avatar
    const avatarEl = document.getElementById('personAvatar');
    const deletePhotoBtn = document.getElementById('deletePhotoBtn');
    if (person.photo_url) {
        if (avatarEl && avatarEl.tagName !== 'IMG') {
            const img = document.createElement('img');
            img.src = person.photo_url;
            img.alt = '';
            img.className = 'person-avatar-lg object-cover';
            img.id = 'personAvatar';
            avatarEl.replaceWith(img);
        } else if (avatarEl.tagName === 'IMG') {
            avatarEl.src = person.photo_url;
        }
        deletePhotoBtn.classList.remove('hidden');
    } else {
        if (avatarEl && avatarEl.tagName === 'IMG') {
            const div = document.createElement('div');
            div.className = 'person-avatar-lg';
            div.id = 'personAvatar';
            div.textContent = initials.toUpperCase() || '?';
            avatarEl.replaceWith(div);
        } else if (avatarEl) {
            avatarEl.textContent = initials.toUpperCase() || '?';
        }
        deletePhotoBtn.classList.add('hidden');
    }

    // Badges
    const badgesEl = document.getElementById('personBadges');
    let badges = [];
    if (person.is_team_member) {
        const dept = person.departments;
        if (dept) {
            badges.push(`<span class="badge" style="background-color: ${dept.color}20; color: ${dept.color}; border-color: ${dept.color}">${Layout.getName(dept)}</span>`);
        } else {
            badges.push(`<span class="badge badge-primary">${t('team_member') || 'Команда'}</span>`);
        }
    }
    badgesEl.innerHTML = badges.join('');

    // Contact info - view
    renderViewPhone();
    renderViewEmail();
    renderViewTelegram();
    document.getElementById('viewCountry').textContent = getCountryName(person.country) || person.country || '—';
    document.getElementById('viewCity').textContent = person.city || '—';

    // Contact info - edit
    document.getElementById('editPhone').value = person.phone || '';
    document.getElementById('editHasWhatsapp').checked = person.has_whatsapp || false;
    document.getElementById('editEmail').value = person.email || '';
    document.getElementById('editTelegram').value = person.telegram || '';
    document.getElementById('editCountry').value = getCountryName(person.country) || '';
    document.getElementById('editCity').value = person.city || '';

    // Personal info - view
    document.getElementById('viewGender').textContent = person.gender ? t(person.gender) : '—';
    document.getElementById('viewBirthDate').textContent = person.birth_date ? formatDate(person.birth_date) : '—';
    document.getElementById('viewIndiaExperience').textContent = person.india_experience || '—';
    document.getElementById('viewSpiritualTeacher').textContent = person.spiritual_teacher || '—';

    // Personal info - edit
    document.getElementById('editGender').value = person.gender || '';
    document.getElementById('editBirthDate').value = person.birth_date || '';
    document.getElementById('editIndiaExperience').value = person.india_experience || '';
    document.getElementById('editSpiritualTeacher').value = person.spiritual_teacher || '';

    // Team section
    document.getElementById('editIsTeamMember').checked = person.is_team_member;
    document.getElementById('viewDepartment').textContent = person.departments ? Layout.getName(person.departments) : '—';
    document.getElementById('editDepartment').value = person.department_id || '';
    document.getElementById('viewService').textContent = person.service || '—';
    document.getElementById('editService').value = person.service || '';
    const seniorName = person.senior ? getVaishnavName(person.senior) : '—';
    document.getElementById('viewSenior').textContent = seniorName;
    document.getElementById('editSenior').value = person.senior_id || '';
    populateSeniorsSelect(); // Обновляем список старших
    if (person.senior_id) document.getElementById('editSenior').value = person.senior_id;
    document.getElementById('viewPassport').textContent = person.passport || '—';
    document.getElementById('editPassport').value = person.passport || '';

    // Виза
    const visaTypes = { tourist: 'Туристическая', business: 'Бизнес', volunteer: 'Волонтёрская', religious: 'Религиозная', other: 'Другая' };
    document.getElementById('viewVisaType').textContent = visaTypes[person.visa_type] || '—';
    document.getElementById('editVisaType').value = person.visa_type || '';
    document.getElementById('viewVisaExpiry').textContent = person.visa_expiry ? formatDate(person.visa_expiry) : '—';
    document.getElementById('editVisaExpiry').value = person.visa_expiry || '';

    // Индийский телефон
    document.getElementById('viewIndianPhone').textContent = person.indian_phone ? '+91 ' + person.indian_phone : '—';
    document.getElementById('editIndianPhone').value = person.indian_phone || '';
    document.getElementById('editIndianPhoneWhatsapp').checked = person.indian_phone_whatsapp || false;
    document.getElementById('viewIndianPhoneWhatsapp').classList.toggle('hidden', !person.indian_phone_whatsapp);

    document.getElementById('teamBadgeView').textContent = person.is_team_member ? (t('yes') || 'Да') : (t('no') || 'Нет');

    // Show/hide team-specific sections
    toggleTeamSections();

    // Notes
    document.getElementById('viewNotes').textContent = person.notes || '—';
    document.getElementById('editNotes').value = person.notes || '';
}

function toggleTeamSections() {
    const isTeam = person?.is_team_member || document.getElementById('editIsTeamMember')?.checked;
    document.getElementById('staysSection').style.display = isTeam ? 'block' : 'none';
    document.getElementById('teamSection').style.display = isTeam ? 'block' : 'none';
    document.getElementById('indiaExperienceField').style.display = isTeam ? 'none' : 'block';
}

function toggleTeamFields() {
    toggleTeamSections();
}

function renderViewPhone() {
    const el = document.getElementById('viewPhone');
    if (person.phone) {
        const waNumber = person.phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
        const waLink = person.has_whatsapp
            ? ` <a href="https://wa.me/${waNumber}" target="_blank" class="text-green-500" title="WhatsApp"><svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4 inline" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>`
            : '';
        el.innerHTML = `${e(person.phone)}${waLink}`;
    } else {
        el.textContent = '—';
    }
}

function renderViewEmail() {
    const el = document.getElementById('viewEmail');
    if (person.email) {
        el.innerHTML = `<a href="mailto:${e(person.email)}" class="link link-primary">${e(person.email)}</a>`;
    } else {
        el.textContent = '—';
    }
}

function renderViewTelegram() {
    const el = document.getElementById('viewTelegram');
    if (person.telegram) {
        const tgUsername = person.telegram.replace(/^@/, '');
        el.innerHTML = `<a href="https://t.me/${e(tgUsername)}" target="_blank" class="link link-primary">${e(person.telegram)}</a>`;
    } else {
        el.textContent = '—';
    }
}

function getCountryName(code) {
    if (!code) return null;
    const country = COUNTRIES.find(c => c.code === code || c.ru === code || c.en === code);
    if (country) {
        return country[Layout.currentLang] || country.ru;
    }
    return code;
}

function normalizeCountry(input) {
    if (!input) return null;
    const inputLower = input.toLowerCase().trim();
    for (const country of COUNTRIES) {
        if (country.ru.toLowerCase() === inputLower ||
            country.en.toLowerCase() === inputLower ||
            country.code.toLowerCase() === inputLower) {
            return country.code;
        }
    }
    return input;
}

function populateCountriesList() {
    const datalist = document.getElementById('countriesList');
    const lang = Layout.currentLang;
    datalist.innerHTML = COUNTRIES.map(c => `<option value="${c[lang] || c.ru}">`).join('');
}

function populateDepartmentsSelect() {
    const select = document.getElementById('editDepartment');
    select.innerHTML = '<option value="">—</option>' +
        departments.map(d => `<option value="${d.id}">${Layout.getName(d)}</option>`).join('');
}

function populateSeniorsSelect() {
    const select = document.getElementById('editSenior');
    // Исключаем текущего человека из списка
    const currentId = person?.id;
    const filtered = teamMembers.filter(m => m.id !== currentId);
    select.innerHTML = '<option value="">—</option>' +
        filtered.map(m => {
            const name = m.spiritual_name || `${m.first_name || ''} ${m.last_name || ''}`.trim() || '—';
            return `<option value="${m.id}">${name}</option>`;
        }).join('');
}

function getVaishnavName(v) {
    return v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || '—';
}

// ===== Автокомплит духовного учителя =====
function searchSpiritualTeachers(query) {
    const suggestionsEl = document.getElementById('spiritualTeacherSuggestions');
    if (!query || query.length < 2) {
        suggestionsEl.classList.add('hidden');
        return;
    }
    const q = query.toLowerCase();
    const matches = spiritualTeachers.filter(t => t.toLowerCase().includes(q)).slice(0, 8);
    if (matches.length === 0) {
        suggestionsEl.classList.add('hidden');
        return;
    }
    suggestionsEl.innerHTML = matches.map(t =>
        `<div class="px-3 py-2 hover:bg-base-200 cursor-pointer" onclick="selectSpiritualTeacher('${t.replace(/'/g, "\\'")}')">${t}</div>`
    ).join('');
    suggestionsEl.classList.remove('hidden');
}

function showSpiritualTeacherSuggestions() {
    const query = document.getElementById('editSpiritualTeacher').value;
    if (query.length >= 2) {
        searchSpiritualTeachers(query);
    }
}

function selectSpiritualTeacher(name) {
    document.getElementById('editSpiritualTeacher').value = name;
    document.getElementById('spiritualTeacherSuggestions').classList.add('hidden');
}

// Закрытие подсказок при клике вне
document.addEventListener('click', (e) => {
    const suggestions = document.getElementById('spiritualTeacherSuggestions');
    const input = document.getElementById('editSpiritualTeacher');
    if (suggestions && !suggestions.contains(e.target) && e.target !== input) {
        suggestions.classList.add('hidden');
    }
});

function formatDate(dateStr) {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric'
    });
}

function formatFlightDateTime(datetime, fallbackNotes) {
    if (!datetime) return fallbackNotes || '';
    const date = new Date(datetime);
    const day = date.getDate();
    const monthNames = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const month = monthNames[date.getMonth()];
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${day} ${month}, ${hours}:${minutes}`;
}

// ==================== GUEST PORTAL ====================

function openGuestPortal() {
    if (person?.id) {
        // Используем относительный путь от vaishnavas/
        window.open(`../guest-portal/index.html?view=${person.id}`, '_blank');
    }
}

// ==================== EDIT MODE ====================

function enterEditMode() {
    isEditMode = true;
    document.getElementById('profileContainer').classList.remove('view-mode');
    document.getElementById('profileContainer').classList.add('edit-mode');
    document.getElementById('editFirstName').focus();
}

function cancelEdit() {
    isEditMode = false;
    document.getElementById('profileContainer').classList.remove('edit-mode');
    document.getElementById('profileContainer').classList.add('view-mode');
    renderPerson();
}

async function savePerson() {
    if (!person) return;

    const saveBtn = document.querySelector('.edit-only.btn-primary');
    if (saveBtn) saveBtn.classList.add('loading');

    const updateData = {
        first_name: document.getElementById('editFirstName').value || null,
        last_name: document.getElementById('editLastName').value || null,
        spiritual_name: document.getElementById('editSpiritualName').value || null,
        phone: document.getElementById('editPhone').value || null,
        has_whatsapp: document.getElementById('editHasWhatsapp').checked,
        email: document.getElementById('editEmail').value || null,
        telegram: document.getElementById('editTelegram').value || null,
        country: normalizeCountry(document.getElementById('editCountry').value),
        city: document.getElementById('editCity').value || null,
        gender: document.getElementById('editGender').value || null,
        birth_date: document.getElementById('editBirthDate').value || null,
        india_experience: document.getElementById('editIndiaExperience').value || null,
        spiritual_teacher: document.getElementById('editSpiritualTeacher').value || null,
        is_team_member: document.getElementById('editIsTeamMember').checked,
        department_id: document.getElementById('editDepartment').value || null,
        service: document.getElementById('editService').value || null,
        senior_id: document.getElementById('editSenior').value || null,
        passport: document.getElementById('editPassport').value || null,
        visa_type: document.getElementById('editVisaType').value || null,
        visa_expiry: document.getElementById('editVisaExpiry').value || null,
        indian_phone: document.getElementById('editIndianPhone').value || null,
        indian_phone_whatsapp: document.getElementById('editIndianPhoneWhatsapp').checked,
        notes: document.getElementById('editNotes').value || null
    };

    if (!updateData.first_name && !updateData.spiritual_name) {
        Layout.showNotification(t('name_or_spiritual_required') || 'Укажите имя или духовное имя', 'warning');
        if (saveBtn) saveBtn.classList.remove('loading');
        return;
    }

    const { data, error } = await Layout.db
        .from('vaishnavas')
        .update(updateData)
        .eq('id', person.id)
        .select('*, departments(id, name_ru, name_en, name_hi, color), senior:vaishnavas!senior_id(id, spiritual_name, first_name, last_name)')
        .single();

    if (saveBtn) saveBtn.classList.remove('loading');

    if (error) {
        console.error('Error saving:', error);
        Layout.showNotification(t('error_saving') || 'Ошибка сохранения', 'error');
        return;
    }

    person = data;
    isEditMode = false;
    document.getElementById('profileContainer').classList.remove('edit-mode');
    document.getElementById('profileContainer').classList.add('view-mode');
    renderPerson();
}

async function deletePerson() {
    const confirmed = await ModalUtils.confirm(t('confirm_delete') || 'Удалить?');
    if (!confirmed) return;

    const { error } = await Layout.db
        .from('vaishnavas')
        .update({ is_deleted: true })
        .eq('id', person.id);

    if (error) {
        console.error('Error deleting:', error);
        Layout.showNotification(t('error_deleting'), 'error');
        return;
    }

    window.location.href = 'index.html';
}

// ==================== STAYS ====================

function renderStays() {
    const container = document.getElementById('staysList');
    const emptyState = document.getElementById('emptyStays');

    if (stays.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    container.innerHTML = stays.map(stay => {
        const isCurrent = stay.start_date <= today && stay.end_date >= today;
        const isFuture = stay.start_date > today;
        const isPermanent = stay.end_date >= '2099-01-01';

        let stayClass = 'stay-card';
        if (isCurrent) stayClass += ' stay-current';
        else if (isFuture) stayClass += ' stay-future';
        else stayClass += ' stay-past';

        const dateDisplay = isPermanent
            ? 'Находится в ШРСК'
            : `${formatDate(stay.start_date)} — ${formatDate(stay.end_date)}`;

        return `
            <div class="${stayClass} border rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow" onclick="openStayModal('${stay.id}')">
                <div class="flex items-center justify-between">
                    <div>
                        <div class="font-medium">${dateDisplay}</div>
                        ${stay.comment ? `<div class="text-sm opacity-60 mt-1">${stay.comment}</div>` : ''}
                    </div>
                    ${isCurrent ? `<span class="badge badge-success badge-sm">${t('here_now') || 'Здесь'}</span>` : ''}
                    ${isFuture ? `<span class="badge badge-info badge-sm">${t('planned') || 'План'}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

let editingStayId = null;

function togglePermanentStay(isPermanent) {
    const datesContainer = document.getElementById('datesContainer');
    const startDateInput = document.getElementById('stayStartDate');
    const endDateInput = document.getElementById('stayEndDate');

    if (isPermanent) {
        datesContainer.classList.add('hidden');
        startDateInput.removeAttribute('required');
        endDateInput.removeAttribute('required');
    } else {
        datesContainer.classList.remove('hidden');
        startDateInput.setAttribute('required', 'required');
        endDateInput.setAttribute('required', 'required');
    }
}

function openStayModal(stayId = null) {
    const form = document.getElementById('stayForm');
    form.reset();
    editingStayId = stayId;

    const isPermanentCheckbox = document.getElementById('isPermanentStay');
    isPermanentCheckbox.checked = false;
    togglePermanentStay(false);

    if (stayId) {
        const stay = stays.find(s => s.id === stayId);
        if (stay) {
            form.querySelector('[name="stay_id"]').value = stay.id;

            // Проверяем, является ли период "постоянным" (end_date >= 2099-01-01)
            const isPermanent = stay.end_date >= '2099-01-01';
            isPermanentCheckbox.checked = isPermanent;
            togglePermanentStay(isPermanent);

            if (!isPermanent) {
                form.querySelector('[name="start_date"]').value = stay.start_date;
                form.querySelector('[name="end_date"]').value = stay.end_date;
            }
            form.querySelector('[name="comment"]').value = stay.comment || '';
        }
        document.getElementById('stayModalTitle').textContent = t('edit_stay') || 'Редактировать';
        document.querySelectorAll('.edit-stay-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.getElementById('stayModalTitle').textContent = t('add_stay') || 'Добавить';
        document.querySelectorAll('.edit-stay-only').forEach(el => el.classList.add('hidden'));
    }

    document.getElementById('stayModal').showModal();
}

function closeStayModal() {
    document.getElementById('stayModal').close();
    editingStayId = null;
}

async function saveStay(event) {
    event.preventDefault();
    const form = event.target;

    const isPermanent = document.getElementById('isPermanentStay').checked;

    const stayData = {
        vaishnava_id: person.id,
        start_date: isPermanent ? '2020-01-01' : form.start_date.value,
        end_date: isPermanent ? '2099-12-31' : form.end_date.value,
        comment: form.comment.value || null
    };

    let result;
    if (editingStayId) {
        result = await Layout.db.from('vaishnava_stays').update(stayData).eq('id', editingStayId);
    } else {
        result = await Layout.db.from('vaishnava_stays').insert(stayData);
    }

    if (result.error) {
        console.error('Error saving stay:', result.error);
        Layout.showNotification(t('error_saving'), 'error');
        return;
    }

    closeStayModal();
    await loadStays(person.id);
}

async function deleteStay() {
    if (!editingStayId) return;
    const confirmed = await ModalUtils.confirm(t('confirm_delete') || 'Удалить?');
    if (!confirmed) return;

    const { error } = await Layout.db.from('vaishnava_stays').delete().eq('id', editingStayId);
    if (error) {
        console.error('Error deleting stay:', error);
        Layout.showNotification(t('error_deleting'), 'error');
        return;
    }

    closeStayModal();
    await loadStays(person.id);
}

// ==================== ADD TO RETREAT ====================

let availableRetreats = [];

async function loadAvailableRetreats() {
    const today = new Date().toISOString().split('T')[0];

    // Загружаем ретриты: либо с открытой регистрацией, либо будущие/текущие
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date')
        .or(`registration_open.eq.true,end_date.gte.${today}`)
        .order('start_date', { ascending: true });

    if (error) {
        console.error('Error loading retreats:', error);
        return [];
    }

    availableRetreats = data || [];
    return availableRetreats;
}

async function openAddRetreatModal() {
    // Загружаем ретриты если ещё не загружены
    if (availableRetreats.length === 0) {
        await loadAvailableRetreats();
    }

    const select = document.getElementById('retreatSelect');

    // Фильтруем ретриты, на которые человек уже зарегистрирован
    const registeredRetreatIds = registrations.map(r => r.retreat_id);
    const unregisteredRetreats = availableRetreats.filter(r => !registeredRetreatIds.includes(r.id));

    // Заполняем select
    select.innerHTML = '<option value="">' + (t('select_retreat') || 'Выберите ретрит...') + '</option>';
    unregisteredRetreats.forEach(retreat => {
        const option = document.createElement('option');
        option.value = retreat.id;
        option.textContent = `${Layout.getName(retreat)} (${formatDate(retreat.start_date)} — ${formatDate(retreat.end_date)})`;
        select.appendChild(option);
    });

    // Сбрасываем форму
    document.getElementById('retreatStatusSelect').value = 'guest';
    document.getElementById('retreatOrgNotes').value = '';

    document.getElementById('addRetreatModal').showModal();
}

function closeAddRetreatModal() {
    document.getElementById('addRetreatModal').close();
}

async function saveRetreatRegistration(event) {
    event.preventDefault();

    const retreatId = document.getElementById('retreatSelect').value;
    const status = document.getElementById('retreatStatusSelect').value;
    const orgNotes = document.getElementById('retreatOrgNotes').value.trim() || null;

    if (!retreatId) {
        Layout.showNotification(t('select_retreat') || 'Выберите ретрит', 'warning');
        return;
    }

    const data = {
        retreat_id: retreatId,
        vaishnava_id: person.id,
        status: status,
        org_notes: orgNotes
    };

    const { error } = await Layout.db
        .from('retreat_registrations')
        .insert(data);

    if (error) {
        console.error('Error saving registration:', error);
        Layout.showNotification((t('error_saving') || 'Ошибка сохранения') + ': ' + error.message, 'error');
        return;
    }

    closeAddRetreatModal();
    await loadRegistrations(person.id);
}

// ==================== BUILDINGS & ROOMS ====================

async function loadBuildingsAndRooms() {
    const { data, error } = await Layout.db
        .from('buildings')
        .select('*, rooms(*)')
        .eq('is_active', true)
        .order('sort_order');

    if (error) console.error('Error loading buildings:', error);
    buildings = data || [];
}

// ==================== REGISTRATION STATUS ====================

async function updateRegistrationStatus(registrationId, newStatus, selectElement) {
    const reg = registrations.find(r => r.id === registrationId);
    const oldStatus = reg?.status;

    try {
        const { error } = await Layout.db
            .from('retreat_registrations')
            .update({ status: newStatus })
            .eq('id', registrationId);

        if (error) throw error;

        // Update local data
        if (reg) reg.status = newStatus;

        // Update select element class
        if (selectElement) {
            selectElement.className = selectElement.className.replace(/status-\w+/, `status-${newStatus}`);
        }

        // Update badge
        renderRegistrations();
    } catch (err) {
        console.error('Error updating status:', err);
        Layout.showNotification(t('update_status_error') + ': ' + err.message, 'error');
        if (selectElement && oldStatus) {
            selectElement.value = oldStatus;
        }
    }
}

// ==================== EDIT REGISTRATION ====================

let currentEditRegId = null;

function openEditRegModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    currentEditRegId = registrationId;
    document.getElementById('editRegId').value = registrationId;

    // Статус
    document.getElementById('editRegStatus').value = reg.status || 'guest';

    // Питание
    document.getElementById('editMealType').value = reg.meal_type || '';

    // Трансферы
    const transfers = reg.guest_transfers || [];
    const arrival = transfers.find(t => t.direction === 'arrival');
    const departure = transfers.find(t => t.direction === 'departure');

    // Прилёт
    document.getElementById('editArrivalDatetime').value = arrival?.flight_datetime ? arrival.flight_datetime.slice(0, 16) : '';
    document.getElementById('editArrivalFlight').value = arrival?.flight_number || '';
    document.getElementById('editArrivalTransfer').value = arrival?.needs_transfer || '';
    document.getElementById('editArrivalNotes').value = arrival?.notes || '';

    // Вылет
    document.getElementById('editDepartureDatetime').value = departure?.flight_datetime ? departure.flight_datetime.slice(0, 16) : '';
    document.getElementById('editDepartureFlight').value = departure?.flight_number || '';
    document.getElementById('editDepartureTransfer').value = departure?.needs_transfer || '';
    document.getElementById('editDepartureNotes').value = departure?.notes || '';

    // Остальные поля
    document.getElementById('editAccommodationWishes').value = reg.accommodation_wishes || '';
    document.getElementById('editCompanions').value = reg.companions || '';
    document.getElementById('editExtendedStay').value = reg.extended_stay || '';
    document.getElementById('editPaymentNotes').value = reg.payment_notes || '';
    document.getElementById('editOrgNotes').value = reg.org_notes || '';
    document.getElementById('editGuestQuestions').value = reg.guest_questions || '';

    editRegModal.showModal();
}

async function saveRegistration() {
    const regId = currentEditRegId;
    if (!regId) return;

    const reg = registrations.find(r => r.id === regId);
    if (!reg) return;

    try {
        // Обновляем регистрацию
        const regData = {
            status: document.getElementById('editRegStatus').value,
            meal_type: document.getElementById('editMealType').value || null,
            accommodation_wishes: document.getElementById('editAccommodationWishes').value || null,
            companions: document.getElementById('editCompanions').value || null,
            extended_stay: document.getElementById('editExtendedStay').value || null,
            payment_notes: document.getElementById('editPaymentNotes').value || null,
            org_notes: document.getElementById('editOrgNotes').value || null,
            guest_questions: document.getElementById('editGuestQuestions').value || null
        };

        const { error: regError } = await Layout.db
            .from('retreat_registrations')
            .update(regData)
            .eq('id', regId);

        if (regError) throw regError;

        // Обновляем/создаём трансферы
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');

        // Прилёт
        const arrivalData = {
            registration_id: regId,
            direction: 'arrival',
            flight_datetime: document.getElementById('editArrivalDatetime').value || null,
            flight_number: document.getElementById('editArrivalFlight').value || null,
            needs_transfer: document.getElementById('editArrivalTransfer').value || null,
            notes: document.getElementById('editArrivalNotes').value || null
        };

        if (arrival) {
            await Layout.db.from('guest_transfers').update(arrivalData).eq('id', arrival.id);
        } else if (arrivalData.flight_datetime || arrivalData.flight_number || arrivalData.needs_transfer || arrivalData.notes) {
            await Layout.db.from('guest_transfers').insert(arrivalData);
        }

        // Вылет
        const departureData = {
            registration_id: regId,
            direction: 'departure',
            flight_datetime: document.getElementById('editDepartureDatetime').value || null,
            flight_number: document.getElementById('editDepartureFlight').value || null,
            needs_transfer: document.getElementById('editDepartureTransfer').value || null,
            notes: document.getElementById('editDepartureNotes').value || null
        };

        if (departure) {
            await Layout.db.from('guest_transfers').update(departureData).eq('id', departure.id);
        } else if (departureData.flight_datetime || departureData.flight_number || departureData.needs_transfer || departureData.notes) {
            await Layout.db.from('guest_transfers').insert(departureData);
        }

        // Перезагружаем данные
        await loadRegistrations();
        renderRegistrations();

        editRegModal.close();
    } catch (err) {
        console.error('Error saving registration:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

// ==================== PLACEMENT ====================

let currentPlacementRegId = null;

function openPlacementModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    currentPlacementRegId = registrationId;

    const modal = document.getElementById('placementModal');
    const retreatInfo = document.getElementById('placementRetreatInfo');

    // Show retreat info
    const retreat = reg.retreats;
    retreatInfo.innerHTML = `
        <div class="font-medium">${retreat ? Layout.getName(retreat) : '—'}</div>
        ${reg.accommodation_wishes ? `<div class="text-sm opacity-60 mt-1">${reg.accommodation_wishes}</div>` : ''}
    `;

    // Set default dates from retreat
    if (retreat) {
        document.getElementById('placementCheckIn').value = retreat.start_date;
        document.getElementById('placementCheckOut').value = retreat.end_date;
    }

    modal.showModal();
    updateRoomsList();
}

async function updateRoomsList() {
    const roomsList = document.getElementById('roomsList');
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    if (!checkIn || !checkOut) {
        roomsList.innerHTML = '<div class="text-center py-4 opacity-50">Укажите даты заезда и выезда</div>';
        return;
    }

    roomsList.innerHTML = '<div class="text-center py-4"><span class="loading loading-spinner"></span></div>';

    // Load occupancy for the date range from multiple sources
    const [residentsRes, accommodationsRes] = await Promise.all([
        // Заселённые гости (residents)
        Layout.db.from('residents')
            .select('room_id')
            .lte('check_in', checkOut)
            .gte('check_out', checkIn),
        // Бронирования гостей ретритов (guest_accommodations)
        Layout.db.from('guest_accommodations')
            .select('room_id')
            .not('room_id', 'is', null)
            .lte('check_in_date', checkOut)
            .gte('check_out_date', checkIn)
    ]);

    if (residentsRes.error) {
        console.error('Error loading residents:', residentsRes.error);
    }
    if (accommodationsRes.error) {
        console.error('Error loading accommodations:', accommodationsRes.error);
    }

    // Count occupancy per room from all sources
    const roomOccupancy = {};
    (residentsRes.data || []).forEach(r => {
        if (r.room_id) roomOccupancy[r.room_id] = (roomOccupancy[r.room_id] || 0) + 1;
    });
    (accommodationsRes.data || []).forEach(r => {
        if (r.room_id) roomOccupancy[r.room_id] = (roomOccupancy[r.room_id] || 0) + 1;
    });

    // Фильтруем временные здания по датам
    const availableBuildings = buildings.filter(b => {
        // Постоянные здания показываем всегда
        if (!b.is_temporary) return true;
        // Временные — только если период аренды пересекается с датами заезда/выезда
        return b.available_from <= checkOut && b.available_until >= checkIn;
    });

    if (availableBuildings.length === 0) {
        roomsList.innerHTML = '<div class="text-center py-4 opacity-50">Нет доступных зданий</div>';
        return;
    }

    let html = '';
    availableBuildings.forEach(building => {
        const rooms = (building.rooms?.filter(r => r.is_active) || [])
            .sort((a, b) => {
                if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
                return a.number.localeCompare(b.number, undefined, { numeric: true });
            });

        if (rooms.length === 0) return;

        html += `<div class="collapse collapse-arrow bg-base-200 rounded-lg">
            <input type="checkbox" checked />
            <div class="collapse-title font-medium py-2">${Layout.getName(building)}</div>
            <div class="collapse-content p-0">
                <div class="grid grid-cols-4 sm:grid-cols-6 gap-1 p-2">`;

        rooms.forEach(room => {
            const occupied = roomOccupancy[room.id] || 0;
            const capacity = room.capacity || 1;
            const isFull = occupied >= capacity;

            let btnClass, label, disabled;

            if (isFull) {
                btnClass = 'btn-disabled bg-red-100 text-red-400';
                label = `${room.number} <span class="text-xs">${occupied}/${capacity}</span>`;
                disabled = true;
            } else if (occupied > 0) {
                btnClass = 'btn-outline btn-warning';
                label = `${room.number} <span class="text-xs">${occupied}/${capacity}</span>`;
                disabled = false;
            } else {
                btnClass = 'btn-outline btn-success';
                label = room.number;
                disabled = false;
            }

            html += `<button type="button" class="btn btn-sm ${btnClass}"
                ${disabled ? 'disabled' : `onclick="selectRoom('${room.id}', '${building.id}')"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html || '<div class="text-center py-4 opacity-50">Нет комнат</div>';
}

async function selectRoom(roomId, buildingId) {
    const building = buildings.find(b => b.id === buildingId);
    const room = building?.rooms?.find(r => r.id === roomId);
    if (!room) return;

    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    const data = {
        registration_id: currentPlacementRegId,
        room_id: roomId,
        building_name: Layout.getName(building),
        room_number: room.number,
        room_type: room.capacity ? `${room.capacity}-местная` : null,
        check_in_date: checkIn || null,
        check_out_date: checkOut || null
    };

    try {
        // Check if accommodation already exists
        const { data: existing } = await Layout.db
            .from('guest_accommodations')
            .select('id')
            .eq('registration_id', data.registration_id)
            .maybeSingle();

        if (existing) {
            const { error } = await Layout.db
                .from('guest_accommodations')
                .update(data)
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await Layout.db
                .from('guest_accommodations')
                .insert(data);
            if (error) throw error;
        }

        document.getElementById('placementModal').close();
        await loadRegistrations(person.id);
    } catch (err) {
        console.error('Error saving placement:', err);
        Layout.showNotification(t('placement_error') + ': ' + err.message, 'error');
    }
}

// ==================== REGISTRATIONS ====================

function renderRegistrations() {
    const container = document.getElementById('registrationsList');
    const emptyState = document.getElementById('emptyRegistrations');
    const countBadge = document.getElementById('retreatsCount');

    countBadge.textContent = registrations.length;

    if (registrations.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    container.innerHTML = registrations.map(reg => {
        const retreat = reg.retreats;
        const statusClass = `status-${reg.status}`;
        const statusLabel = t(`status_${reg.status}`) || reg.status;
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');

        // Check if there's any detail to show
        const hasDetails = arrival || departure || reg.resident || reg.guest_accommodations?.[0] || reg.accommodation_wishes || reg.companions || reg.payment_notes || reg.org_notes || reg.extended_stay || reg.guest_questions;

        // Build details HTML
        let detailsHtml = '';

        if (arrival) {
            const arrivalTime = formatFlightDateTime(arrival.flight_datetime, arrival.notes);
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">✈️ Прилёт</div>
                    <div class="text-sm space-y-1">
                        ${arrivalTime ? `<div><span class="opacity-60">Время:</span> ${arrivalTime}</div>` : ''}
                        ${arrival.flight_number ? `<div><span class="opacity-60">Рейс:</span> ${arrival.flight_number}</div>` : ''}
                        <div><span class="opacity-60">Трансфер:</span> ${arrival.needs_transfer === 'yes' ? '✅ Нужен' : arrival.needs_transfer === 'no' ? '❌ Не нужен' : arrival.needs_transfer || '—'}</div>
                    </div>
                </div>
            `;
        }

        if (departure) {
            const departureTime = formatFlightDateTime(departure.flight_datetime, departure.notes);
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">✈️ Вылет</div>
                    <div class="text-sm space-y-1">
                        ${departureTime ? `<div><span class="opacity-60">Время:</span> ${departureTime}</div>` : ''}
                        ${departure.flight_number ? `<div><span class="opacity-60">Рейс:</span> ${departure.flight_number}</div>` : ''}
                        <div><span class="opacity-60">Трансфер:</span> ${departure.needs_transfer === 'yes' ? '✅ Нужен' : departure.needs_transfer === 'no' ? '❌ Не нужен' : departure.needs_transfer || '—'}</div>
                    </div>
                </div>
            `;
        }

        // Размещение (из residents или из guest_accommodations для старых данных)
        const resident = reg.resident;
        const accommodation = reg.guest_accommodations?.[0];

        if (resident) {
            // Self-accommodation (NULL room_id)
            if (!resident.room_id) {
                detailsHtml += `
                    <div class="detail-section">
                        <div class="detail-label">🏠 Размещение</div>
                        <div class="text-sm font-medium text-error bg-error/20 px-2 py-1 rounded inline-block">${t('self_accommodation')}</div>
                    </div>
                `;
            } else if (resident.rooms) {
                // Regular accommodation
                const buildingName = resident.rooms.buildings ? Layout.getName(resident.rooms.buildings) : '';
                const roomNumber = resident.rooms.number || '';
                detailsHtml += `
                    <div class="detail-section">
                        <div class="detail-label">🏠 Размещение</div>
                        <div class="text-sm font-medium text-success">${buildingName ? buildingName + ', ' : ''}${roomNumber}</div>
                    </div>
                `;
            }
        } else if (accommodation?.room_number) {
            // Legacy accommodation data
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🏠 Размещение</div>
                    <div class="text-sm font-medium text-success">${accommodation.building_name ? accommodation.building_name + ', ' : ''}${accommodation.room_number}</div>
                </div>
            `;
        }

        if (reg.companions) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">👨‍👩‍👧 Семья / Спутники</div>
                    <div class="text-sm">${reg.companions}</div>
                </div>
            `;
        }

        if (reg.accommodation_wishes) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🏨 Пожелания по проживанию</div>
                    <div class="text-sm">${reg.accommodation_wishes}</div>
                </div>
            `;
        }

        if (reg.extended_stay) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">📅 После ретрита</div>
                    <div class="text-sm whitespace-pre-line">${reg.extended_stay}</div>
                </div>
            `;
        }

        if (reg.meal_type) {
            const mealTypeLabels = {
                'prasad': t('meal_type_prasad'),
                'self': t('meal_type_self'),
                'child': t('meal_type_child')
            };
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🍽️ ${t('meal_type')}</div>
                    <div class="text-sm">${mealTypeLabels[reg.meal_type] || reg.meal_type}</div>
                </div>
            `;
        }

        if (reg.payment_notes) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">💳 Оплата</div>
                    <div class="text-sm">${e(reg.payment_notes)}</div>
                </div>
            `;
        }

        if (reg.org_notes) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">📋 Комментарий ОП</div>
                    <div class="text-sm whitespace-pre-line">${e(reg.org_notes)}</div>
                </div>
            `;
        }

        if (reg.guest_questions) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">❓ Вопросы</div>
                    <div class="text-sm whitespace-pre-line">${e(reg.guest_questions)}</div>
                </div>
            `;
        }

        const regDateStr = reg.registration_date ? `<span class="text-xs opacity-40 ml-2">зарег. ${formatDate(reg.registration_date)}</span>` : '';

        // Actions section
        const actionsHtml = `
            <div class="detail-section border-t pt-3 mt-3 flex items-center gap-3">
                <select class="select select-xs status-${reg.status}" style="min-width: 0; padding-right: 1.5rem;" onchange="updateRegistrationStatus('${reg.id}', this.value, this)" onclick="event.stopPropagation()">
                    <option value="guest" ${reg.status === 'guest' ? 'selected' : ''}>Гость</option>
                    <option value="team" ${reg.status === 'team' ? 'selected' : ''}>Команда</option>
                    <option value="cancelled" ${reg.status === 'cancelled' ? 'selected' : ''}>Отказ</option>
                </select>
                <button class="btn btn-xs btn-outline gap-1" onclick="event.stopPropagation(); openPlacementModal('${reg.id}')">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                    Заселить
                </button>
                <button class="btn btn-xs btn-ghost gap-1" onclick="event.stopPropagation(); openEditRegModal('${reg.id}')">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Изменить
                </button>
            </div>
        `;

        return `
            <div class="retreat-card border rounded-lg p-3 expanded" onclick="this.classList.toggle('expanded')">
                <div class="flex items-center justify-between">
                    <div class="flex-1 min-w-0">
                        <div class="font-medium">${retreat ? Layout.getName(retreat) : '—'}${regDateStr}</div>
                        ${retreat ? `<div class="text-sm opacity-60">${formatDate(retreat.start_date)} — ${formatDate(retreat.end_date)}</div>` : ''}
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="badge ${statusClass}">${statusLabel}</span>
                        <svg class="chevron w-4 h-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                    </div>
                </div>
                <div class="details">${detailsHtml}${actionsHtml}</div>
            </div>
        `;
    }).join('');
}

// ==================== PHOTO ====================

function onAvatarClick() {
    if (isEditMode) {
        document.getElementById('photoInput').click();
    } else if (person?.photo_url) {
        Layout.openPhotoModal(person.photo_url);
    }
}

async function deletePhoto() {
    if (!person || !person.photo_url) return;
    const confirmed = await ModalUtils.confirm(t('confirm_delete_photo') || 'Удалить фото?');
    if (!confirmed) return;

    try {
        if (person.photo_url.includes('vaishnava-photos')) {
            const oldPath = person.photo_url.split('/vaishnava-photos/')[1];
            if (oldPath) {
                await Layout.db.storage.from('vaishnava-photos').remove([oldPath]);
            }
        }

        await Layout.db.from('vaishnavas').update({ photo_url: null }).eq('id', person.id);
        person.photo_url = null;
        renderPerson();
    } catch (err) {
        console.error('Delete photo error:', err);
        Layout.showNotification(t('error_deleting'), 'error');
    }
}

let cropper = null;

function uploadPhoto(input) {
    const file = input.files?.[0];
    if (!file || !person) return;

    if (file.size > 10 * 1024 * 1024) {
        Layout.showNotification(t('file_too_large') || 'Файл слишком большой', 'warning');
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const cropImage = document.getElementById('cropImage');
        cropImage.src = e.target.result;

        if (cropper) { cropper.destroy(); cropper = null; }

        document.getElementById('cropModal').showModal();

        cropImage.onload = function() {
            cropper = new Cropper(cropImage, {
                aspectRatio: 1,
                viewMode: 2,
                dragMode: 'move',
                autoCropArea: 0.9,
                restore: false,
                guides: true,
                center: true,
                highlight: false,
                cropBoxMovable: true,
                cropBoxResizable: false,
                toggleDragModeOnDblclick: false,
                preview: '#cropPreview',
                ready: () => document.getElementById('zoomRange').value = 1,
                zoom: (e) => {
                    if (e.detail.ratio > 3) { e.preventDefault(); cropper.zoomTo(3); }
                    if (e.detail.ratio < 0.1) { e.preventDefault(); cropper.zoomTo(0.1); }
                    document.getElementById('zoomRange').value = e.detail.ratio;
                }
            });
        };
    };
    reader.readAsDataURL(file);
    input.value = '';
}

function handleZoomRange(value) {
    if (cropper) cropper.zoomTo(parseFloat(value));
}

function closeCropModal() {
    document.getElementById('cropModal').close();
    if (cropper) { cropper.destroy(); cropper = null; }
}

async function saveCroppedPhoto() {
    if (!cropper || !person) return;

    const wrapper = document.querySelector('.avatar-wrapper');
    const overlay = document.getElementById('avatarOverlay');

    const canvas = cropper.getCroppedCanvas({ width: 300, height: 300, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });

    closeCropModal();

    wrapper.classList.add('avatar-uploading');
    overlay.innerHTML = '<span class="loading loading-spinner loading-md text-white"></span>';

    try {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        const fileName = `${person.id}_${Date.now()}.jpg`;

        if (person.photo_url && person.photo_url.includes('vaishnava-photos')) {
            const oldPath = person.photo_url.split('/vaishnava-photos/')[1];
            if (oldPath) await Layout.db.storage.from('vaishnava-photos').remove([oldPath]);
        }

        const { error: uploadError } = await Layout.db.storage
            .from('vaishnava-photos')
            .upload(fileName, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = Layout.db.storage.from('vaishnava-photos').getPublicUrl(fileName);

        await Layout.db.from('vaishnavas').update({ photo_url: publicUrl }).eq('id', person.id);

        person.photo_url = publicUrl;
        renderPerson();

    } catch (err) {
        console.error('Upload error:', err);
        Layout.showNotification(t('upload_error') || 'Ошибка загрузки', 'error');
    } finally {
        wrapper.classList.remove('avatar-uploading');
        overlay.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" /></svg>`;
    }
}

window.onLanguageChange = function(lang) {
    populateCountriesList();
    populateDepartmentsSelect();
    renderPerson();
    renderStays();
    renderRegistrations();
    Layout.updateAllTranslations();
};

init();
