// SEARCH.JS
// Поиск человека на фото ретрита по лицу (AWS Rekognition)

// ==================== STATE ====================
let retreats = [];
let vaishnavas = [];
let selectedVaishnava = null;
let searchSelfieFile = null;
let searchResults = []; // фото найденные в результате поиска
let currentPhotoIndex = 0;

// ==================== INIT ====================
async function waitForAuth() {
    let attempts = 0;
    while (!window.currentUser && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    return !!window.currentUser;
}

async function waitForTranslations() {
    let attempts = 0;
    while ((!Layout.t || !Layout.t('selected')) && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
}

async function init() {
    Layout.showLoader();

    const authReady = await waitForAuth();
    if (!authReady) {
        alert('Ошибка загрузки данных пользователя');
        window.location.href = '../index.html';
        return;
    }

    await waitForTranslations();

    if (!window.hasPermission || !window.hasPermission('upload_photos')) {
        alert(Layout.t('no_permission') || 'Нет прав доступа');
        window.location.href = '../index.html';
        return;
    }

    await Promise.all([loadRetreats(), loadVaishnavas()]);

    // Event listeners
    document.getElementById('retreatSelect').addEventListener('change', updateFindBtnState);
    document.getElementById('vaishnavasSearchInput').addEventListener('input', onVaishnavasSearch);
    document.getElementById('findPersonBtn').addEventListener('click', findPersonInRetreat);
    document.getElementById('searchSelfieInput').addEventListener('change', onSearchSelfieChange);
    document.getElementById('downloadBtn').addEventListener('click', downloadCurrentPhoto);

    // Закрытие lightbox по Escape/стрелкам
    document.addEventListener('keydown', (e) => {
        if (!document.getElementById('lightbox').classList.contains('active')) return;
        if (e.key === 'Escape') closeLightbox();
        else if (e.key === 'ArrowLeft') navigateLightbox(-1);
        else if (e.key === 'ArrowRight') navigateLightbox(1);
    });

    // Скрытие выпадающего списка при клике вне
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#vaishnavasSearchInput') && !e.target.closest('#vaishnavasDropdown')) {
            document.getElementById('vaishnavasDropdown').classList.add('hidden');
        }
    });

    Layout.hideLoader();
}

// ==================== ДАННЫЕ ====================
async function loadRetreats() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date')
        .order('start_date', { ascending: false });

    if (error) { Layout.handleError(error, 'Загрузка ретритов'); return; }

    retreats = data || [];
    renderRetreatSelect();
}

function renderRetreatSelect() {
    const select = document.getElementById('retreatSelect');
    const lang = Layout.currentLang || 'ru';

    if (retreats.length === 0) {
        select.innerHTML = '<option value="">Нет ретритов</option>';
        return;
    }

    select.innerHTML = '<option value="">Выберите ретрит</option>' +
        retreats.map(r => {
            const name = r[`name_${lang}`] || r.name_ru || 'Без названия';
            return `<option value="${r.id}">${name}</option>`;
        }).join('');
}

async function loadVaishnavas() {
    const { data, error } = await Layout.db
        .from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name, photo_url')
        .order('spiritual_name');

    if (error) { console.error('Ошибка загрузки вайшнавов:', error); return; }

    vaishnavas = data || [];
}

function getVaishnavasName(v) {
    return v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || 'Без имени';
}

// ==================== АВТОКОМПЛИТ ВАЙШНАВОВ ====================
function onVaishnavasSearch(e) {
    const query = e.target.value.trim().toLowerCase();
    const dropdown = document.getElementById('vaishnavasDropdown');

    if (!query) {
        dropdown.classList.add('hidden');
        return;
    }

    const filtered = vaishnavas.filter(v =>
        getVaishnavasName(v).toLowerCase().includes(query)
    ).slice(0, 20);

    if (filtered.length === 0) {
        dropdown.innerHTML = '<div class="p-3 text-sm opacity-60">Ничего не найдено</div>';
    } else {
        dropdown.innerHTML = filtered.map(v => {
            const name = Layout.escapeHtml(getVaishnavasName(v));
            const photo = v.photo_url
                ? `<img src="${Layout.escapeHtml(v.photo_url)}" class="w-8 h-8 rounded-full object-cover flex-shrink-0">`
                : `<div class="w-8 h-8 rounded-full bg-base-300 flex-shrink-0 flex items-center justify-center text-xs opacity-50">?</div>`;
            return `<div class="flex items-center gap-3 p-3 hover:bg-base-200 cursor-pointer" onclick="selectVaishnavaById('${v.id}')">
                ${photo}
                <span class="text-sm">${name}</span>
            </div>`;
        }).join('');
    }
    dropdown.classList.remove('hidden');
}

function selectVaishnavaById(id) {
    const v = vaishnavas.find(v => v.id === id);
    if (!v) return;

    selectedVaishnava = v;
    searchSelfieFile = null;

    document.getElementById('vaishnavasSearchInput').value = getVaishnavasName(v);
    document.getElementById('vaishnavasDropdown').classList.add('hidden');

    const photoBlock = document.getElementById('searchPersonPhotoBlock');
    const selfieBlock = document.getElementById('searchSelfieBlock');

    if (v.photo_url) {
        document.getElementById('searchPersonPhoto').src = v.photo_url;
        document.getElementById('searchPersonName').textContent = getVaishnavasName(v);
        photoBlock.classList.remove('hidden');
        selfieBlock.classList.add('hidden');
    } else {
        photoBlock.classList.add('hidden');
        selfieBlock.classList.remove('hidden');
        document.getElementById('searchSelfiePreview').classList.add('hidden');
        document.getElementById('searchSelfieInput').value = '';
    }

    updateFindBtnState();
}

function onSearchSelfieChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    searchSelfieFile = file;

    const reader = new FileReader();
    reader.onload = (ev) => {
        document.getElementById('searchSelfieImg').src = ev.target.result;
        document.getElementById('searchSelfiePreview').classList.remove('hidden');
    };
    reader.readAsDataURL(file);

    updateFindBtnState();
}

function updateFindBtnState() {
    const retreatId = document.getElementById('retreatSelect').value;
    const hasPhoto = selectedVaishnava && (selectedVaishnava.photo_url || searchSelfieFile);
    document.getElementById('findPersonBtn').disabled = !(retreatId && hasPhoto);
}

// ==================== ПОИСК ====================
async function findPersonInRetreat() {
    const retreatId = document.getElementById('retreatSelect').value;
    if (!retreatId || !selectedVaishnava) return;

    const statusDiv = document.getElementById('searchStatus');
    const statusSpinner = document.getElementById('searchStatusSpinner');
    const statusCheck = document.getElementById('searchStatusCheck');
    const statusText = document.getElementById('searchStatusText');
    const btn = document.getElementById('findPersonBtn');

    btn.disabled = true;

    // Показать статус — синий + спиннер
    statusDiv.className = 'mt-2 mb-6 p-4 rounded-xl bg-blue-50 border border-blue-200';
    statusSpinner.classList.remove('hidden');
    statusCheck.classList.add('hidden');
    statusText.className = 'text-sm text-blue-800';
    statusText.textContent = 'Выполняется поиск...';

    document.getElementById('searchResultsBlock').classList.add('hidden');
    document.getElementById('searchEmptyState').classList.add('hidden');

    let photoUrl = selectedVaishnava.photo_url || null;
    let tempPath = null;

    try {
        // Загрузить селфи во временное хранилище, если нет photo_url
        if (!photoUrl && searchSelfieFile) {
            const uid = (await Layout.db.auth.getUser()).data.user?.id;
            if (!uid) throw new Error('Пользователь не авторизован');
            const ext = searchSelfieFile.name.split('.').pop();
            tempPath = `selfies/${uid}/${Date.now()}.${ext}`;

            const { error: upErr } = await Layout.db.storage
                .from('retreat-photos')
                .upload(tempPath, searchSelfieFile, { contentType: searchSelfieFile.type });

            if (upErr) throw upErr;

            const { data: urlData } = Layout.db.storage
                .from('retreat-photos')
                .getPublicUrl(tempPath);
            photoUrl = urlData.publicUrl;
        }

        if (!photoUrl) throw new Error('Нет фото для поиска');

        statusText.textContent = `Ищем ${getVaishnavasName(selectedVaishnava)} в ретрите...`;

        const { data: result, error: fnErr } = await Layout.db.functions.invoke('search-face', {
            body: {
                retreat_id: retreatId,
                vaishnava_id: selectedVaishnava.id,
                photo_url: photoUrl,
                threshold: 80
            }
        });

        if (fnErr) throw fnErr;

        const matchedIds = result?.matched_photo_ids || [];
        await renderSearchResults(matchedIds);

        statusSpinner.classList.add('hidden');

        if (matchedIds.length === 0) {
            // Жёлтый — ничего не найдено
            statusDiv.className = 'mt-2 mb-6 p-4 rounded-xl bg-yellow-50 border border-yellow-200';
            statusText.className = 'text-sm text-yellow-800';
            statusText.textContent = 'Фото не найдены. Попробуйте другое фото или ретрит.';
            setTimeout(() => statusDiv.classList.add('hidden'), 5000);
        } else {
            // Зелёный — найдено
            statusDiv.className = 'mt-2 mb-6 p-4 rounded-xl bg-green-50 border border-green-200';
            statusCheck.classList.remove('hidden');
            statusText.className = 'text-sm text-green-800';
            statusText.textContent = `Найдено ${matchedIds.length} фото!`;
            setTimeout(() => statusDiv.classList.add('hidden'), 3000);
        }

    } catch (err) {
        console.error('Ошибка поиска:', err);
        statusSpinner.classList.add('hidden');
        statusDiv.className = 'mt-2 mb-6 p-4 rounded-xl bg-red-50 border border-red-200';
        statusText.className = 'text-sm text-red-800';
        statusText.textContent = `Ошибка: ${err.message || 'Не удалось выполнить поиск'}`;
        document.getElementById('searchEmptyState').classList.remove('hidden');
    } finally {
        btn.disabled = false;

        // Удалить временный файл из storage
        if (tempPath) {
            await Layout.db.storage.from('retreat-photos').remove([tempPath]);
        }
    }
}

// ==================== РЕЗУЛЬТАТЫ ====================
function getPhotoUrl(storagePath) {
    const { data } = Layout.db.storage
        .from('retreat-photos')
        .getPublicUrl(storagePath);
    return data.publicUrl;
}

async function renderSearchResults(photoIds) {
    const block = document.getElementById('searchResultsBlock');
    const grid = document.getElementById('searchResultsGrid');
    const countEl = document.getElementById('searchResultsCount');
    const emptyState = document.getElementById('searchEmptyState');

    if (!photoIds || photoIds.length === 0) {
        block.classList.add('hidden');
        emptyState.classList.remove('hidden');
        emptyState.querySelector('p').textContent = 'Совпадений не найдено';
        searchResults = [];
        return;
    }

    const { data: foundPhotos, error } = await Layout.db
        .from('retreat_photos')
        .select('id, storage_path, thumb_path')
        .in('id', photoIds);

    if (error || !foundPhotos?.length) {
        block.classList.add('hidden');
        emptyState.classList.remove('hidden');
        emptyState.querySelector('p').textContent = 'Совпадений не найдено';
        searchResults = [];
        return;
    }

    searchResults = foundPhotos;
    countEl.textContent = foundPhotos.length;

    grid.innerHTML = foundPhotos.map((photo, idx) => {
        const thumbUrl = getPhotoUrl(photo.thumb_path || photo.storage_path);
        return `<div class="photo-card" onclick="openLightbox(${idx})">
            <img src="${Layout.escapeHtml(thumbUrl)}" alt="" loading="lazy">
        </div>`;
    }).join('');

    block.classList.remove('hidden');
    emptyState.classList.add('hidden');
}

// ==================== LIGHTBOX ====================
function openLightbox(index) {
    currentPhotoIndex = index;
    updateLightbox();
    document.getElementById('lightbox').classList.add('active');
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
}

function navigateLightbox(direction) {
    currentPhotoIndex = (currentPhotoIndex + direction + searchResults.length) % searchResults.length;
    updateLightbox();
}

function updateLightbox() {
    const photo = searchResults[currentPhotoIndex];
    if (!photo) return;
    document.getElementById('lightboxImg').src = getPhotoUrl(photo.storage_path);
}

function downloadCurrentPhoto() {
    const photo = searchResults[currentPhotoIndex];
    if (!photo) return;
    const url = getPhotoUrl(photo.storage_path);
    const a = document.createElement('a');
    a.href = url;
    a.download = photo.storage_path.split('/').pop();
    a.click();
}

// Экспорт для onclick
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.navigateLightbox = navigateLightbox;
window.selectVaishnavaById = selectVaishnavaById;

// ==================== START ====================
document.addEventListener('DOMContentLoaded', init);
