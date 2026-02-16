// Профиль вайшнава
// Управление данными персоны, периодами проживания, регистрациями на ретриты

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
let person = null;
let stays = [];
let registrations = [];
let children = [];
let departments = [];
let teamMembers = [];
let spiritualTeachers = [];
let buildings = [];
let residentCategories = [];
let permanentResident = null;
let isEditMode = false;

const today = DateUtils.toISO(new Date());

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
        loadBuildingsAndRooms(),
        loadResidentCategories()
    ]);
    populateCountriesList();
    // Потом загружаем человека (renderPerson установит значения в select'ы)
    await loadPerson(personId);
    // Параллельно загружаем историю, размещение и детей
    await Promise.all([
        loadStays(personId),
        loadRegistrations(personId),
        loadPermanentResident(personId),
        loadChildren(personId)
    ]);
    Layout.hideLoader();
}

async function loadPerson(personId) {
    const { data, error } = await Layout.db
        .from('vaishnavas')
        .select('*, departments(id, name_ru, name_en, name_hi, color), senior:vaishnavas!senior_id(id, spiritual_name, first_name, last_name), parent:vaishnavas!parent_id(id, spiritual_name, first_name, last_name)')
        .eq('id', personId)
        .single();

    if (error || !data) {
        console.error('Error loading person:', error);
        window.location.href = 'index.html';
        return;
    }

    person = data;
    renderPerson();
    applyEditPermissions();
}

// Проверка прав на редактирование профиля
function canEditProfile() {
    if (!person || !window.currentUser) return false;
    const isOwnProfile = person.id === window.currentUser.vaishnava_id;
    if (isOwnProfile) {
        return window.hasPermission && window.hasPermission('edit_own_profile');
    } else {
        return window.hasPermission && window.hasPermission('edit_vaishnava');
    }
}

function applyEditPermissions() {
    // Если авторизация ещё не завершилась — ждём событие authReady
    if (!window.currentUser) {
        window.addEventListener('authReady', () => applyEditPermissions(), { once: true });
        return;
    }
    const canEdit = canEditProfile();
    const editBtn = document.getElementById('editPersonBtn');
    const deleteBtn = document.getElementById('deletePersonBtn');

    if (editBtn) editBtn.style.display = canEdit ? '' : 'none';
    // Удаление доступно только с правом edit_vaishnava (не своего профиля)
    const canDelete = window.hasPermission && window.hasPermission('edit_vaishnava');
    if (deleteBtn) deleteBtn.style.display = canDelete ? '' : 'none';
}

async function loadDepartments() {
    const [deptData, teamRes, teachersRes, knownTeachersRes] = await Promise.all([
        Cache.getOrLoad('departments', async () => {
            const { data, error } = await Layout.db.from('departments').select('*').order('sort_order');
            if (error) { console.error('Error loading departments:', error); return null; }
            return data;
        }),
        Utils.fetchAll((from, to) => Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name')
            .eq('is_team_member', true).eq('is_deleted', false).order('spiritual_name').range(from, to)),
        Utils.fetchAll((from, to) => Layout.db.from('vaishnavas').select('spiritual_teacher')
            .not('spiritual_teacher', 'is', null).eq('is_deleted', false).range(from, to)),
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
                .select('id, retreat_id, room_id, check_in, check_out, has_meals, category_id, resident_categories:category_id(id, slug, color, name_ru, name_en, name_hi), rooms(number, buildings(name_ru, name_en, name_hi))')
                .eq('vaishnava_id', personId)
                .in('retreat_id', retreatIds)
                .eq('status', 'confirmed');

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
    toggleTeamSections();
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
            badges.push(`<span class="badge badge-primary">${t('team_member')}</span>`);
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
    const visaTypes = { tourist: t('person_visa_tourist'), business: t('person_visa_business'), volunteer: t('person_visa_volunteer'), religious: t('person_visa_religious'), other: t('person_visa_other') };
    document.getElementById('viewVisaType').textContent = person.visa_type ? (visaTypes[person.visa_type] || '—') : '—';
    document.getElementById('editVisaType').value = person.visa_type || '';
    document.getElementById('viewVisaExpiry').textContent = person.visa_expiry ? formatDate(person.visa_expiry) : '—';
    document.getElementById('editVisaExpiry').value = person.visa_expiry || '';

    // Индийский телефон
    document.getElementById('viewIndianPhone').textContent = person.indian_phone ? '+91 ' + person.indian_phone : '—';
    document.getElementById('editIndianPhone').value = person.indian_phone || '';
    document.getElementById('editIndianPhoneWhatsapp').checked = person.indian_phone_whatsapp || false;
    document.getElementById('viewIndianPhoneWhatsapp').classList.toggle('hidden', !person.indian_phone_whatsapp);

    document.getElementById('teamBadgeView').textContent = person.is_team_member ? t('yes') : t('no');

    // Show/hide team-specific sections
    toggleTeamSections();

    // Notes
    document.getElementById('viewNotes').textContent = person.notes || '—';
    document.getElementById('editNotes').value = person.notes || '';

    // Parent section
    const parentSection = document.getElementById('parentSection');
    if (person.parent_id && person.parent) {
        parentSection.classList.remove('hidden');
        const parentLink = document.getElementById('parentLink');
        parentLink.textContent = getVaishnavName(person.parent);
        parentLink.href = `person.html?id=${person.parent.id}`;
    } else {
        parentSection.classList.add('hidden');
    }

    // Hide children section if this person IS a child
    document.getElementById('childrenSection').style.display = person.parent_id ? 'none' : 'block';
}

function toggleTeamSections() {
    const isTeam = person?.is_team_member || document.getElementById('editIsTeamMember')?.checked;
    const isVolunteer = registrations.some(r =>
        r.resident?.resident_categories?.slug === 'volunteer')
        || permanentResident?.resident_categories?.slug === 'volunteer';
    const showServiceFields = isTeam || isVolunteer;

    document.getElementById('staysSection').style.display = isTeam ? 'block' : 'none';
    document.getElementById('teamSection').style.display = showServiceFields ? 'block' : 'none';
    document.getElementById('teamOnlyFields').style.display = isTeam ? '' : 'none';
    document.getElementById('indiaExperienceField').style.display = showServiceFields ? 'none' : 'block';
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
            return `<option value="${m.id}">${getVaishnavName(m)}</option>`;
        }).join('');
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
        `<div class="px-3 py-2 hover:bg-base-200 cursor-pointer" data-action="select-teacher" data-teacher-name="${e(t)}">${e(t)}</div>`
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

// Делегирование кликов на подсказках духовного учителя
document.getElementById('spiritualTeacherSuggestions').addEventListener('click', ev => {
    const el = ev.target.closest('[data-action="select-teacher"]');
    if (el) selectSpiritualTeacher(el.dataset.teacherName);
});

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
    const date = DateUtils.parseDate(dateStr);
    return date.toLocaleDateString(Layout.currentLang === 'hi' ? 'hi-IN' : Layout.currentLang === 'en' ? 'en-US' : 'ru-RU', {
        day: 'numeric', month: 'short', year: 'numeric'
    });
}

function formatFlightDateTime(datetime, fallbackNotes) {
    if (!datetime) return fallbackNotes || '';
    // БД хранит локальное время как UTC в TIMESTAMPTZ — убираем таймзону
    const date = new Date(datetime.slice(0, 16));
    const day = date.getDate();
    const month = DateUtils.monthNamesShort.ru[date.getMonth()];
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
    if (!canEditProfile()) {
        Layout.showNotification(t('no_permission'), 'error');
        return;
    }
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
        Layout.showNotification(t('name_or_spiritual_required'), 'warning');
        if (saveBtn) saveBtn.classList.remove('loading');
        return;
    }

    const { data, error } = await Layout.db
        .from('vaishnavas')
        .update(updateData)
        .eq('id', person.id)
        .select('*, departments(id, name_ru, name_en, name_hi, color), senior:vaishnavas!senior_id(id, spiritual_name, first_name, last_name), parent:vaishnavas!parent_id(id, spiritual_name, first_name, last_name)')
        .single();

    if (saveBtn) saveBtn.classList.remove('loading');

    if (error) {
        console.error('Error saving:', error);
        Layout.showNotification(t('error_saving'), 'error');
        return;
    }

    person = data;
    isEditMode = false;
    document.getElementById('profileContainer').classList.remove('edit-mode');
    document.getElementById('profileContainer').classList.add('view-mode');
    renderPerson();
}

async function deletePerson() {
    // Удаление требует права edit_vaishnava
    if (!window.hasPermission || !window.hasPermission('edit_vaishnava')) {
        Layout.showNotification(t('no_permission'), 'error');
        return;
    }

    const confirmed = await ModalUtils.confirm(t('confirm_delete'));
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
    // Делегирование кликов в списке периодов проживания
    if (!container._delegated) {
        container._delegated = true;
        container.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action="open-stay-modal"]');
            if (el) openStayModal(el.dataset.id);
        });
    }

    container.innerHTML = stays.map(stay => {
        const isCurrent = stay.start_date <= today && stay.end_date >= today;
        const isFuture = stay.start_date > today;
        const isPermanent = stay.end_date >= '2099-01-01';

        let stayClass = 'stay-card';
        if (isCurrent) stayClass += ' stay-current';
        else if (isFuture) stayClass += ' stay-future';
        else stayClass += ' stay-past';

        const dateDisplay = isPermanent
            ? t('person_at_srsk')
            : `${formatDate(stay.start_date)} — ${formatDate(stay.end_date)}`;

        return `
            <div class="${stayClass} border rounded-lg p-3 cursor-pointer hover:shadow-md transition-shadow" data-action="open-stay-modal" data-id="${stay.id}">
                <div class="flex items-center justify-between">
                    <div>
                        <div class="font-medium">${dateDisplay}</div>
                        ${stay.comment ? `<div class="text-sm opacity-60 mt-1">${stay.comment}</div>` : ''}
                    </div>
                    ${isCurrent ? `<span class="badge badge-success badge-sm">${t('here_now')}</span>` : ''}
                    ${isFuture ? `<span class="badge badge-info badge-sm">${t('planned')}</span>` : ''}
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
            form.querySelector('[name="early_checkin"]').checked = stay.early_checkin || false;
            form.querySelector('[name="late_checkout"]').checked = stay.late_checkout || false;
        }
        document.getElementById('stayModalTitle').textContent = t('edit_stay');
        document.querySelectorAll('.edit-stay-only').forEach(el => el.classList.remove('hidden'));
    } else {
        document.getElementById('stayModalTitle').textContent = t('add_stay');
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
        early_checkin: form.early_checkin.checked,
        late_checkout: form.late_checkout.checked,
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
    const confirmed = await ModalUtils.confirm(t('confirm_delete'));
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
    const today = DateUtils.toISO(new Date());

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
    select.innerHTML = '<option value="">' + t('select_retreat') + '</option>';
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
        Layout.showNotification(t('select_retreat'), 'warning');
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
        Layout.showNotification(t('error_saving') + ': ' + error.message, 'error');
        return;
    }

    closeAddRetreatModal();
    await loadRegistrations(person.id);
}

// ==================== BUILDINGS & ROOMS ====================

async function loadBuildingsAndRooms() {
    buildings = await Cache.getOrLoad('buildings_with_rooms', async () => {
        const { data, error } = await Layout.db
            .from('buildings')
            .select('*, rooms(*)')
            .eq('is_active', true)
            .order('sort_order');
        if (error) { console.error('Error loading buildings:', error); return null; }
        return data;
    }, 3600000) || [];
}

async function loadResidentCategories() {
    residentCategories = await Cache.getOrLoad('resident_categories', async () => {
        const { data, error } = await Layout.db
            .from('resident_categories')
            .select('id, slug, name_ru, name_en, name_hi, color, sort_order')
            .lt('sort_order', 999)
            .order('sort_order');
        if (error) { console.error('Error loading categories:', error); return []; }
        return data || [];
    }, 5 * 60 * 1000);
}

// ==================== PERMANENT RESIDENT ====================

async function loadPermanentResident(personId) {
    const { data } = await Layout.db
        .from('residents')
        .select('id, room_id, category_id, check_in, check_out, has_meals, resident_categories:category_id(id, slug, color, name_ru, name_en, name_hi), rooms(number, buildings(name_ru, name_en, name_hi))')
        .eq('vaishnava_id', personId)
        .is('retreat_id', null)
        .eq('status', 'confirmed')
        .maybeSingle();

    permanentResident = data || null;
    renderPermanentResident();
    toggleTeamSections();
}

function renderPermanentResident() {
    const section = document.getElementById('currentAccommodationSection');
    const content = document.getElementById('currentAccommodationContent');
    if (!section || !content) return;

    if (!permanentResident) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    const res = permanentResident;
    const cat = res.resident_categories;
    const roomInfo = res.rooms
        ? `${res.rooms.buildings ? Layout.getName(res.rooms.buildings) + ', ' : ''}${res.rooms.number}`
        : t('self_accommodation');

    const catOptionsHtml = residentCategories.map(c =>
        `<option value="${c.id}" ${c.id === res.category_id ? 'selected' : ''}>${Layout.getName(c)}</option>`
    ).join('');

    const isPermanent = res.check_out >= '2099-01-01';

    content.innerHTML = `
        <div class="flex flex-col gap-3">
            <div class="flex items-center gap-2">
                <span class="opacity-60 text-sm">${t('person_room')}:</span>
                <span class="font-medium ${res.room_id ? 'text-success' : 'text-error'}">${roomInfo}</span>
            </div>
            <div class="grid grid-cols-2 gap-3">
                <div>
                    <span class="opacity-60 text-xs">${t('person_check_in')}</span>
                    <input type="date" class="input input-bordered input-sm w-full" id="permResCheckIn" value="${res.check_in || ''}" onchange="savePermanentResidentDates()" />
                </div>
                <div>
                    <span class="opacity-60 text-xs">${t('person_check_out')}</span>
                    <div class="flex items-center gap-2">
                        <input type="date" class="input input-bordered input-sm flex-1" id="permResCheckOut" value="${isPermanent ? '' : (res.check_out || '')}" ${isPermanent ? 'disabled' : ''} onchange="savePermanentResidentDates()" />
                        <label class="flex items-center gap-1 cursor-pointer whitespace-nowrap">
                            <input type="checkbox" class="checkbox checkbox-xs" id="permResPermanent" ${isPermanent ? 'checked' : ''} onchange="togglePermanentResidentCheckout(this.checked)" />
                            <span class="text-xs opacity-60">${t('person_permanent')}</span>
                        </label>
                    </div>
                </div>
            </div>
            <div class="flex items-center gap-2">
                <span class="opacity-60 text-sm" data-i18n="category">${t('category')}</span>
                ${cat ? `<span class="badge badge-sm" style="background-color: ${cat.color}20; color: ${cat.color}; border-color: ${cat.color}">${Layout.getName(cat)}</span>` : ''}
                <select class="select select-xs select-bordered" id="permanentResidentCategory" onchange="changePermanentResidentCategory(this.value)">
                    ${catOptionsHtml}
                </select>
            </div>
            <div class="flex items-center gap-2">
                <span class="opacity-60 text-sm">${t('meal_type')}</span>
                <label class="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" class="checkbox checkbox-sm checkbox-success" id="permResMeals" ${res.has_meals ? 'checked' : ''} onchange="changePermanentResidentMeals(this.checked)" />
                    <span class="text-sm">${t('meal_type_prasad')}</span>
                </label>
            </div>
        </div>
    `;
}

function togglePermanentResidentCheckout(isPermanent) {
    const checkOutInput = document.getElementById('permResCheckOut');
    if (isPermanent) {
        checkOutInput.value = '';
        checkOutInput.disabled = true;
    } else {
        checkOutInput.disabled = false;
        checkOutInput.focus();
    }
    savePermanentResidentDates();
}

async function savePermanentResidentDates() {
    if (!permanentResident?.id) return;

    const checkIn = document.getElementById('permResCheckIn').value || null;
    const isPermanent = document.getElementById('permResPermanent').checked;
    const checkOut = isPermanent ? '2099-12-31' : (document.getElementById('permResCheckOut').value || null);

    if (!checkIn) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ check_in: checkIn, check_out: checkOut })
            .eq('id', permanentResident.id);
        if (error) throw error;

        permanentResident.check_in = checkIn;
        permanentResident.check_out = checkOut;
    } catch (err) {
        console.error('Error saving dates:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

async function changePermanentResidentCategory(categoryId) {
    if (!permanentResident?.id || !categoryId) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ category_id: categoryId })
            .eq('id', permanentResident.id);
        if (error) throw error;

        await loadPermanentResident(person.id);
    } catch (err) {
        console.error('Error changing category:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

async function changePermanentResidentMeals(hasMeals) {
    if (!permanentResident?.id) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ has_meals: hasMeals })
            .eq('id', permanentResident.id);
        if (error) throw error;

        permanentResident.has_meals = hasMeals;
    } catch (err) {
        console.error('Error changing meals:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
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

async function changeResidentDate(residentId, field, value) {
    if (!residentId || !field || !value) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ [field]: value })
            .eq('id', residentId);
        if (error) throw error;

        // Обновить локальные данные без полной перезагрузки
        for (const reg of registrations) {
            if (reg.resident?.id === residentId) {
                reg.resident[field] = value;
                break;
            }
        }
    } catch (err) {
        console.error('Error saving date:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

async function changeResidentCategory(residentId, categoryId) {
    if (!residentId || !categoryId) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ category_id: categoryId })
            .eq('id', residentId);
        if (error) throw error;

        await loadRegistrations(person.id);
    } catch (err) {
        console.error('Error changing category:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

async function changeResidentMeals(residentId, hasMeals) {
    if (!residentId) return;

    try {
        const { error } = await Layout.db
            .from('residents')
            .update({ has_meals: hasMeals })
            .eq('id', residentId);
        if (error) throw error;

        // Обновить локальные данные без полной перезагрузки
        for (const reg of registrations) {
            if (reg.resident?.id === residentId) {
                reg.resident.has_meals = hasMeals;
                break;
            }
        }
    } catch (err) {
        console.error('Error changing meals:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

// ==================== EDIT REGISTRATION ====================

function toggleDirectArrival(checked) {
    document.getElementById('customArrivalBlock').classList.toggle('hidden', checked);
    document.getElementById('calcArrivalBlock').classList.toggle('hidden', !checked);
    if (checked) updateCalcArrival();
}
function toggleDirectDeparture(checked) {
    document.getElementById('customDepartureBlock').classList.toggle('hidden', checked);
    document.getElementById('calcDepartureBlock').classList.toggle('hidden', !checked);
    if (checked) updateCalcDeparture();
}

// Сдвигает datetime значение на N часов (локальное время).
// .slice(0,16) убирает таймзону из TIMESTAMPTZ, т.к. БД хранит локальное время как UTC.
function addHoursToDatetime(datetimeStr, hours) {
    if (!datetimeStr) return null;
    const d = new Date(datetimeStr.slice(0, 16));
    d.setHours(d.getHours() + hours);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Форматирует datetime в читаемый вид: "12 фев, 14:30"
// .slice(0,16) убирает таймзону из TIMESTAMPTZ.
function formatDatetimeShort(datetimeStr) {
    if (!datetimeStr) return '—';
    const d = new Date(datetimeStr.slice(0, 16));
    const months = DateUtils.monthNamesShort.ru;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Пересчитать расчётное время приезда (рейс + 4ч)
function updateCalcArrival() {
    const flightVal = document.getElementById('editArrivalDatetime').value;
    const calc = addHoursToDatetime(flightVal, 4);
    document.getElementById('calcArrivalTime').textContent = formatDatetimeShort(calc);
}

// Пересчитать расчётное время отъезда (рейс − 7ч)
function updateCalcDeparture() {
    const flightVal = document.getElementById('editDepartureDatetime').value;
    const calc = addHoursToDatetime(flightVal, -7);
    document.getElementById('calcDepartureTime').textContent = formatDatetimeShort(calc);
}

let currentEditRegId = null;

function openEditRegModal(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    currentEditRegId = registrationId;
    document.getElementById('editRegId').value = registrationId;
    document.getElementById('editRegPersonName').textContent = person ? getVaishnavName(person) : '';

    // Статус
    document.getElementById('editRegStatus').value = reg.status || 'guest';

    // Питание
    document.getElementById('editMealType').value = reg.meal_type || '';

    // Трансферы
    const transfers = reg.guest_transfers || [];
    const arrival = transfers.find(t => t.direction === 'arrival');
    const departure = transfers.find(t => t.direction === 'departure');
    const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
    const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

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

    // Прямой приезд/отъезд
    document.getElementById('editDirectArrival').checked = reg.direct_arrival !== false;
    toggleDirectArrival(reg.direct_arrival !== false);
    document.getElementById('editArrivalAtAshram').value = reg.arrival_datetime ? reg.arrival_datetime.slice(0, 16) : '';
    document.getElementById('editArrivalRetreatTransfer').value = arrivalRetreat?.needs_transfer || '';
    document.getElementById('editDirectDeparture').checked = reg.direct_departure !== false;
    toggleDirectDeparture(reg.direct_departure !== false);
    document.getElementById('editDepartureFromAshram').value = reg.departure_datetime ? reg.departure_datetime.slice(0, 16) : '';
    document.getElementById('editDepartureRetreatTransfer').value = departureRetreat?.needs_transfer || '';

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
        const directArrival = document.getElementById('editDirectArrival').checked;
        const directDeparture = document.getElementById('editDirectDeparture').checked;

        const regData = {
            status: document.getElementById('editRegStatus').value,
            meal_type: document.getElementById('editMealType').value || null,
            direct_arrival: directArrival,
            direct_departure: directDeparture,
            arrival_datetime: directArrival
                ? addHoursToDatetime(document.getElementById('editArrivalDatetime').value, 4)
                : (document.getElementById('editArrivalAtAshram').value || null),
            departure_datetime: directDeparture
                ? addHoursToDatetime(document.getElementById('editDepartureDatetime').value, -7)
                : (document.getElementById('editDepartureFromAshram').value || null),
            accommodation_wishes: document.getElementById('editAccommodationWishes').value || null,
            companions: document.getElementById('editCompanions').value || null,
            extended_stay: document.getElementById('editExtendedStay').value || null,
            payment_notes: document.getElementById('editPaymentNotes').value || null,
            org_notes: document.getElementById('editOrgNotes').value || null,
            guest_questions: document.getElementById('editGuestQuestions').value || null
        };

        // Автоперенос дат в другой ретрит или предупреждение
        const retreat = reg.retreats;
        const origArrival = regData.arrival_datetime;
        const origDeparture = regData.departure_datetime;
        if (retreat) {
            const moveResult = await Utils.checkAndMoveDatesAcrossRetreats({
                db: Layout.db, registrationId: regId, vaishnavId: reg.vaishnava_id,
                retreat, arrivalDatetime: regData.arrival_datetime, departureDatetime: regData.departure_datetime
            });
            if (moveResult.warnings.length && !confirm(moveResult.warnings.join('\n') + '\n\n' + t('person_save_anyway'))) return;
            if (moveResult.clearedDeparture) regData.departure_datetime = null;
            if (moveResult.clearedArrival) regData.arrival_datetime = null;
            moveResult.notifications.forEach(n => Layout.showNotification(n, 'info'));
        }

        const { error: regError } = await Layout.db
            .from('retreat_registrations')
            .update(regData)
            .eq('id', regId);

        if (regError) throw regError;

        // Синхронизируем residents.check_in/check_out (по оригинальным датам — физический выезд не меняется)
        if (reg.resident?.id) {
            const resUpdate = {};
            if (origArrival) resUpdate.check_in = origArrival.slice(0, 10);
            if (origDeparture) resUpdate.check_out = origDeparture.slice(0, 10);
            if (Object.keys(resUpdate).length > 0) {
                await Layout.db.from('residents').update(resUpdate).eq('id', reg.resident.id);
            }
        }

        // Обновляем/создаём трансферы
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');
        const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
        const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

        // Прилёт (аэропорт)
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

        // Трансфер приезд на ретрит (если не сразу из аэропорта)
        if (!directArrival) {
            const arrivalRetreatData = {
                registration_id: regId,
                direction: 'arrival_retreat',
                flight_datetime: document.getElementById('editArrivalAtAshram').value || null,
                needs_transfer: document.getElementById('editArrivalRetreatTransfer').value || null
            };
            if (arrivalRetreat) {
                await Layout.db.from('guest_transfers').update(arrivalRetreatData).eq('id', arrivalRetreat.id);
            } else if (arrivalRetreatData.flight_datetime || arrivalRetreatData.needs_transfer) {
                await Layout.db.from('guest_transfers').insert(arrivalRetreatData);
            }
        } else if (arrivalRetreat) {
            // Переключили на "сразу на ретрит" — удаляем запись arrival_retreat
            await Layout.db.from('guest_transfers').delete().eq('id', arrivalRetreat.id);
        }

        // Вылет (аэропорт)
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

        // Трансфер отъезд с ретрита (если не сразу в аэропорт)
        if (!directDeparture) {
            const departureRetreatData = {
                registration_id: regId,
                direction: 'departure_retreat',
                flight_datetime: document.getElementById('editDepartureFromAshram').value || null,
                needs_transfer: document.getElementById('editDepartureRetreatTransfer').value || null
            };
            if (departureRetreat) {
                await Layout.db.from('guest_transfers').update(departureRetreatData).eq('id', departureRetreat.id);
            } else if (departureRetreatData.flight_datetime || departureRetreatData.needs_transfer) {
                await Layout.db.from('guest_transfers').insert(departureRetreatData);
            }
        } else if (departureRetreat) {
            // Переключили на "сразу в аэропорт" — удаляем запись departure_retreat
            await Layout.db.from('guest_transfers').delete().eq('id', departureRetreat.id);
        }

        // Перезагружаем данные
        await loadRegistrations(person.id);
        renderRegistrations();

        editRegModal.close();
    } catch (err) {
        console.error('Error saving registration:', err);
        Layout.showNotification(t('error_saving') + ': ' + err.message, 'error');
    }
}

async function deleteRegistration(registrationId) {
    const reg = registrations.find(r => r.id === registrationId);
    if (!reg) return;

    const retreat = reg.retreats;
    const retreatName = retreat ? Layout.getName(retreat) : t('person_retreat_fallback');
    if (!confirm(t('person_confirm_delete_registration') + ` «${retreatName}»?`)) return;

    try {
        // Удалить трансферы
        await Layout.db.from('guest_transfers').delete().eq('registration_id', registrationId);
        // Удалить размещение
        await Layout.db.from('residents').delete().eq('vaishnava_id', person.id).eq('retreat_id', reg.retreat_id);
        // Удалить регистрацию
        const { error } = await Layout.db.from('retreat_registrations').delete().eq('id', registrationId);
        if (error) throw error;

        await loadRegistrations(person.id);
        renderRegistrations();
        Layout.showNotification(t('person_registration_deleted'), 'success');
    } catch (err) {
        console.error('Error deleting registration:', err);
        Layout.showNotification(t('error_deleting') + ': ' + err.message, 'error');
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

    // Даты заезда/выезда: arrival/departure → рейс → ретрит
    const arrivalFlight = (reg.guest_transfers || []).find(t => t.direction === 'arrival');
    const departureFlight = (reg.guest_transfers || []).find(t => t.direction === 'departure');

    const checkIn = reg.arrival_datetime?.slice(0, 10)
        || arrivalFlight?.flight_datetime?.slice(0, 10)
        || retreat?.start_date || '';
    const checkOut = reg.departure_datetime?.slice(0, 10)
        || departureFlight?.flight_datetime?.slice(0, 10)
        || retreat?.end_date || '';

    document.getElementById('placementCheckIn').value = checkIn;
    document.getElementById('placementCheckOut').value = checkOut;

    modal.showModal();
    updateRoomsList();
}

async function updateRoomsList() {
    const roomsList = document.getElementById('roomsList');
    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    if (!checkIn || !checkOut) {
        roomsList.innerHTML = '<div class="text-center py-4 opacity-50">' + t('person_specify_dates') + '</div>';
        return;
    }

    roomsList.innerHTML = '<div class="text-center py-4"><span class="loading loading-spinner"></span></div>';

    // Load occupancy for the date range from multiple sources
    const [residentsRes, accommodationsRes] = await Promise.all([
        // Заселённые гости (residents)
        Layout.db.from('residents')
            .select('room_id')
            .eq('status', 'confirmed')
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
        // Временные без дат — доступны всегда
        if (!b.available_from && !b.available_until) return true;
        // Временные с датами — только если период аренды пересекается с датами заезда/выезда
        return b.available_from <= checkOut && b.available_until >= checkIn;
    });

    // Опция "Самостоятельное размещение"
    let html = `
        <div class="mb-3">
            <button type="button" class="btn btn-outline btn-error w-full gap-2" data-action="select-self-accommodation">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                </svg>
                ${t('self_accommodation')}
            </button>
            <div class="text-xs opacity-50 text-center mt-1">${t('person_guest_outside')}</div>
        </div>
    `;

    if (availableBuildings.length === 0) {
        roomsList.innerHTML = html + '<div class="text-center py-4 opacity-50">' + t('person_no_buildings') + '</div>';
        return;
    }
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
                ${disabled ? 'disabled' : `data-action="select-room" data-id="${room.id}" data-building-id="${building.id}"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html || '<div class="text-center py-4 opacity-50">' + t('person_no_rooms') + '</div>';

    // Делегирование кликов в списке комнат
    if (!roomsList._delegated) {
        roomsList._delegated = true;
        roomsList.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            switch (btn.dataset.action) {
                case 'select-room': selectRoom(btn.dataset.id, btn.dataset.buildingId); break;
                case 'select-self-accommodation': selectSelfAccommodation(); break;
            }
        });
    }
}

async function selectRoom(roomId, buildingId) {
    const building = buildings.find(b => b.id === buildingId);
    const room = building?.rooms?.find(r => r.id === roomId);
    if (!room) return;

    const reg = registrations.find(r => r.id === currentPlacementRegId);
    if (!reg) return;

    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    const data = {
        vaishnava_id: person.id,
        retreat_id: reg.retreat_id,
        room_id: roomId,
        check_in: checkIn || null,
        check_out: checkOut || null,
        status: 'confirmed'
    };

    try {
        // Check if resident already exists for this person and retreat
        const { data: existing } = await Layout.db
            .from('residents')
            .select('id')
            .eq('vaishnava_id', person.id)
            .eq('retreat_id', reg.retreat_id)
            .maybeSingle();

        if (existing) {
            const { error } = await Layout.db
                .from('residents')
                .update(data)
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await Layout.db
                .from('residents')
                .insert(data);
            if (error) throw error;
        }

        document.getElementById('placementModal').close();
        await loadRegistrations(person.id);
        Layout.showNotification(t('person_placement_saved'), 'success');
    } catch (err) {
        console.error('Error saving placement:', err);
        Layout.showNotification(t('placement_error') + ': ' + err.message, 'error');
    }
}

async function selectSelfAccommodation() {
    const reg = registrations.find(r => r.id === currentPlacementRegId);
    if (!reg) return;

    const checkIn = document.getElementById('placementCheckIn').value;
    const checkOut = document.getElementById('placementCheckOut').value;

    const data = {
        vaishnava_id: person.id,
        retreat_id: reg.retreat_id,
        room_id: null, // NULL означает самостоятельное размещение
        check_in: checkIn || null,
        check_out: checkOut || null,
        status: 'confirmed'
    };

    try {
        // Check if resident already exists for this person and retreat
        const { data: existing } = await Layout.db
            .from('residents')
            .select('id')
            .eq('vaishnava_id', person.id)
            .eq('retreat_id', reg.retreat_id)
            .maybeSingle();

        if (existing) {
            const { error } = await Layout.db
                .from('residents')
                .update(data)
                .eq('id', existing.id);
            if (error) throw error;
        } else {
            const { error } = await Layout.db
                .from('residents')
                .insert(data);
            if (error) throw error;
        }

        document.getElementById('placementModal').close();
        await loadRegistrations(person.id);
        Layout.showNotification(t('person_self_accommodation_saved'), 'success');
    } catch (err) {
        console.error('Error saving self accommodation:', err);
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

    // Делегирование кликов и change-событий в списке ретритных регистраций
    if (!container._delegated) {
        container._delegated = true;
        container.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            ev.stopPropagation();
            const id = btn.dataset.id;
            switch (btn.dataset.action) {
                case 'toggle-expanded': btn.classList.toggle('expanded'); break;
                case 'open-placement-modal': openPlacementModal(id); break;
                case 'open-edit-reg-modal': openEditRegModal(id); break;
                case 'delete-registration': deleteRegistration(id); break;
            }
        });
        container.addEventListener('change', ev => {
            const target = ev.target.closest('[data-action]');
            if (!target) return;
            ev.stopPropagation();
            if (target.dataset.action === 'update-registration-status') {
                updateRegistrationStatus(target.dataset.id, target.value, target);
            } else if (target.dataset.action === 'change-category') {
                changeResidentCategory(target.dataset.residentId, target.value);
            } else if (target.dataset.action === 'change-resident-dates') {
                changeResidentDate(target.dataset.residentId, target.dataset.field, target.value);
            } else if (target.dataset.action === 'change-meals') {
                changeResidentMeals(target.dataset.residentId, target.checked);
            }
        });
    }

    container.innerHTML = registrations.map(reg => {
        const retreat = reg.retreats;
        const statusClass = `status-${reg.status}`;
        const statusLabel = t(`status_${reg.status}`) || reg.status;
        const transfers = reg.guest_transfers || [];
        const arrival = transfers.find(t => t.direction === 'arrival');
        const departure = transfers.find(t => t.direction === 'departure');
        const arrivalRetreat = transfers.find(t => t.direction === 'arrival_retreat');
        const departureRetreat = transfers.find(t => t.direction === 'departure_retreat');

        // Check if there's any detail to show
        const hasDetails = arrival || departure || arrivalRetreat || departureRetreat || reg.arrival_datetime || reg.departure_datetime || reg.resident || reg.guest_accommodations?.[0] || reg.accommodation_wishes || reg.companions || reg.payment_notes || reg.org_notes || reg.extended_stay || reg.guest_questions;

        // Build details HTML
        let detailsHtml = '';

        if (arrival) {
            const arrivalTime = formatFlightDateTime(arrival.flight_datetime, arrival.notes);
            const ashramArrival = reg.arrival_datetime
                ? formatDatetimeShort(reg.arrival_datetime)
                : (arrival.flight_datetime ? formatDatetimeShort(addHoursToDatetime(arrival.flight_datetime, 4)) : null);
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">✈️ ${t('person_arrival')}</div>
                    <div class="text-sm space-y-1">
                        ${arrivalTime ? `<div><span class="opacity-60">${t('person_flight')}:</span> ${arrivalTime}${arrival.flight_number ? ` (${arrival.flight_number})` : ''}</div>` : ''}
                        ${ashramArrival ? `<div><span class="opacity-60">${t('person_arrival_at_srsk')}:</span> ${ashramArrival}</div>` : ''}
                        <div><span class="opacity-60">${t('person_transfer')}:</span> ${arrival.needs_transfer === 'yes' ? '✅ ' + t('person_transfer_needed') : arrival.needs_transfer === 'no' ? '❌ ' + t('person_transfer_not_needed') : arrival.needs_transfer || '—'}</div>
                    </div>
                </div>
            `;
        }

        if (arrivalRetreat) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🚐 ${t('person_transfer_to_retreat')}</div>
                    <div class="text-sm space-y-1">
                        ${arrivalRetreat.flight_datetime ? `<div><span class="opacity-60">${t('person_arrival_short')}:</span> ${formatDatetimeShort(arrivalRetreat.flight_datetime)}</div>` : ''}
                        <div><span class="opacity-60">${t('person_transfer')}:</span> ${arrivalRetreat.needs_transfer === 'yes' ? '✅ ' + t('person_transfer_needed') : arrivalRetreat.needs_transfer === 'no' ? '❌ ' + t('person_transfer_not_needed') : '—'}</div>
                    </div>
                </div>
            `;
        }

        if (departure) {
            const departureTime = formatFlightDateTime(departure.flight_datetime, departure.notes);
            const ashramDeparture = reg.departure_datetime
                ? formatDatetimeShort(reg.departure_datetime)
                : (departure.flight_datetime ? formatDatetimeShort(addHoursToDatetime(departure.flight_datetime, -7)) : null);
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">✈️ ${t('person_departure')}</div>
                    <div class="text-sm space-y-1">
                        ${departureTime ? `<div><span class="opacity-60">${t('person_flight')}:</span> ${departureTime}${departure.flight_number ? ` (${departure.flight_number})` : ''}</div>` : ''}
                        ${ashramDeparture ? `<div><span class="opacity-60">${t('person_departure_from_srsk')}:</span> ${ashramDeparture}</div>` : ''}
                        <div><span class="opacity-60">${t('person_transfer')}:</span> ${departure.needs_transfer === 'yes' ? '✅ ' + t('person_transfer_needed') : departure.needs_transfer === 'no' ? '❌ ' + t('person_transfer_not_needed') : departure.needs_transfer || '—'}</div>
                    </div>
                </div>
            `;
        }

        if (departureRetreat) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🚐 ${t('person_transfer_from_retreat')}</div>
                    <div class="text-sm space-y-1">
                        ${departureRetreat.flight_datetime ? `<div><span class="opacity-60">${t('person_departure_short')}:</span> ${formatDatetimeShort(departureRetreat.flight_datetime)}</div>` : ''}
                        <div><span class="opacity-60">${t('person_transfer')}:</span> ${departureRetreat.needs_transfer === 'yes' ? '✅ ' + t('person_transfer_needed') : departureRetreat.needs_transfer === 'no' ? '❌ ' + t('person_transfer_not_needed') : '—'}</div>
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
                        <div class="detail-label">🏠 ${t('person_accommodation')}</div>
                        <div class="text-sm font-medium text-error bg-error/20 px-2 py-1 rounded inline-block">${t('self_accommodation')}</div>
                    </div>
                `;
            } else if (resident.rooms) {
                // Regular accommodation
                const buildingName = resident.rooms.buildings ? Layout.getName(resident.rooms.buildings) : '';
                const roomNumber = resident.rooms.number || '';
                detailsHtml += `
                    <div class="detail-section">
                        <div class="detail-label">🏠 ${t('person_accommodation')}</div>
                        <div class="text-sm font-medium text-success">${buildingName ? buildingName + ', ' : ''}${roomNumber}</div>
                    </div>
                `;
            }
            // Даты заезда/выезда для ретритного resident
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">📅 ${t('person_stay_dates')}</div>
                    <div class="grid grid-cols-2 gap-2" style="max-width: 320px;">
                        <div>
                            <span class="text-xs opacity-60">${t('person_check_in')}</span>
                            <input type="date" class="input input-bordered input-xs w-full" value="${resident.check_in || ''}" data-action="change-resident-dates" data-resident-id="${resident.id}" data-field="check_in" />
                        </div>
                        <div>
                            <span class="text-xs opacity-60">${t('person_check_out')}</span>
                            <input type="date" class="input input-bordered input-xs w-full" value="${resident.check_out || ''}" data-action="change-resident-dates" data-resident-id="${resident.id}" data-field="check_out" />
                        </div>
                    </div>
                </div>
            `;
        } else if (accommodation?.room_number) {
            // Legacy accommodation data
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🏠 ${t('person_accommodation')}</div>
                    <div class="text-sm font-medium text-success">${accommodation.building_name ? accommodation.building_name + ', ' : ''}${accommodation.room_number}</div>
                </div>
            `;
        }

        // Категория проживающего
        if (resident) {
            const cat = resident.resident_categories;
            const catOptionsHtml = residentCategories.map(c =>
                `<option value="${c.id}" ${c.id === resident.category_id ? 'selected' : ''}>${Layout.getName(c)}</option>`
            ).join('');
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label" data-i18n="category">${t('category')}</div>
                    <div class="flex items-center gap-2">
                        ${cat ? `<span class="badge badge-sm" style="background-color: ${cat.color}20; color: ${cat.color}; border-color: ${cat.color}">${Layout.getName(cat)}</span>` : ''}
                        <select class="select select-xs select-bordered" data-action="change-category" data-resident-id="${resident.id}">
                            ${catOptionsHtml}
                        </select>
                    </div>
                </div>
            `;
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">${t('meal_type')}</div>
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" class="checkbox checkbox-xs checkbox-success" data-action="change-meals" data-resident-id="${resident.id}" ${resident.has_meals ? 'checked' : ''} />
                        <span class="text-sm">${t('meal_type_prasad')}</span>
                    </label>
                </div>
            `;
        }

        if (reg.companions) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">👨‍👩‍👧 ${t('person_companions')}</div>
                    <div class="text-sm">${reg.companions}</div>
                </div>
            `;
        }

        if (reg.accommodation_wishes) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">🏨 ${t('person_accommodation_wishes')}</div>
                    <div class="text-sm">${reg.accommodation_wishes}</div>
                </div>
            `;
        }

        if (reg.extended_stay) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">📅 ${t('person_after_retreat')}</div>
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
                    <div class="detail-label">💳 ${t('person_payment')}</div>
                    <div class="text-sm">${e(reg.payment_notes)}</div>
                </div>
            `;
        }

        if (reg.org_notes) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">📋 ${t('person_org_notes')}</div>
                    <div class="text-sm whitespace-pre-line">${e(reg.org_notes)}</div>
                </div>
            `;
        }

        if (reg.guest_questions) {
            detailsHtml += `
                <div class="detail-section">
                    <div class="detail-label">❓ ${t('person_questions')}</div>
                    <div class="text-sm whitespace-pre-line">${e(reg.guest_questions)}</div>
                </div>
            `;
        }

        const regDateStr = reg.registration_date ? `<span class="text-xs opacity-40 ml-2">${t('person_registered_short')} ${formatDate(reg.registration_date)}</span>` : '';

        // Actions section
        const actionsHtml = `
            <div class="detail-section border-t pt-3 mt-3 flex items-center gap-3 flex-wrap">
                <select class="select select-xs status-${reg.status}" style="min-width: 0; padding-right: 1.5rem;" data-action="update-registration-status" data-id="${reg.id}">
                    <option value="guest" ${reg.status === 'guest' ? 'selected' : ''}>${t('status_guest')}</option>
                    <option value="team" ${reg.status === 'team' ? 'selected' : ''}>${t('status_team')}</option>
                    <option value="cancelled" ${reg.status === 'cancelled' ? 'selected' : ''}>${t('status_cancelled')}</option>
                </select>
                <button class="btn btn-xs btn-outline gap-1" data-action="open-placement-modal" data-id="${reg.id}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                    </svg>
                    ${t('person_check_in_btn')}
                </button>
                <button class="btn btn-xs btn-ghost gap-1" data-action="open-edit-reg-modal" data-id="${reg.id}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    ${t('edit')}
                </button>
                <button class="btn btn-xs btn-ghost text-error gap-1 ml-auto" data-action="delete-registration" data-id="${reg.id}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    ${t('delete')}
                </button>
            </div>
        `;

        return `
            <div class="retreat-card border rounded-lg p-3 expanded" data-action="toggle-expanded">
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

// ==================== CHILDREN ====================

async function loadChildren(personId) {
    const { data } = await Layout.db
        .from('vaishnavas')
        .select('id, first_name, last_name, spiritual_name, gender, birth_date, photo_url')
        .eq('parent_id', personId)
        .eq('is_deleted', false)
        .order('birth_date', { ascending: true });
    children = data || [];
    renderChildren();
}

function renderChildren() {
    const container = document.getElementById('childrenList');
    const emptyState = document.getElementById('emptyChildren');
    const countBadge = document.getElementById('childrenCount');

    countBadge.textContent = children.length;

    if (children.length === 0) {
        container.innerHTML = '';
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');

    if (!container._delegated) {
        container._delegated = true;
        container.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action]');
            if (!el) return;
            switch (el.dataset.action) {
                case 'open-child': window.location.href = `person.html?id=${el.dataset.id}`; break;
                case 'edit-child': openAddChildModal(el.dataset.id); break;
            }
        });
    }

    container.innerHTML = children.map(child => {
        const name = getVaishnavName(child);
        const age = child.birth_date ? DateUtils.calculateAge(child.birth_date) : null;
        const genderIcon = child.gender === 'male' ? '👦' : child.gender === 'female' ? '👧' : '👶';
        const ageStr = age !== null ? `${age} ${t('years_short')}` : '';
        const initials = (child.first_name?.[0] || '') + (child.last_name?.[0] || '');

        return `
            <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-base-200 cursor-pointer" data-action="open-child" data-id="${child.id}">
                ${child.photo_url
                    ? `<img src="${e(child.photo_url)}" class="w-10 h-10 rounded-full object-cover" alt="">`
                    : `<div class="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-sm font-medium">${initials.toUpperCase() || '?'}</div>`
                }
                <div class="flex-1 min-w-0">
                    <div class="font-medium truncate">${e(name)}</div>
                    <div class="text-xs opacity-60">${genderIcon} ${ageStr}</div>
                </div>
                <button class="btn btn-ghost btn-xs btn-circle" data-action="edit-child" data-id="${child.id}" title="${t('edit')}">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                </button>
            </div>
        `;
    }).join('');
}

function openAddChildModal(childId = null) {
    const form = document.getElementById('addChildForm');
    form.reset();
    document.getElementById('editChildId').value = '';

    if (childId) {
        const child = children.find(c => c.id === childId);
        if (child) {
            document.getElementById('editChildId').value = child.id;
            document.getElementById('childFirstName').value = child.first_name || '';
            document.getElementById('childLastName').value = child.last_name || '';
            document.getElementById('childGender').value = child.gender || '';
            document.getElementById('childBirthDate').value = child.birth_date || '';
        }
        document.getElementById('childModalTitle').textContent = t('edit_child');
    } else {
        document.getElementById('childModalTitle').textContent = t('add_child');
    }

    document.getElementById('addChildModal').showModal();
}

async function saveChild(event) {
    event.preventDefault();

    const childId = document.getElementById('editChildId').value;
    const childData = {
        first_name: document.getElementById('childFirstName').value || null,
        last_name: document.getElementById('childLastName').value || null,
        gender: document.getElementById('childGender').value || null,
        birth_date: document.getElementById('childBirthDate').value || null,
        parent_id: person.id
    };

    if (!childData.first_name) {
        Layout.showNotification(t('name_required'), 'warning');
        return;
    }

    let result;
    if (childId) {
        result = await Layout.db.from('vaishnavas').update(childData).eq('id', childId);
    } else {
        childData.is_guest = true;
        result = await Layout.db.from('vaishnavas').insert(childData);
    }

    if (result.error) {
        console.error('Error saving child:', result.error);
        Layout.showNotification(t('error_saving'), 'error');
        return;
    }

    document.getElementById('addChildModal').close();
    await loadChildren(person.id);
    Layout.showNotification(childId ? t('child_updated') : t('child_added'), 'success');
}

async function makeIndependent() {
    if (!person?.parent_id) return;

    const confirmed = confirm(t('person_confirm_make_independent'));
    if (!confirmed) return;

    const { error } = await Layout.db
        .from('vaishnavas')
        .update({ parent_id: null })
        .eq('id', person.id);

    if (error) {
        console.error('Error making independent:', error);
        Layout.showNotification(t('error_saving'), 'error');
        return;
    }

    person.parent_id = null;
    person.parent = null;
    renderPerson();
    Layout.showNotification(t('person_now_independent'), 'success');
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
    const confirmed = await ModalUtils.confirm(t('person_confirm_delete_photo'));
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
        Layout.showNotification(t('person_file_too_large'), 'warning');
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
        Layout.showNotification(t('person_upload_error'), 'error');
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
    renderChildren();
    Layout.updateAllTranslations();
};

// Делегирование кликов для секций детей и родителя
document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-action]');
    if (!el) return;
    switch (el.dataset.action) {
        case 'open-add-child-modal': openAddChildModal(); break;
        case 'make-independent': makeIndependent(); break;
    }
});

init();
