// ==================== STATE ====================
let retreats = [];
let photos = [];
let selectedPhotoIds = new Set();
let currentRetreatId = null;
let currentStatusFilter = 'all';
let currentPhotoIndex = 0;
let filteredForLightbox = [];
let pollingInterval = null;
let lastProcessingCount = 0;
let stuckCounter = 0;
let edgeFunctionErrorCounter = 0;
let realtimeChannel = null;
let reindexMode = 'all'; // 'all' или 'pending'


// ==================== INIT ====================
async function waitForAuth(maxWait = 5000) {
    let attempts = 0;
    while (!window.currentUser && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
    if (!window.currentUser) {
        console.error('Auth timeout: currentUser not loaded');
        return false;
    }
    return true;
}

async function waitForTranslations(maxWait = 3000) {
    let attempts = 0;
    while (!Layout.t || !Layout.t('selected') && attempts < 30) {
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
    }
}

async function init() {
    Layout.showLoader();

    // Wait for auth
    const authReady = await waitForAuth();
    if (!authReady) {
        alert('Ошибка загрузки данных пользователя');
        window.location.href = '../index.html';
        return;
    }

    // Wait for translations to load
    await waitForTranslations();

    // Check permission
    if (!window.hasPermission || !window.hasPermission('upload_photos')) {
        alert(Layout.t('no_permission') || 'Нет прав доступа');
        window.location.href = '../index.html';
        return;
    }

    // Load retreats
    await loadRetreats();

    // Event listeners
    document.getElementById('retreatSelect').addEventListener('change', onRetreatChange);
    document.getElementById('selectAllCheckbox').addEventListener('change', onSelectAllChange);
    document.getElementById('statusFilter').addEventListener('change', onStatusFilterChange);
    document.getElementById('deleteSelectedBtn').addEventListener('click', onDeleteSelected);
    document.getElementById('confirmDeleteBtn').addEventListener('click', confirmDelete);
    document.getElementById('reindexPendingBtn').addEventListener('click', () => onReindex(false));
    document.getElementById('reindexAllBtn').addEventListener('click', () => onReindex(true));
    document.getElementById('confirmReindexBtn').addEventListener('click', confirmReindex);

    // Initialize selected count with translation
    updateSelectedCount();

    Layout.hideLoader();
}

// ==================== DATA LOADING ====================
async function loadRetreats() {
    const { data, error } = await Layout.db
        .from('retreats')
        .select('id, name_ru, name_en, name_hi, start_date, end_date')
        .order('start_date', { ascending: false });

    if (error) {
        Layout.handleError(error, 'Загрузка списка ретритов');
        return;
    }

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

async function loadPhotos(retreatId) {
    if (!retreatId) {
        photos = [];
        renderPhotos();
        // Отписаться от realtime
        unsubscribeRealtime();
        return;
    }

    Layout.showLoader();

    const { data, error } = await Layout.db
        .from('retreat_photos')
        .select('*')
        .eq('retreat_id', retreatId)
        .order('uploaded_at', { ascending: false});

    Layout.hideLoader();

    if (error) {
        Layout.handleError(error, 'Загрузка фотографий');
        return;
    }

    photos = data || [];
    selectedPhotoIds.clear();
    renderPhotos();
    updateStats();

    // Скрыть прогресс-бар при смене ретрита
    document.getElementById('indexingProgressContainer').classList.add('hidden');
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    // Подписаться на realtime обновления
    subscribeToRealtime(retreatId);
}

// ==================== REALTIME ====================
function subscribeToRealtime(retreatId) {
    // Отписаться от предыдущего канала
    unsubscribeRealtime();

    console.log(`Подписка на realtime обновления для retreat ${retreatId}`);

    // Создать новый канал для текущего ретрита
    realtimeChannel = Layout.db
        .channel(`retreat_photos:${retreatId}`)
        .on(
            'postgres_changes',
            {
                event: '*', // INSERT, UPDATE, DELETE
                schema: 'public',
                table: 'retreat_photos',
                filter: `retreat_id=eq.${retreatId}`
            },
            (payload) => {
                console.log('Realtime изменение:', payload);
                handleRealtimeChange(payload);
            }
        )
        .subscribe((status) => {
            console.log('Realtime статус:', status);
        });
}

function unsubscribeRealtime() {
    if (realtimeChannel) {
        console.log('Отписка от realtime');
        Layout.db.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
}

function handleRealtimeChange(payload) {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    switch (eventType) {
        case 'INSERT':
            // Добавить новое фото в начало списка
            photos.unshift(newRecord);
            renderPhotos();
            updateStats();
            console.log('Добавлено новое фото:', newRecord.id);
            break;

        case 'UPDATE':
            // Обновить существующее фото
            const updateIndex = photos.findIndex(p => p.id === newRecord.id);
            if (updateIndex !== -1) {
                photos[updateIndex] = newRecord;

                // Обновить только эту карточку вместо полного рендера
                updatePhotoCard(newRecord);
                updateStats();

                console.log('Обновлено фото:', newRecord.id, 'статус:', newRecord.index_status);
            }
            break;

        case 'DELETE':
            // Удалить фото из списка
            const deleteIndex = photos.findIndex(p => p.id === oldRecord.id);
            if (deleteIndex !== -1) {
                photos.splice(deleteIndex, 1);
                renderPhotos();
                updateStats();
                console.log('Удалено фото:', oldRecord.id);
            }
            break;
    }
}

function updatePhotoCard(photo) {
    const grid = document.getElementById('photosGrid');
    if (!grid) return;

    // Найти карточку по photo.id (не по индексу, т.к. может быть фильтр)
    const card = grid.querySelector(`[data-photo-id="${photo.id}"]`);
    if (!card) {
        console.log(`Карточка для фото ${photo.id} не найдена (возможно, скрыта фильтром)`);
        return;
    }

    // Обновить status-badge
    const badge = card.querySelector('.status-badge');
    if (badge) {
        const statusClass = `status-${photo.index_status || 'pending'}`;
        const statusText = Layout.t(photo.index_status || 'pending');

        badge.className = `status-badge ${statusClass}`;
        badge.textContent = statusText;
    }
}

// ==================== RENDERING ====================
function renderPhotos() {
    const container = document.getElementById('photosContainer');
    const emptyState = document.getElementById('emptyState');
    const grid = document.getElementById('photosGrid');
    const noPhotos = document.getElementById('noPhotos');
    const statsContainer = document.getElementById('statsContainer');

    if (!currentRetreatId) {
        container.classList.add('hidden');
        statsContainer.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
    }

    emptyState.classList.add('hidden');
    container.classList.remove('hidden');
    statsContainer.classList.remove('hidden');

    // Filter photos by status
    const filtered = currentStatusFilter === 'all'
        ? photos
        : photos.filter(p => p.index_status === currentStatusFilter);

    if (filtered.length === 0) {
        grid.innerHTML = '';
        noPhotos.classList.remove('hidden');
        return;
    }

    noPhotos.classList.add('hidden');

    // Store filtered photos for lightbox navigation
    filteredForLightbox = filtered;

    grid.innerHTML = filtered.map((photo, index) => {
        const url = getPhotoUrl(photo.storage_path);
        const thumbnailUrl = getPhotoUrl(photo.thumb_path || photo.storage_path);
        const isSelected = selectedPhotoIds.has(photo.id);
        const statusClass = `status-${photo.index_status || 'pending'}`;
        const statusText = Layout.t(photo.index_status || 'pending');

        return `
            <div class="photo-card ${isSelected ? 'selected' : ''}" data-photo-id="${photo.id}">
                <input type="checkbox" class="photo-checkbox"
                       data-photo-id="${photo.id}" ${isSelected ? 'checked' : ''}>
                <img src="${thumbnailUrl}" alt="Photo" loading="lazy" onclick="openLightbox(${index})">
                <div class="status-badge ${statusClass}">${statusText}</div>
            </div>
        `;
    }).join('');

    // Add event listeners to checkboxes
    grid.querySelectorAll('.photo-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', onPhotoCheckboxChange);
    });

    updateSelectedCount();
}

function updateStats() {
    const total = photos.length;
    const indexed = photos.filter(p => p.index_status === 'indexed').length;
    const pending = photos.filter(p => p.index_status === 'pending').length;
    const failed = photos.filter(p => p.index_status === 'failed').length;

    document.getElementById('totalCount').textContent = total;
    document.getElementById('indexedCount').textContent = indexed;
    document.getElementById('pendingCount').textContent = pending;
    document.getElementById('failedCount').textContent = failed;
}

function getPhotoUrl(storagePath) {
    const { data } = Layout.db.storage
        .from('retreat-photos')
        .getPublicUrl(storagePath);
    return data.publicUrl;
}

// ==================== LIGHTBOX ====================
function openLightbox(index) {
    currentPhotoIndex = index;
    updateLightbox();
    document.getElementById('lightbox').classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    document.getElementById('lightbox').classList.remove('active');
    document.body.style.overflow = '';
}

function navigateLightbox(direction) {
    currentPhotoIndex += direction;
    if (currentPhotoIndex < 0) currentPhotoIndex = filteredForLightbox.length - 1;
    if (currentPhotoIndex >= filteredForLightbox.length) currentPhotoIndex = 0;
    updateLightbox();
}

function updateLightbox() {
    const photo = filteredForLightbox[currentPhotoIndex];
    const url = getPhotoUrl(photo.storage_path);
    const filename = photo.storage_path.split('/').pop();

    document.getElementById('lightboxImg').src = url;

    const downloadBtn = document.getElementById('downloadBtn');
    downloadBtn.onclick = () => downloadPhotoFile(url, filename);
}

async function downloadPhotoFile(url, filename) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(blobUrl);
    } catch (error) {
        console.error('Ошибка скачивания фото:', error);
        alert('Не удалось скачать фото. Попробуйте ещё раз.');
    }
}

// Keyboard navigation for lightbox
document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('lightbox');
    if (!lightbox || !lightbox.classList.contains('active')) return;

    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') navigateLightbox(-1);
    else if (e.key === 'ArrowRight') navigateLightbox(1);
});

// Make functions global for onclick handlers
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.navigateLightbox = navigateLightbox;

// ==================== EVENT HANDLERS ====================
function onRetreatChange(e) {
    currentRetreatId = e.target.value || null;
    loadPhotos(currentRetreatId);
}

function onSelectAllChange(e) {
    const checked = e.target.checked;
    const filtered = currentStatusFilter === 'all'
        ? photos
        : photos.filter(p => p.index_status === currentStatusFilter);

    if (checked) {
        filtered.forEach(p => selectedPhotoIds.add(p.id));
    } else {
        selectedPhotoIds.clear();
    }

    renderPhotos();
}

function onPhotoCheckboxChange(e) {
    const photoId = e.target.dataset.photoId;
    const checked = e.target.checked;

    if (checked) {
        selectedPhotoIds.add(photoId);
    } else {
        selectedPhotoIds.delete(photoId);
    }

    // Update card styling
    const card = e.target.closest('.photo-card');
    card.classList.toggle('selected', checked);

    // Update select all checkbox
    const filtered = currentStatusFilter === 'all'
        ? photos
        : photos.filter(p => p.index_status === currentStatusFilter);
    const allSelected = filtered.length > 0 && filtered.every(p => selectedPhotoIds.has(p.id));
    document.getElementById('selectAllCheckbox').checked = allSelected;

    updateSelectedCount();
}

function updateSelectedCount() {
    const count = selectedPhotoIds.size;
    const selectedText = Layout.t('selected') || 'Выбрано';
    document.getElementById('selectedCount').textContent = `${selectedText}: ${count}`;
    document.getElementById('deleteSelectedBtn').disabled = count === 0;
}

function onStatusFilterChange(e) {
    currentStatusFilter = e.target.value;
    selectedPhotoIds.clear();
    renderPhotos();
}

function onDeleteSelected() {
    if (selectedPhotoIds.size === 0) return;

    document.getElementById('deleteCount').textContent = selectedPhotoIds.size;
    document.getElementById('deleteModal').showModal();
}

async function confirmDelete() {
    const modal = document.getElementById('deleteModal');
    const btn = document.getElementById('confirmDeleteBtn');

    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';

    try {
        const photoIds = Array.from(selectedPhotoIds);

        console.log('Deleting photos via Edge Function:', photoIds.length);

        // Получить текущую сессию для передачи JWT токена
        const { data: { session } } = await Layout.db.auth.getSession();
        if (!session) {
            throw new Error('Сессия не найдена. Пожалуйста, войдите в систему снова.');
        }

        // Вызываем Edge Function для каскадного удаления
        // (AWS Rekognition → Storage → БД)
        const { data, error } = await Layout.db.functions.invoke('delete-photos', {
            body: {
                photo_ids: photoIds,
                retreat_id: currentRetreatId
            },
            headers: {
                Authorization: `Bearer ${session.access_token}`
            }
        });

        if (error) {
            console.error('Edge Function error:', error);
            throw new Error(error.message || 'Ошибка при удалении фото');
        }

        console.log('Delete result:', data);

        const deletedText = Layout.t('successfully_deleted') || 'Успешно удалено';
        const photosText = Layout.t('photos') || 'фото';
        Layout.showNotification(
            `${deletedText}: ${photoIds.length} ${photosText}`,
            'success'
        );

        // Clear selection
        selectedPhotoIds.clear();

        // Reload photos
        await loadPhotos(currentRetreatId);

    } catch (err) {
        console.error('Delete error:', err);
        Layout.handleError(err, 'Удаление фотографий');
    } finally {
        btn.disabled = false;
        btn.textContent = Layout.t('delete') || 'Удалить';
        modal.close();
    }
}

function onReindex(resetAll = true) {
    if (!currentRetreatId) {
        alert('Выберите ретрит');
        return;
    }

    reindexMode = resetAll ? 'all' : 'pending';

    // Обновить текст модалки в зависимости от режима
    const modal = document.getElementById('reindexModal');
    const titleEl = document.getElementById('reindexModalTitle');
    const textEl = document.getElementById('reindexModalText');

    if (resetAll) {
        titleEl.textContent = Layout.t('reindex_all_confirm') || 'Переиндексировать все фотографии?';
        textEl.textContent = Layout.t('reindex_all_confirm_text') || 'Все фото будут сброшены в статус "ожидает" и переиндексированы заново. Это может занять несколько минут.';
    } else {
        titleEl.textContent = Layout.t('reindex_pending_confirm') || 'Индексировать необработанные фото?';
        textEl.textContent = Layout.t('reindex_pending_confirm_text') || 'Будут проиндексированы только фото со статусом "ожидает" и "ошибка". Проиндексированные фото не будут затронуты.';
    }

    modal.showModal();
}

async function confirmReindex() {
    const modal = document.getElementById('reindexModal');
    const btn = document.getElementById('confirmReindexBtn');

    btn.disabled = true;
    btn.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';

    try {
        if (reindexMode === 'all') {
            // Сбросить ВСЕ фото на pending
            const { error: resetError } = await Layout.db
                .from('retreat_photos')
                .update({ index_status: 'pending', faces_count: 0 })
                .eq('retreat_id', currentRetreatId);

            if (resetError) throw resetError;
        }
        // Если reindexMode === 'pending', ничего не сбрасываем — индексация подхватит pending и failed

        // Закрыть модалку
        modal.close();
        btn.disabled = false;
        btn.textContent = Layout.t('start') || 'Начать';

        // Запустить индексацию (не ждём ответа)
        Layout.db.functions.invoke('index-faces', {
            body: {
                retreat_id: currentRetreatId,
                limit: 20
            }
        }).then(({ data, error }) => {
            if (error) {
                console.error('Ошибка вызова index-faces:', error);
            } else {
                console.log('Первый батч проиндексирован:', data);
            }
        });

        // Показать прогресс-бар и запустить polling
        startIndexingPolling(currentRetreatId);

        Layout.showNotification(
            Layout.t('indexing_started') || 'Индексация запущена',
            'info'
        );

    } catch (err) {
        Layout.handleError(err, 'Индексация');
        btn.disabled = false;
        btn.textContent = Layout.t('start') || 'Начать';
        modal.close();
    }
}

// ==================== INDEXING POLLING ====================
async function startIndexingPolling(retreatId) {
    const progressContainer = document.getElementById('indexingProgressContainer');
    progressContainer.classList.remove('hidden');

    // Очистить предыдущий polling
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }

    lastProcessingCount = 0;
    stuckCounter = 0;
    edgeFunctionErrorCounter = 0;

    // Обновление каждые 3 секунды
    pollingInterval = setInterval(async () => {
        await updateIndexingProgress(retreatId);
    }, 3000);

    // Первое обновление сразу
    await updateIndexingProgress(retreatId);
}

async function updateIndexingProgress(retreatId) {
    try {
        const { data, error } = await Layout.db
            .from('retreat_photos')
            .select('index_status, faces_count')
            .eq('retreat_id', retreatId);

        if (error) {
            console.error('Ошибка загрузки прогресса индексации:', error);
            return;
        }

        const total = data.length;
        const indexed = data.filter(p => p.index_status === 'indexed').length;
        const processing = data.filter(p => p.index_status === 'processing').length;
        const pending = data.filter(p => p.index_status === 'pending').length;
        const failed = data.filter(p => p.index_status === 'failed').length;

        const totalFaces = data
            .filter(p => p.faces_count != null)
            .reduce((sum, p) => sum + (p.faces_count || 0), 0);

        const percent = total > 0 ? Math.round((indexed / total) * 100) : 0;

        // Обновление UI
        document.getElementById('indexingStats').textContent = `${indexed}/${total}`;
        document.getElementById('indexingPercent').textContent = `${percent}%`;
        document.getElementById('indexingBar').style.width = `${percent}%`;
        document.getElementById('facesFound').textContent = totalFaces;

        // Обновить stats
        updateStats();

        // Если есть pending фото — продолжаем индексацию
        if (pending > 0 || processing > 0) {
            console.log(`Индексация: ${indexed}/${total}, pending: ${pending}, processing: ${processing}`);

            // Детект зависших фото (если processing не меняется > 20 секунд)
            if (processing === lastProcessingCount && processing > 0) {
                stuckCounter++;
                console.warn(`⚠️ Зависшие фото: ${processing} в processing уже ${stuckCounter * 3} сек`);

                // Если зависло дольше 20 секунд (7 итераций по 3 сек) — сбросить в pending
                if (stuckCounter >= 7) {
                    console.error('❌ Фото зависли в processing > 20 сек. Сброс в pending...');
                    const { data: resetData, error: resetError } = await Layout.db
                        .from('retreat_photos')
                        .update({ index_status: 'pending', index_error: 'Timeout - reset by client' })
                        .eq('retreat_id', retreatId)
                        .eq('index_status', 'processing')
                        .select();

                    if (resetError) {
                        console.error('Ошибка сброса статуса:', resetError);
                        // Если ошибка прав доступа — показать уведомление
                        Layout.showNotification(
                            'Не удалось сбросить зависшие фото. Проверьте права доступа.',
                            'warning'
                        );
                    } else {
                        console.log(`✅ Сброшено ${resetData?.length || 0} фото в pending`);
                    }

                    stuckCounter = 0;
                    lastProcessingCount = 0;

                    // Явно перезагрузить данные после сброса
                    await loadPhotos(currentRetreatId);
                    return;
                }
            } else {
                stuckCounter = 0;
                lastProcessingCount = processing;
            }

            // Запускаем следующий батч, если есть pending фото И нет активной обработки
            // ИЛИ если processing зависли (stuckCounter > 3)
            if (pending > 0 && (processing === 0 || stuckCounter > 3)) {
                console.log('🚀 Запуск следующего батча индексации...');
                Layout.db.functions.invoke('index-faces', {
                    body: {
                        retreat_id: retreatId,
                        limit: 20
                    }
                }).then(({ data, error }) => {
                    if (error) {
                        edgeFunctionErrorCounter++;
                        console.error(`Ошибка индексации батча (${edgeFunctionErrorCounter}/10):`, error);
                        if (error.message && error.message.includes('546')) {
                            console.error('❌ Edge Function вернула 546 — проверь AWS credentials в Supabase Secrets');
                        }

                        // Остановить polling после 10 ошибок подряд
                        if (edgeFunctionErrorCounter >= 10) {
                            console.error('❌ Индексация остановлена: 10 последовательных ошибок Edge Function');
                            clearInterval(pollingInterval);
                            pollingInterval = null;
                            document.getElementById('indexingProgressContainer').classList.add('hidden');
                            Layout.showNotification(
                                'Индексация остановлена из-за повторяющихся ошибок. Проверьте настройки AWS.',
                                'error'
                            );
                        }
                    } else {
                        edgeFunctionErrorCounter = 0; // Сброс счётчика при успехе
                        console.log('✅ Батч проиндексирован:', data);
                    }
                });
            }
        }

        // Если всё проиндексировано — остановить polling
        if (indexed + failed === total && processing === 0) {
            clearInterval(pollingInterval);
            pollingInterval = null;

            // Скрыть прогресс-бар
            document.getElementById('indexingProgressContainer').classList.add('hidden');

            console.log(`Индексация завершена: ${indexed} проиндексировано, ${failed} с ошибками, ${totalFaces} лиц найдено`);

            Layout.showNotification(
                `${Layout.t('indexing_complete_title') || 'Индексация завершена!'} ${totalFaces} лиц найдено`,
                'success'
            );

            // Перезагрузить фото для обновления статусов
            await loadPhotos(currentRetreatId);
        }

    } catch (err) {
        console.error('Ошибка обновления прогресса:', err);
    }
}

// ==================== START ====================
document.addEventListener('DOMContentLoaded', init);
