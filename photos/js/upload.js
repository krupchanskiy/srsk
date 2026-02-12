// UPLOAD.JS
// Логика загрузки фотографий с прогрессом и retry

(function() {
    'use strict';

    const db = window.supabaseClient;

    // Состояние
    let selectedFiles = [];
    let currentRetreatId = null;
    let uploadState = {
        isPaused: false,
        isCancelled: false,
        uploaded: 0,
        failed: 0,
        startTime: null
    };
    let fileStatuses = []; // Статусы: 'pending', 'uploading', 'success', 'error'

    // Сжатие изображения если больше 5 МБ
    async function compressImageIfNeeded(file) {
        const MAX_SIZE = 5 * 1024 * 1024; // 5 МБ

        // Если меньше 5 МБ — возвращаем как есть
        if (file.size <= MAX_SIZE) {
            return file;
        }

        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    // Создаём canvas
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // Уменьшаем размер до max 2048px по большей стороне
                    const maxSide = 2048;
                    let width = img.width;
                    let height = img.height;

                    if (width > height && width > maxSide) {
                        height = (height / width) * maxSide;
                        width = maxSide;
                    } else if (height > maxSide) {
                        width = (width / height) * maxSide;
                        height = maxSide;
                    }

                    canvas.width = width;
                    canvas.height = height;

                    // Рисуем изображение
                    ctx.drawImage(img, 0, 0, width, height);

                    // Конвертируем в Blob с качеством 0.85
                    canvas.toBlob(
                        (blob) => {
                            // Создаём новый File из Blob
                            const compressedFile = new File(
                                [blob],
                                file.name,
                                { type: 'image/jpeg', lastModified: Date.now() }
                            );
                            console.log(`Сжато: ${file.name} ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB`);
                            resolve(compressedFile);
                        },
                        'image/jpeg',
                        0.85
                    );
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async function createThumbnail(file, maxSize = 400, quality = 0.8) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const reader = new FileReader();

            reader.onload = (e) => {
                img.src = e.target.result;
            };
            reader.onerror = reject;

            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                const width = Math.round(img.width * scale);
                const height = Math.round(img.height * scale);

                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            reject(new Error('Не удалось создать превью'));
                            return;
                        }
                        resolve(new File([blob], `thumb_${file.name}`, { type: 'image/jpeg' }));
                    },
                    'image/jpeg',
                    quality
                );
            };

            img.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    // DOM элементы
    const retreatSelect = document.getElementById('retreatSelect');
    const dayNumber = document.getElementById('dayNumber');
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const previewContainer = document.getElementById('previewContainer');
    const previewGrid = document.getElementById('previewGrid');
    const photoCount = document.getElementById('photoCount');
    const clearBtn = document.getElementById('clearBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const progressContainer = document.getElementById('progressContainer');
    const resultContainer = document.getElementById('resultContainer');

    // Ожидание загрузки auth
    async function waitForAuth() {
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

    // Инициализация
    async function init() {
        // Ждём загрузки пользователя
        const authLoaded = await waitForAuth();
        if (!authLoaded) {
            alert('Ошибка загрузки данных пользователя');
            window.location.href = '/';
            return;
        }

        // Проверка прав
        if (!window.hasPermission || !window.hasPermission('upload_photos')) {
            alert('У вас нет прав для загрузки фотографий');
            window.location.href = '/';
            return;
        }

        await loadRetreats();
        setupEventListeners();
    }

    // Загрузка списка ретритов
    async function loadRetreats() {
        try {
            // Загружаем активные и будущие ретриты
            const { data: retreats, error } = await db
                .from('retreats')
                .select('id, name_ru, start_date, end_date')
                .order('start_date', { ascending: false })
                .limit(20);

            if (error) throw error;

            retreatSelect.innerHTML = '<option value="">Выберите ретрит</option>';

            retreats.forEach(retreat => {
                const option = document.createElement('option');
                option.value = retreat.id;
                option.textContent = `${retreat.name_ru} (${formatDate(retreat.start_date)} - ${formatDate(retreat.end_date)})`;
                retreatSelect.appendChild(option);
            });

        } catch (error) {
            console.error('Failed to load retreats:', error);
            showError('Не удалось загрузить список ретритов');
        }
    }

    // Форматирование даты
    function formatDate(dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    }

    // Обработчики событий
    function setupEventListeners() {
        // Drag & Drop
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });

        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });

        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            handleFiles(e.dataTransfer.files);
        });

        // Click на зону = click на input
        uploadZone.addEventListener('click', () => {
            fileInput.click();
        });

        // Выбор файлов через input
        fileInput.addEventListener('change', (e) => {
            handleFiles(e.target.files);
        });

        // Кнопки
        clearBtn.addEventListener('click', clearSelection);
        uploadBtn.addEventListener('click', startUpload);
        document.getElementById('pauseBtn')?.addEventListener('click', togglePause);
        document.getElementById('cancelBtn')?.addEventListener('click', cancelUpload);
        document.getElementById('uploadMoreBtn')?.addEventListener('click', resetForm);

        // Выбор ретрита
        retreatSelect.addEventListener('change', (e) => {
            currentRetreatId = e.target.value;
        });
    }

    // Обработка выбранных файлов
    function handleFiles(files) {
        const validFiles = Array.from(files).filter(file => {
            // Проверка типа
            if (!file.type.match(/image\/(jpeg|jpg|png)/)) {
                return false;
            }
            // Проверка размера (50 МБ — будет сжато до 5 МБ если нужно)
            if (file.size > 50 * 1024 * 1024) {
                alert(`Файл ${file.name} слишком большой (максимум 50 МБ)`);
                return false;
            }
            return true;
        });

        if (validFiles.length === 0) {
            return;
        }

        selectedFiles = [...selectedFiles, ...validFiles];
        updatePreview();
    }

    // Обновление превью
    async function updatePreview() {
        if (selectedFiles.length === 0) {
            previewContainer.classList.add('hidden');
            return;
        }

        previewContainer.classList.remove('hidden');
        photoCount.textContent = selectedFiles.length;
        previewGrid.innerHTML = '';

        for (let i = 0; i < selectedFiles.length; i++) {
            const file = selectedFiles[i];
            const preview = await createPreview(file, i);
            previewGrid.appendChild(preview);
        }
    }

    // Создание превью одного фото
    function createPreview(file, index) {
        return new Promise((resolve) => {
            const div = document.createElement('div');
            div.className = 'photo-preview';

            const img = document.createElement('img');
            const reader = new FileReader();

            reader.onload = (e) => {
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);

            const removeBtn = document.createElement('div');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.onclick = () => removeFile(index);

            div.appendChild(img);
            div.appendChild(removeBtn);

            resolve(div);
        });
    }

    // Удаление файла из списка
    function removeFile(index) {
        selectedFiles.splice(index, 1);
        updatePreview();
    }

    // Очистка выбора
    function clearSelection() {
        selectedFiles = [];
        fileInput.value = '';
        updatePreview();
    }

    // Начало загрузки
    async function startUpload() {
        if (!currentRetreatId) {
            alert('Выберите ретрит');
            return;
        }

        if (selectedFiles.length === 0) {
            alert('Выберите фотографии');
            return;
        }

        // Скрыть превью, показать прогресс
        previewContainer.classList.add('hidden');
        progressContainer.classList.remove('hidden');
        document.getElementById('uploadLeaveWarning')?.classList.remove('hidden');

        // Сброс состояния
        uploadState = {
            isPaused: false,
            isCancelled: false,
            uploaded: 0,
            failed: 0,
            startTime: Date.now()
        };

        // Инициализация статусов файлов
        fileStatuses = selectedFiles.map(() => 'pending');

        document.getElementById('totalCount').textContent = selectedFiles.length;
        document.getElementById('uploadedCount').textContent = '0';
        document.getElementById('errorCount').textContent = '0';
        document.getElementById('uploadPercent').textContent = '0%';
        document.getElementById('progressBar').style.width = '0%';

        // Отрисовать список файлов
        renderFileList();

        // Последовательная загрузка
        for (let i = 0; i < selectedFiles.length; i++) {
            if (uploadState.isCancelled) {
                break;
            }

            // Пауза
            while (uploadState.isPaused && !uploadState.isCancelled) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            const file = selectedFiles[i];

            // Обновить статус на "uploading"
            fileStatuses[i] = 'uploading';
            updateFileStatus(i);

            try {
                await uploadSingleFile(file);
                uploadState.uploaded++;
                fileStatuses[i] = 'success';
            } catch (error) {
                console.error('Upload failed:', file.name, error);
                uploadState.failed++;
                fileStatuses[i] = 'error';
                document.getElementById('errorCount').textContent = uploadState.failed;
            }

            updateFileStatus(i);

            // Обновление прогресса
            const percent = Math.round(((uploadState.uploaded + uploadState.failed) / selectedFiles.length) * 100);
            document.getElementById('uploadedCount').textContent = uploadState.uploaded;
            document.getElementById('uploadPercent').textContent = percent + '%';
            document.getElementById('progressBar').style.width = percent + '%';

            // Скорость (МБ/сек по загруженным файлам)
            const elapsed = (Date.now() - uploadState.startTime) / 1000;
            const uploadedBytes = selectedFiles
                .slice(0, uploadState.uploaded + uploadState.failed)
                .reduce((sum, f) => sum + (f.size || 0), 0);
            const speedMbps = elapsed > 0 ? (uploadedBytes / 1024 / 1024 / elapsed) : 0;
            document.getElementById('uploadSpeed').textContent = `${speedMbps.toFixed(2)} МБ/сек`;
        }

        // Завершение
        if (!uploadState.isCancelled) {
            showResult();
        }
    }

    // Отрисовка списка файлов
    function renderFileList() {
        const fileList = document.getElementById('fileList');
        fileList.innerHTML = selectedFiles.map((file, index) => {
            const status = fileStatuses[index] || 'pending';
            const statusText = {
                'pending': 'Ожидание',
                'uploading': 'Загрузка...',
                'success': '✓ Загружено',
                'error': '✗ Ошибка'
            }[status];

            return `
                <div class="file-item" data-file-index="${index}">
                    <span class="file-item-name" title="${file.name}">${file.name}</span>
                    <span class="file-status ${status}">${statusText}</span>
                    ${status === 'error' ? '<button class="btn btn-xs btn-ghost" onclick="retryFile(' + index + ')">Повтор</button>' : ''}
                </div>
            `;
        }).join('');
    }

    // Обновление статуса одного файла
    function updateFileStatus(index) {
        const fileItem = document.querySelector(`[data-file-index="${index}"]`);
        if (!fileItem) return;

        const status = fileStatuses[index];
        const statusText = {
            'pending': 'Ожидание',
            'uploading': 'Загрузка...',
            'success': '✓ Загружено',
            'error': '✗ Ошибка'
        }[status];

        const statusSpan = fileItem.querySelector('.file-status');
        statusSpan.className = `file-status ${status}`;
        statusSpan.textContent = statusText;

        // Добавить кнопку повтора для ошибок
        const retryBtn = fileItem.querySelector('.btn');
        if (status === 'error' && !retryBtn) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-xs btn-ghost';
            btn.textContent = 'Повтор';
            btn.onclick = () => retryFile(index);
            fileItem.appendChild(btn);
        } else if (status !== 'error' && retryBtn) {
            retryBtn.remove();
        }
    }

    // Повтор загрузки упавшего файла
    window.retryFile = async function(index) {
        const file = selectedFiles[index];
        fileStatuses[index] = 'uploading';
        updateFileStatus(index);

        try {
            await uploadSingleFile(file);
            uploadState.uploaded++;
            uploadState.failed--;
            fileStatuses[index] = 'success';
        } catch (error) {
            console.error('Retry failed:', file.name, error);
            fileStatuses[index] = 'error';
        }

        updateFileStatus(index);
        document.getElementById('uploadedCount').textContent = uploadState.uploaded;
        document.getElementById('errorCount').textContent = uploadState.failed;

        const percent = Math.round(((uploadState.uploaded + uploadState.failed) / selectedFiles.length) * 100);
        document.getElementById('uploadPercent').textContent = percent + '%';
        document.getElementById('progressBar').style.width = percent + '%';

        const elapsed = (Date.now() - uploadState.startTime) / 1000;
        const uploadedBytes = selectedFiles
            .slice(0, uploadState.uploaded + uploadState.failed)
            .reduce((sum, f) => sum + (f.size || 0), 0);
        const speedMbps = elapsed > 0 ? (uploadedBytes / 1024 / 1024 / elapsed) : 0;
        document.getElementById('uploadSpeed').textContent = `${speedMbps.toFixed(2)} МБ/сек`;
    };

    // Загрузка одного файла с retry
    async function uploadSingleFile(file, retries = 3) {
        // Сжать если больше 5 МБ
        const processedFile = await compressImageIfNeeded(file);
        const thumbFile = await createThumbnail(processedFile, 400, 0.8);

        const fileName = `${currentRetreatId}/${crypto.randomUUID()}.${processedFile.name.split('.').pop()}`;
        const thumbName = `${currentRetreatId}/thumbs/${crypto.randomUUID()}.jpg`;

        for (let attempt = 0; attempt < retries; attempt++) {
            try {
                // 1. Загрузка в Storage
                const { error: uploadError } = await db.storage
                    .from('retreat-photos')
                    .upload(fileName, processedFile, {
                        cacheControl: '31536000', // 1 год кеш
                        contentType: processedFile.type
                    });

                if (uploadError) throw uploadError;

                const { error: thumbError } = await db.storage
                    .from('retreat-photos')
                    .upload(thumbName, thumbFile, {
                        cacheControl: '31536000',
                        contentType: 'image/jpeg'
                    });

                if (thumbError) throw thumbError;

                // 2. Запись в БД
                const { error: dbError } = await db
                    .from('retreat_photos')
                    .insert({
                        retreat_id: currentRetreatId,
                        storage_path: fileName,
                        thumb_path: thumbName,
                        mime_type: processedFile.type,
                        file_size: processedFile.size,
                        uploaded_by: (await db.auth.getUser()).data.user?.id,
                        day_number: dayNumber.value ? parseInt(dayNumber.value) : null,
                        index_status: 'pending'
                    });

                if (dbError) throw dbError;

                return; // Успех

            } catch (error) {
                if (attempt === retries - 1) {
                    throw error; // Последняя попытка
                }
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
            }
        }
    }

    // Пауза/Продолжить
    function togglePause() {
        uploadState.isPaused = !uploadState.isPaused;
        const btn = document.getElementById('pauseBtn');
        btn.textContent = uploadState.isPaused ? 'Продолжить' : 'Пауза';
    }

    // Отмена
    function cancelUpload() {
        if (confirm('Отменить загрузку? Уже загруженные файлы сохранятся.')) {
            uploadState.isCancelled = true;
            resetForm();
        }
    }

    // Показ результата
    function showResult() {
        progressContainer.classList.add('hidden');
        resultContainer.classList.remove('hidden');
        document.getElementById('uploadLeaveWarning')?.classList.add('hidden');

        document.getElementById('successCount').textContent = uploadState.uploaded;

        if (uploadState.failed > 0) {
            document.getElementById('failedCount').textContent = uploadState.failed;
            document.getElementById('failedCountText').style.display = 'block';
        }

        // Запуск индексации лиц (вызов Edge Function)
        if (uploadState.uploaded > 0) {
            triggerIndexing(currentRetreatId);
        }
    }

    // Запуск индексации лиц (асинхронно, без ожидания)
    async function triggerIndexing(retreatId) {
        try {
            console.log('Запуск индексации лиц для ретрита:', retreatId);

            // Вызов Edge Function (не ждём завершения)
            db.functions.invoke('index-faces', {
                body: {
                    retreat_id: retreatId,
                    limit: 20 // Батч по 20 фото
                }
            }).then(({ data, error }) => {
                if (error) {
                    console.error('Ошибка вызова index-faces:', error);
                } else {
                    console.log('Первый батч проиндексирован:', data);
                }
            });

            // Запуск polling для отображения прогресса
            startIndexingPolling(retreatId);

        } catch (err) {
            console.error('Не удалось запустить индексацию:', err);
            // Не показываем ошибку пользователю, т.к. фото уже загружены
        }
    }

    let pollingInterval = null;
    let lastProcessingCount = 0;
    let stuckCounter = 0;
    let edgeFunctionErrorCounter = 0;
    let notificationSent = false; // Флаг: уведомление уже отправлено

    // Polling для отслеживания прогресса индексации
    async function startIndexingPolling(retreatId) {
        // Показать прогресс-бар
        const indexingProgress = document.getElementById('indexingProgress');
        const indexingComplete = document.getElementById('indexingComplete');
        indexingProgress.classList.remove('hidden');
        indexingComplete.classList.add('hidden');

        // Очистить предыдущий polling
        if (pollingInterval) {
            clearInterval(pollingInterval);
        }

        lastProcessingCount = 0;
        stuckCounter = 0;
        edgeFunctionErrorCounter = 0;
        notificationSent = false; // Сброс флага при новом polling

        // Обновление каждые 3 секунды
        pollingInterval = setInterval(async () => {
            await updateIndexingProgress(retreatId);
        }, 3000);

        // Первое обновление сразу
        await updateIndexingProgress(retreatId);
    }

    async function updateIndexingProgress(retreatId) {
        try {
            const { data, error } = await db
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
                        await db
                            .from('retreat_photos')
                            .update({ index_status: 'pending', index_error: 'Timeout - reset by client' })
                            .eq('retreat_id', retreatId)
                            .eq('index_status', 'processing');

                        stuckCounter = 0;
                        lastProcessingCount = 0;
                        return; // Следующая итерация подхватит pending
                    }
                } else {
                    stuckCounter = 0;
                    lastProcessingCount = processing;
                }

                // Запускаем следующий батч, если есть pending фото И нет активной обработки
                // ИЛИ если processing зависли (stuckCounter > 3)
                if (pending > 0 && (processing === 0 || stuckCounter > 3)) {
                    console.log('🚀 Запуск следующего батча индексации...');
                    db.functions.invoke('index-faces', {
                        body: {
                            retreat_id: retreatId,
                            limit: 20
                        }
                    }).then(({ data, error }) => {
                        if (error) {
                            edgeFunctionErrorCounter++;
                            console.error(`Ошибка индексации батча (${edgeFunctionErrorCounter}/10):`, error);
                            // Если Edge Function упала — показать предупреждение
                            if (error.message && error.message.includes('546')) {
                                console.error('❌ Edge Function вернула 546 — проверь AWS credentials в Supabase Secrets');
                            }

                            // Остановить polling после 10 ошибок подряд
                            if (edgeFunctionErrorCounter >= 10) {
                                console.error('❌ Индексация остановлена: 10 последовательных ошибок Edge Function');
                                clearInterval(pollingInterval);
                                pollingInterval = null;

                                const indexingProgress = document.getElementById('indexingProgress');
                                const indexingComplete = document.getElementById('indexingComplete');
                                indexingProgress.classList.add('hidden');
                                indexingComplete.classList.remove('hidden');
                                indexingComplete.classList.add('flex');
                                indexingComplete.innerHTML = '<div class="text-sm text-red-600">⚠️ Индексация остановлена из-за повторяющихся ошибок. Проверьте настройки AWS.</div>';
                            }
                        } else {
                            edgeFunctionErrorCounter = 0; // Сброс счётчика при успехе
                            console.log('✅ Батч проиндексирован:', data);
                        }
                    });
                }
            }

            // Если всё проиндексировано — остановить polling
            if (indexed + failed === total && processing === 0 && pending === 0) {
                console.log(`✅ Индексация завершена: ${indexed} проиндексировано, ${failed} с ошибками, ${totalFaces} лиц найдено`);

                clearInterval(pollingInterval);
                pollingInterval = null;

                // Показать статус завершения
                document.getElementById('indexingProgress').classList.add('hidden');
                const completeDiv = document.getElementById('indexingComplete');
                completeDiv.classList.remove('hidden');
                completeDiv.classList.add('flex');

                // Отправить Telegram уведомление участникам ретрита (один раз)
                if (indexed > 0 && !notificationSent) {
                    notificationSent = true;
                    await sendNewPhotosNotification(retreatId, indexed);
                }
            }

        } catch (err) {
            console.error('Ошибка обновления прогресса:', err);
        }
    }

    // Отправить Telegram уведомление о новых фото
    async function sendNewPhotosNotification(retreatId, photosCount) {
        try {
            console.log('📱 Отправка Telegram уведомлений для ретрита:', retreatId, 'фото:', photosCount);

            const { data: retreat } = await db
                .from('retreats')
                .select('name_ru, name_en')
                .eq('id', retreatId)
                .single();

            if (!retreat) {
                console.warn('Ретрит не найден для уведомления');
                return;
            }

            const retreatName = Layout.getName(retreat);

            // Определяем URL в зависимости от окружения
            const isDev = window.location.hostname.includes('localhost') ||
                         window.location.hostname.includes('dev') ||
                         window.location.hostname.includes('vercel.app');

            const baseUrl = isDev ? 'https://dev.rupaseva.com' : 'https://in.rupaseva.com';
            const photoUrl = `${baseUrl}/guest-portal/photos.html`;

            const message = `📸 *Новые фото с ретрита!*\n\n${retreatName}\n\nЗагружено ${photosCount} ${pluralizePhotos(photosCount)}.\n\n[Посмотреть фотографии](${photoUrl})`;

            console.log('📤 Вызов send-notification:', { retreatId, message });

            // Вызов Edge Function send-notification
            const { data, error } = await db.functions.invoke('send-notification', {
                body: {
                    type: 'broadcast',
                    retreatId: retreatId,
                    message: message,
                    parseMode: 'Markdown'
                }
            });

            if (error) {
                console.error('❌ Ошибка отправки Telegram уведомления:', error);
            } else {
                console.log('✅ Telegram уведомления отправлены:', data);
                if (data) {
                    console.log(`   → Отправлено: ${data.sent || 0}, Ошибок: ${data.failed || 0}, Заблокировано: ${data.blocked || 0}, Всего подписчиков: ${data.total || 0}`);
                }
            }

        } catch (err) {
            console.error('❌ Ошибка отправки уведомлений:', err);
        }
    }

    function pluralizePhotos(count) {
        const lastDigit = count % 10;
        const lastTwoDigits = count % 100;

        if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
            return 'фотографий';
        }

        if (lastDigit === 1) {
            return 'фотография';
        } else if (lastDigit >= 2 && lastDigit <= 4) {
            return 'фотографии';
        } else {
            return 'фотографий';
        }
    }

    // Сброс формы
    function resetForm() {
        selectedFiles = [];
        fileInput.value = '';
        uploadState = {
            isPaused: false,
            isCancelled: false,
            uploaded: 0,
            failed: 0,
            startTime: null
        };

        // Остановить polling индексации (если был запущен)
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }

        // Очистить превью (важно для "Загрузить ещё")
        previewGrid.innerHTML = '';
        photoCount.textContent = '0';

        previewContainer.classList.add('hidden');
        progressContainer.classList.add('hidden');
        resultContainer.classList.add('hidden');
        document.getElementById('uploadLeaveWarning')?.classList.add('hidden');
    }

    // Показ ошибки
    function showError(message) {
        alert(message); // TODO: Красивый модал
    }

    // Запуск при загрузке страницы
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
