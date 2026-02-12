/**
 * Guest Portal Index Page Logic
 * Extracted from guest-portal/index.html
 *
 * Личный кабинет гостя:
 * - Просмотр/редактирование профиля
 * - Информация о ретритах и трансферах
 * - Cropper.js для обрезки фото
 */

let photoFile = null;
let cropper = null;
let currentTransfers = { arrival: null, departure: null };
let currentRegistrationId = null;
let isPublicView = false; // Режим просмотра чужого профиля

// XSS protection helper
const escapeHtml = str => PortalLayout.escapeHtml(str);

// Photo View Modal
function openPhotoModal() {
    const guest = window.currentGuest;
    if (!guest?.photoUrl) return;

    document.getElementById('photoViewImage').src = guest.photoUrl;
    document.getElementById('photoViewName').textContent = getDisplayName(guest);
    document.getElementById('photoViewModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closePhotoModal() {
    document.getElementById('photoViewModal').classList.add('hidden');
    document.body.style.overflow = '';
}

// Coming Soon Modal
function showComingSoon() {
    document.getElementById('comingSoonModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeComingSoon() {
    document.getElementById('comingSoonModal').classList.add('hidden');
    document.body.style.overflow = '';
}

// Transfer Inline Edit
function toggleTransferEdit(direction) {
    const transfer = currentTransfers[direction];

    const viewEl = document.getElementById(`${direction}-view`);
    const editEl = document.getElementById(`${direction}-edit`);
    const editBtn = document.getElementById(`${direction}-edit-btn`);

    // Заполняем поля редактирования
    document.getElementById(`${direction}-edit-id`).value = transfer?.id || '';

    if (transfer?.flight_datetime) {
        const dt = new Date(transfer.flight_datetime);
        const localDt = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
        document.getElementById(`${direction}-edit-datetime`).value = localDt.toISOString().slice(0, 16);
    } else {
        document.getElementById(`${direction}-edit-datetime`).value = '';
    }

    document.getElementById(`${direction}-edit-flight`).value = transfer?.flight_number || '';
    document.getElementById(`${direction}-edit-needs`).checked = transfer?.needs_transfer === 'yes';

    // Переключаем режим
    viewEl.classList.add('hidden');
    editEl.classList.remove('hidden');
    editBtn.classList.add('hidden');
}

function cancelTransferEdit(direction) {
    document.getElementById(`${direction}-view`).classList.remove('hidden');
    document.getElementById(`${direction}-edit`).classList.add('hidden');
    document.getElementById(`${direction}-edit-btn`).classList.remove('hidden');
}

async function saveTransferEdit(direction) {
    const transferId = document.getElementById(`${direction}-edit-id`).value;
    const datetime = document.getElementById(`${direction}-edit-datetime`).value;
    const flightNumber = document.getElementById(`${direction}-edit-flight`).value.trim();
    const needsTransfer = document.getElementById(`${direction}-edit-needs`).checked;

    try {
        let savedTransfer;

        if (transferId) {
            // Обновляем существующую запись
            const { data, error } = await window.portalSupabase
                .from('guest_transfers')
                .update({
                    flight_datetime: datetime ? new Date(datetime).toISOString() : null,
                    flight_number: flightNumber || null,
                    needs_transfer: needsTransfer ? 'yes' : 'no'
                })
                .eq('id', transferId)
                .select()
                .single();

            if (error) throw error;
            savedTransfer = data;
        } else {
            // Создаём новую запись
            const { data, error } = await window.portalSupabase
                .from('guest_transfers')
                .insert({
                    registration_id: currentRegistrationId,
                    direction: direction,
                    flight_datetime: datetime ? new Date(datetime).toISOString() : null,
                    flight_number: flightNumber || null,
                    needs_transfer: needsTransfer ? 'yes' : 'no'
                })
                .select()
                .single();

            if (error) throw error;
            savedTransfer = data;
        }

        // Обновляем локальные данные
        currentTransfers[direction] = savedTransfer;

        // Обновляем отображение
        if (datetime) {
            document.getElementById(`${direction}-datetime`).textContent = formatTransferDateTime(new Date(datetime).toISOString());
            document.getElementById(`${direction}-flight`).textContent = flightNumber ? `Рейс ${flightNumber}` : '—';
            document.getElementById(`${direction}-taxi`).innerHTML = renderTaxiStatus(currentTransfers[direction]);
        } else {
            document.getElementById(`${direction}-datetime`).innerHTML = '<span class="text-base text-yellow-700">Пожалуйста, добавьте информацию</span>';
            document.getElementById(`${direction}-flight`).textContent = '';
            document.getElementById(`${direction}-taxi`).innerHTML = '';
        }

        // Обновляем ID в форме (для новых записей)
        document.getElementById(`${direction}-edit-id`).value = savedTransfer.id;

        cancelTransferEdit(direction);
    } catch (err) {
        console.error('Ошибка сохранения трансфера:', err);
        alert('Ошибка сохранения');
    }
}

// Закрытие по Escape
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closePhotoModal();
        closeComingSoon();
        cancelTransferEdit('arrival');
        cancelTransferEdit('departure');
    }
});

// Форматирование даты рождения
function formatBirthDate(dateStr) {
    if (!dateStr) return '';
    const date = DateUtils.parseDate(dateStr);
    const months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
                   'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
    return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

// Получить отображаемое имя
function getDisplayName(guest) {
    return guest.spiritualName ||
           `${guest.firstName || ''} ${guest.lastName || ''}`.trim() ||
           'Гость';
}

// Вычислить процент заполнения профиля
function calculateCompleteness(guest) {
    if (!guest) return 0;

    // Поля для расчёта (без фамилии и email)
    const fields = [
        'firstName',
        'spiritualName',
        'phone',
        'telegram',
        'country',
        'city',
        'photoUrl',
        'birthDate'
    ];

    let filled = 0;
    for (const field of fields) {
        if (guest[field]) filled++;
    }

    // Духовный учитель: заполнено если есть значение ИЛИ отмечено "Пока нет"
    if (guest.spiritualTeacher || guest.noSpiritualTeacher) {
        filled++;
    }

    const totalFields = fields.length + 1; // +1 за духовного учителя
    return Math.round((filled / totalFields) * 100);
}

// Получить статус пользователя
function getUserStatus(userType) {
    const statuses = {
        'guest': 'Гость',
        'staff': 'Команда',
        'admin': 'Администратор'
    };
    return statuses[userType] || 'Гость';
}

// Заполнить профиль данными
function populateProfile(guest) {
    // Скрываем скелетон, показываем профиль
    document.getElementById('profile-skeleton').classList.add('hidden');
    document.getElementById('profile-card').classList.remove('hidden');

    // Фото
    const photoContainer = document.getElementById('profile-photo');
    if (guest.photoUrl) {
        photoContainer.innerHTML = `<img src="${guest.photoUrl}" alt="Фото" class="w-full h-full object-cover">`;
    }

    // Имена
    document.getElementById('profile-spiritual-name').textContent = guest.spiritualName || '';
    document.getElementById('profile-civil-name').textContent =
        `${guest.firstName || ''} ${guest.lastName || ''}`.trim();

    // Локация
    const location = [guest.country, guest.city].filter(Boolean).join(', ');
    const locationEl = document.getElementById('profile-location');
    if (location) {
        locationEl.querySelector('span').textContent = location;
        locationEl.classList.remove('hidden');
    } else {
        locationEl.classList.add('hidden');
    }

    // Дата рождения
    const birthEl = document.getElementById('profile-birthdate');
    if (guest.birthDate) {
        birthEl.querySelector('span').textContent = formatBirthDate(guest.birthDate);
        birthEl.classList.remove('hidden');
    } else {
        birthEl.classList.add('hidden');
    }

    // Духовный учитель
    const teacherEl = document.getElementById('profile-teacher');
    if (guest.spiritualTeacher) {
        teacherEl.querySelector('span').textContent = guest.spiritualTeacher;
        teacherEl.classList.remove('hidden');
    } else {
        teacherEl.classList.add('hidden');
    }

    // Статус
    document.getElementById('profile-status').textContent = getUserStatus(guest.userType);

    // Телефон
    const phonePlainEl = document.getElementById('profile-phone-plain');
    const phoneWhatsappEl = document.getElementById('profile-phone-whatsapp');
    if (guest.phone) {
        if (guest.hasWhatsapp) {
            // С WhatsApp — кликабельная ссылка
            const waNumber = guest.phone.replace(/[^\d+]/g, '').replace(/^\+/, '');
            phoneWhatsappEl.href = `https://wa.me/${waNumber}`;
            phoneWhatsappEl.querySelector('span').textContent = guest.phone;
            phoneWhatsappEl.classList.remove('hidden');
            phonePlainEl.classList.add('hidden');
        } else {
            // Без WhatsApp — просто текст
            phonePlainEl.querySelector('span').textContent = guest.phone;
            phonePlainEl.classList.remove('hidden');
            phoneWhatsappEl.classList.add('hidden');
        }
    } else {
        phonePlainEl.classList.add('hidden');
        phoneWhatsappEl.classList.add('hidden');
    }

    // Telegram
    const tgEl = document.getElementById('profile-telegram');
    const tgHandle = guest.telegram || guest.telegramUsername;
    if (tgHandle) {
        const cleanHandle = tgHandle.replace('@', '');
        const displayName = `@${cleanHandle}`;
        tgEl.href = `https://t.me/${cleanHandle}`;
        tgEl.querySelector('span').textContent = displayName;
        tgEl.classList.remove('hidden');
    } else {
        tgEl.classList.add('hidden');
    }

    // Заполненность профиля (вычисляем для конкретного guest)
    const completeness = calculateCompleteness(guest);
    document.getElementById('profile-completeness-value').textContent = `${completeness}%`;
    const bar = document.getElementById('profile-completeness-bar');
    bar.style.width = `${completeness}%`;

    // Цвет полоски: <50% красный, 50-99% жёлтый, 100% зелёный
    bar.classList.remove('bg-srsk-orange', 'bg-red-400', 'bg-yellow-400', 'bg-green-400');
    if (completeness < 50) {
        bar.classList.add('bg-red-400');
    } else if (completeness < 100) {
        bar.classList.add('bg-yellow-400');
    } else {
        bar.classList.add('bg-green-400');
    }

    // Имя и фото в шапке — только если это свой профиль (не публичный просмотр)
    if (!isPublicView) {
        document.getElementById('header-name').textContent = getDisplayName(guest);
        document.getElementById('mobile-name').textContent = getDisplayName(guest);

        if (guest.photoUrl) {
            document.getElementById('header-photo').innerHTML =
                `<img src="${guest.photoUrl}" alt="" class="w-full h-full object-cover">`;
        }

        // Проверяем статус Telegram уведомлений
        checkTelegramStatus();
    }
}

// Переключение поля духовного учителя
function toggleSpiritualTeacherField() {
    const checkbox = document.getElementById('edit-noSpiritualTeacher');
    const input = document.getElementById('edit-spiritualTeacher');
    if (checkbox.checked) {
        input.disabled = true;
        input.value = '';
    } else {
        input.disabled = false;
    }
}

// Переключение режима редактирования
function toggleProfileEdit(editMode) {
    const viewEl = document.getElementById('profile-view');
    const editEl = document.getElementById('profile-edit');

    if (editMode) {
        viewEl.classList.add('hidden');
        editEl.classList.remove('hidden');
        fillEditForm(window.currentGuest);
    } else {
        viewEl.classList.remove('hidden');
        editEl.classList.add('hidden');
        photoFile = null;
    }
}

// Заполнить форму редактирования
function fillEditForm(guest) {
    document.getElementById('edit-spiritualName').value = guest.spiritualName || '';
    document.getElementById('edit-firstName').value = guest.firstName || '';
    document.getElementById('edit-lastName').value = guest.lastName || '';
    document.getElementById('edit-country').value = guest.country || '';
    document.getElementById('edit-city').value = guest.city || '';
    document.getElementById('edit-birthDate').value = guest.birthDate || '';
    document.getElementById('edit-spiritualTeacher').value = guest.spiritualTeacher || '';
    document.getElementById('edit-noSpiritualTeacher').checked = guest.noSpiritualTeacher || false;
    toggleSpiritualTeacherField();
    document.getElementById('edit-phone').value = guest.phone || '';
    document.getElementById('edit-has-whatsapp').checked = guest.hasWhatsapp || false;
    document.getElementById('edit-telegram').value = guest.telegram || '';
    document.getElementById('edit-is-public').checked = guest.isProfilePublic !== false;

    // Фото
    const preview = document.getElementById('edit-photo-preview');
    const placeholder = document.getElementById('edit-photo-placeholder');
    if (guest.photoUrl) {
        preview.src = guest.photoUrl;
        preview.classList.remove('hidden');
        placeholder.classList.add('hidden');
    } else {
        preview.classList.add('hidden');
        placeholder.classList.remove('hidden');
    }
}

// Инициализация загрузки фото
function initPhotoUpload() {
    const uploadArea = document.getElementById('edit-photo-upload');
    const input = document.getElementById('edit-photo-input');

    uploadArea.addEventListener('click', (e) => {
        if (e.target !== input) {
            input.click();
        }
    });

    input.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        // Проверка размера (макс 5MB)
        if (file.size > 5 * 1024 * 1024) {
            alert('Файл слишком большой (максимум 5MB)');
            return;
        }

        // Проверка типа
        if (!file.type.startsWith('image/')) {
            alert('Выберите изображение');
            return;
        }

        // Открываем кроппер
        const reader = new FileReader();
        reader.onload = (e) => {
            openCropModal(e.target.result);
        };
        reader.readAsDataURL(file);
    });
}

// Открыть модальное окно кроппера
function openCropModal(imageSrc) {
    const modal = document.getElementById('cropModal');
    const cropImage = document.getElementById('cropImage');

    cropImage.src = imageSrc;
    modal.classList.remove('hidden');

    if (cropper) {
        cropper.destroy();
        cropper = null;
    }

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
}

// Закрыть кроппер
function closeCropModal() {
    document.getElementById('cropModal').classList.add('hidden');
    if (cropper) {
        cropper.destroy();
        cropper = null;
    }
    document.getElementById('edit-photo-input').value = '';
}

// Zoom slider
function handleZoomRange(value) {
    if (cropper) cropper.zoomTo(parseFloat(value));
}

// Сохранить обрезанное фото
function saveCroppedPhoto() {
    if (!cropper) return;

    const canvas = cropper.getCroppedCanvas({
        width: 1000,
        height: 1000,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high'
    });

    canvas.toBlob((blob) => {
        photoFile = new File([blob], 'photo.jpg', { type: 'image/jpeg' });

        // Показываем превью
        const preview = document.getElementById('edit-photo-preview');
        const placeholder = document.getElementById('edit-photo-placeholder');
        preview.src = canvas.toDataURL('image/jpeg', 0.95);
        preview.classList.remove('hidden');
        placeholder.classList.add('hidden');

        closeCropModal();
    }, 'image/jpeg', 0.95);
}

// Сохранение профиля
async function handleProfileSave(e) {
    e.preventDefault();

    const saveBtn = document.getElementById('save-profile-btn');
    const spinner = document.getElementById('save-spinner');

    saveBtn.disabled = true;
    spinner.classList.remove('hidden');

    try {
        const guest = window.currentGuest;
        let photoUrl = guest.photoUrl;

        // Загружаем фото если выбрано
        if (photoFile) {
            const uploadResult = await PortalData.uploadPhoto(photoFile, guest.id);
            if (uploadResult.success) {
                photoUrl = uploadResult.url;
            } else {
                alert('Ошибка загрузки фото');
            }
        }

        // Собираем данные
        const profileData = {
            firstName: document.getElementById('edit-firstName').value.trim(),
            lastName: document.getElementById('edit-lastName').value.trim(),
            spiritualName: document.getElementById('edit-spiritualName').value.trim(),
            spiritualTeacher: document.getElementById('edit-spiritualTeacher').value.trim(),
            noSpiritualTeacher: document.getElementById('edit-noSpiritualTeacher').checked,
            phone: document.getElementById('edit-phone').value.trim(),
            hasWhatsapp: document.getElementById('edit-has-whatsapp').checked,
            telegram: document.getElementById('edit-telegram').value.trim(),
            country: document.getElementById('edit-country').value.trim(),
            city: document.getElementById('edit-city').value.trim(),
            birthDate: document.getElementById('edit-birthDate').value || null,
            photoUrl: photoUrl,
            isProfilePublic: document.getElementById('edit-is-public').checked
        };

        // Сохраняем
        const result = await PortalData.updateProfile(guest.id, profileData);

        if (result.success) {
            // Обновляем локальные данные
            Object.assign(window.currentGuest, profileData);

            // Обновляем UI
            populateProfile(window.currentGuest);
            toggleProfileEdit(false);
        } else {
            alert('Ошибка сохранения: ' + (result.error || 'Неизвестная ошибка'));
        }

    } catch (error) {
        console.error('Ошибка сохранения:', error);
        alert('Ошибка сохранения профиля');
    } finally {
        saveBtn.disabled = false;
        spinner.classList.add('hidden');
    }
}

// Форматирование даты ретрита
function formatRetreatDates(startDate, endDate) {
    const start = DateUtils.parseDate(startDate);
    const end = DateUtils.parseDate(endDate);
    const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

    if (start.getMonth() === end.getMonth()) {
        return `${start.getDate()}–${end.getDate()} ${months[start.getMonth()]}`;
    }
    return `${start.getDate()} ${months[start.getMonth()]} – ${end.getDate()} ${months[end.getMonth()]}`;
}

// Форматирование даты/времени трансфера
function formatTransferDateTime(datetime) {
    if (!datetime) return '';
    const date = new Date(datetime);
    const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${date.getDate()} ${months[date.getMonth()]}, ${hours}:${minutes}`;
}

// Отобразить статус такси
function renderTaxiStatus(transfer) {
    if (!transfer.needs_transfer || transfer.needs_transfer === 'no') {
        return '<div class="text-xs text-gray-500">Трансфер не нужен</div>';
    }

    if (transfer.taxi_status === 'booked' || transfer.taxi_driver_info) {
        return `
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 bg-srsk-green rounded-full"></span>
                <span class="text-sm text-srsk-green font-medium">Такси заказано</span>
            </div>
            ${transfer.taxi_driver_info ? `<div class="text-xs text-gray-500 mt-1">${escapeHtml(transfer.taxi_driver_info)}</div>` : ''}
        `;
    }

    return `
        <div class="flex items-center gap-2">
            <span class="w-2 h-2 bg-srsk-orange rounded-full"></span>
            <span class="text-sm text-yellow-700 font-medium">Такси требуется</span>
        </div>
    `;
}

// Загрузить активный/предстоящий ретрит
async function loadActiveRetreat(guestId) {
    try {
        const data = await PortalData.loadDashboardData(guestId);

        const retreatSkeleton = document.getElementById('retreat-skeleton');
        const retreatBlock = document.getElementById('retreat-block');
        const noRetreatBlock = document.getElementById('no-retreat-block');
        const transferBlock = document.getElementById('transfer-block');

        // Скрываем скелетон
        retreatSkeleton.classList.add('hidden');

        if (!data.activeRetreat) {
            // Нет активного ретрита — перемещаем "Ближайшие ретриты" в правую колонку
            retreatBlock.classList.add('hidden');
            transferBlock.classList.add('hidden');

            // Перемещаем блок ближайших ретритов вместо no-retreat-block
            const upcomingSection = document.getElementById('upcoming-retreats-section');
            if (upcomingSection && noRetreatBlock) {
                noRetreatBlock.replaceWith(upcomingSection);
                upcomingSection.classList.add('flex-1');
                upcomingSection.classList.remove('mb-4');
                // Меняем grid на 1 колонку в правой части
                const upcomingGrid = document.getElementById('upcoming-retreats');
                if (upcomingGrid) {
                    upcomingGrid.classList.remove('sm:grid-cols-3');
                    upcomingGrid.classList.add('grid-cols-1');
                }
            }
            return;
        }

        const retreat = data.activeRetreat.retreat;

        // Показываем блок ретрита
        retreatBlock.classList.remove('hidden');
        noRetreatBlock.classList.add('hidden');

        // Добавляем переход на страницу ретрита по клику
        retreatBlock.onclick = () => {
            window.location.href = `/retreat.html?id=${retreat.id}`;
        };

        // Заполняем данные ретрита
        document.getElementById('retreat-label').textContent = data.isCurrentRetreat ? 'Ваш ретрит' : 'Предстоящий ретрит';
        document.getElementById('retreat-name').textContent = retreat.name_ru;
        document.getElementById('retreat-dates').textContent = formatRetreatDates(retreat.start_date, retreat.end_date);
        document.getElementById('retreat-description').textContent = retreat.description_ru || '';

        // Картинка
        const imageEl = document.getElementById('retreat-image');
        if (retreat.image_url) {
            imageEl.innerHTML = `<img src="${retreat.image_url}" alt="" class="w-full h-full object-cover">`;
        }

        // Размещение
        if (data.accommodation) {
            document.getElementById('retreat-accommodation').classList.remove('hidden');

            if (data.accommodation.room) {
                // Размещение в ашраме
                document.getElementById('retreat-room').textContent =
                    `${data.accommodation.room.building?.name_ru || ''}, №${data.accommodation.room.number}`;

                // Сосед
                if (data.accommodation.roommates?.length > 0) {
                    const roommate = data.accommodation.roommates[0];
                    const roommateName = roommate.spiritual_name ||
                        `${roommate.first_name || ''} ${roommate.last_name || ''}`.trim();

                    document.getElementById('retreat-roommate-block').classList.remove('hidden');
                    document.getElementById('retreat-roommate-name').textContent = roommateName;
                    document.getElementById('retreat-roommate').href = `index.html?view=${roommate.id}`;

                    if (roommate.photo_url) {
                        document.getElementById('retreat-roommate-photo').innerHTML =
                            `<img src="${roommate.photo_url}" alt="" class="w-full h-full object-cover">`;
                    }
                }
            } else {
                // Самостоятельное проживание (room_id = NULL)
                document.getElementById('retreat-room').textContent = 'Самостоятельное';
            }
        }

        // Трансферы — всегда показываем блок при наличии ретрита
        currentTransfers = data.transfers; // Сохраняем для редактирования
        currentRegistrationId = data.activeRetreat.id; // Сохраняем ID регистрации
        transferBlock.classList.remove('hidden');

        // Прилёт
        const arrival = data.transfers.arrival;
        document.getElementById('arrival-block').classList.remove('hidden');
        if (arrival?.flight_datetime) {
            document.getElementById('arrival-datetime').textContent = formatTransferDateTime(arrival.flight_datetime);
            document.getElementById('arrival-flight').textContent = `Рейс ${arrival.flight_number || '—'}`;
            document.getElementById('arrival-taxi').innerHTML = renderTaxiStatus(arrival);
        } else {
            const noInfoText = isPublicView ? 'Нет информации' : 'Пожалуйста, добавьте информацию';
            document.getElementById('arrival-datetime').innerHTML = `<span class="text-base text-gray-400">${noInfoText}</span>`;
            document.getElementById('arrival-flight').textContent = '';
            document.getElementById('arrival-taxi').innerHTML = '';
        }
        // Скрываем кнопку редактирования в публичном режиме
        if (isPublicView) {
            document.getElementById('arrival-edit-btn')?.classList.add('hidden');
        }

        // Вылет
        const departure = data.transfers.departure;
        document.getElementById('departure-block').classList.remove('hidden');
        if (departure?.flight_datetime) {
            document.getElementById('departure-datetime').textContent = formatTransferDateTime(departure.flight_datetime);
            document.getElementById('departure-flight').textContent = `Рейс ${departure.flight_number || '—'}`;
            document.getElementById('departure-taxi').innerHTML = renderTaxiStatus(departure);
        } else {
            const noInfoText = isPublicView ? 'Нет информации' : 'Пожалуйста, добавьте информацию';
            document.getElementById('departure-datetime').innerHTML = `<span class="text-base text-gray-400">${noInfoText}</span>`;
            document.getElementById('departure-flight').textContent = '';
            document.getElementById('departure-taxi').innerHTML = '';
        }
        // Скрываем кнопку редактирования в публичном режиме
        if (isPublicView) {
            document.getElementById('departure-edit-btn')?.classList.add('hidden');
        }

        // Дети
        renderPortalChildren(data.children || []);

    } catch (e) {
        console.error('Ошибка загрузки ретрита:', e);
        // Скрываем скелетон даже при ошибке
        document.getElementById('retreat-skeleton').classList.add('hidden');
        document.getElementById('no-retreat-block').classList.remove('hidden');
    }
}

// ==================== CHILDREN ====================

let portalChildren = [];

function renderPortalChildren(childrenData) {
    portalChildren = childrenData;
    const section = document.getElementById('children-section');
    const list = document.getElementById('children-list');

    if (!section || !list) return;

    // Показываем секцию всегда (даже без детей — чтобы можно было добавить)
    // Но в публичном режиме — только если есть дети
    if (isPublicView && childrenData.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    if (childrenData.length === 0) {
        list.innerHTML = `
            <div class="text-center py-4 text-gray-400 text-sm">
                Нет привязанных детей
            </div>
        `;
        return;
    }

    list.innerHTML = childrenData.map(child => {
        const name = child.spiritual_name || `${child.first_name || ''} ${child.last_name || ''}`.trim() || '—';
        const age = child.birth_date ? DateUtils.calculateAge(child.birth_date) : null;
        const genderIcon = child.gender === 'male' ? '👦' : child.gender === 'female' ? '👧' : '👶';
        const ageStr = age !== null ? `, ${age} лет` : '';
        const initials = (child.first_name?.[0] || '') + (child.last_name?.[0] || '');

        return `
            <div class="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                ${child.photo_url
                    ? `<img src="${escapeHtml(child.photo_url)}" class="w-10 h-10 rounded-full object-cover" alt="">`
                    : `<div class="w-10 h-10 rounded-full bg-srsk-green/10 flex items-center justify-center text-sm font-medium text-srsk-green">${initials.toUpperCase() || '?'}</div>`
                }
                <div class="flex-1 min-w-0">
                    <div class="font-medium text-sm truncate">${escapeHtml(name)}</div>
                    <div class="text-xs text-gray-400">${genderIcon}${ageStr}</div>
                </div>
                ${!isPublicView ? `
                    <button onclick="editChildPortal('${child.id}')" class="text-gray-400 hover:text-srsk-green transition-colors">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125" />
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;
    }).join('');
}

function openAddChildPortal() {
    document.getElementById('childPortalForm').reset();
    document.getElementById('portalChildId').value = '';
    document.getElementById('childModalPortalTitle').textContent = 'Добавить ребёнка';
    document.getElementById('deleteChildBtn').classList.add('hidden');
    document.getElementById('childModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function editChildPortal(childId) {
    const child = portalChildren.find(c => c.id === childId);
    if (!child) return;

    document.getElementById('portalChildId').value = child.id;
    document.getElementById('portalChildFirstName').value = child.first_name || '';
    document.getElementById('portalChildLastName').value = child.last_name || '';
    document.getElementById('portalChildGender').value = child.gender || '';
    document.getElementById('portalChildBirthDate').value = child.birth_date || '';
    document.getElementById('childModalPortalTitle').textContent = 'Редактировать ребёнка';
    document.getElementById('deleteChildBtn').classList.remove('hidden');
    document.getElementById('childModal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeChildPortal() {
    document.getElementById('childModal').classList.add('hidden');
    document.body.style.overflow = '';
}

async function saveChildPortal(event) {
    event.preventDefault();

    const childId = document.getElementById('portalChildId').value;
    const childData = {
        firstName: document.getElementById('portalChildFirstName').value,
        lastName: document.getElementById('portalChildLastName').value,
        gender: document.getElementById('portalChildGender').value || null,
        birthDate: document.getElementById('portalChildBirthDate').value || null
    };

    if (!childData.firstName) {
        alert('Укажите имя ребёнка');
        return;
    }

    const guest = window.currentGuest;
    if (!guest?.id) return;

    let result;
    if (childId) {
        result = await PortalData.updateChild(childId, childData);
    } else {
        result = await PortalData.createChild(guest.id, childData);
    }

    if (!result.success) {
        alert('Ошибка сохранения: ' + (result.error || ''));
        return;
    }

    closeChildPortal();

    // Перезагружаем детей
    const freshChildren = await PortalData.getChildren(guest.id);
    renderPortalChildren(freshChildren);
}

async function deleteChildPortal() {
    const childId = document.getElementById('portalChildId').value;
    if (!childId) return;

    if (!confirm('Удалить ребёнка из вашего профиля?')) return;

    const result = await PortalData.deleteChild(childId);
    if (!result.success) {
        alert('Ошибка удаления: ' + (result.error || ''));
        return;
    }

    closeChildPortal();

    const guest = window.currentGuest;
    if (guest?.id) {
        const freshChildren = await PortalData.getChildren(guest.id);
        renderPortalChildren(freshChildren);
    }
}

// Закрытие по Escape (children modal)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeChildPortal();
    }
});

// Загрузить ближайшие ретриты
async function loadUpcomingRetreats(guestId = null) {
    try {
        const today = DateUtils.toISO(new Date());

        // Получаем ID ретритов, на которые гость уже зарегистрирован
        let registeredRetreatIds = [];
        if (guestId) {
            const { data: registrations } = await window.portalSupabase
                .from('retreat_registrations')
                .select('retreat_id')
                .eq('vaishnava_id', guestId)
                .neq('status', 'cancelled');

            if (registrations) {
                registeredRetreatIds = registrations.map(r => r.retreat_id);
            }
        }

        let query = window.portalSupabase
            .from('retreats')
            .select('id, name_ru, start_date, end_date, description_ru, image_url, registration_open')
            .gte('start_date', today)
            .order('start_date')
            .limit(6); // Берём больше, т.к. часть отфильтруем

        const { data, error } = await query;

        if (error) throw error;

        // Фильтруем ретриты, на которые уже зарегистрирован
        const filteredData = data
            ? data.filter(r => !registeredRetreatIds.includes(r.id)).slice(0, 3)
            : [];

        const container = document.getElementById('upcoming-retreats');
        if (filteredData.length === 0) {
            container.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-8">Нет запланированных ретритов</div>';
            return;
        }

        container.innerHTML = filteredData.map(retreat => `
            <a href="/retreat.html?id=${retreat.id}" class="bg-white rounded-xl overflow-hidden border-2 border-transparent hover:border-[#6B5B95] transition-all flex group">
                <div class="w-28 bg-gray-100 flex-shrink-0 flex items-center justify-center overflow-hidden">
                    ${retreat.image_url
                        ? `<img src="${retreat.image_url}" alt="" class="w-full h-full object-cover">`
                        : `<img src="images/tilak-placeholder.svg" alt="" class="w-12 h-12 opacity-30">`
                    }
                </div>
                <div class="p-3 flex flex-col flex-1">
                    <div class="text-xs text-srsk-green font-medium">${formatRetreatDates(retreat.start_date, retreat.end_date)}</div>
                    <div class="font-medium text-gray-800 text-sm mt-1">${escapeHtml(retreat.name_ru || '')}</div>
                    <div class="text-xs text-gray-500 mt-1 line-clamp-2">${escapeHtml(retreat.description_ru || '')}</div>
                    <div class="text-xs text-srsk-orange font-medium mt-auto pt-2 flex items-center gap-1 group-hover:underline">
                        Подать заявку
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"/></svg>
                    </div>
                </div>
            </a>
        `).join('');

    } catch (e) {
        console.error('Ошибка загрузки ретритов:', e);
    }
}

// Загрузить материалы для карусели
async function loadMaterialsCards() {
    try {
        const materials = await PortalData.getMaterials();
        const container = document.getElementById('materials-cards');

        if (!container) return;

        if (materials.length === 0) {
            container.innerHTML = '<div class="text-gray-500 text-sm py-4">Материалов пока нет</div>';
            return;
        }

        container.innerHTML = materials.slice(0, 6).map(m => `
            <a href="materials.html?id=${escapeHtml(m.slug)}"
               class="flex-shrink-0 w-[172px] bg-gray-50 rounded-xl p-4 cursor-pointer border-2 border-transparent hover:border-amber-300 transition-all block">
                ${getMaterialIcon(m.icon)}
                <div class="font-medium text-gray-800">${escapeHtml(getLocalizedTitle(m))}</div>
                <div class="text-xs text-gray-500 mt-1 line-clamp-2">${escapeHtml(getMaterialPreview(m))}</div>
            </a>
        `).join('');

    } catch (e) {
        console.error('Ошибка загрузки материалов:', e);
    }
}

// Получить локализованный заголовок
function getLocalizedTitle(item) {
    const lang = localStorage.getItem('srsk_lang') || 'ru';
    return item[`title_${lang}`] || item.title_en || item.title_ru || '';
}

// Получить превью материала
function getMaterialPreview(material) {
    const lang = localStorage.getItem('srsk_lang') || 'ru';
    const content = material[`content_${lang}`] || material.content_en || material.content_ru || '';
    const text = content.replace(/<[^>]*>/g, '').trim();
    return text.length > 50 ? text.substring(0, 50) + '...' : text;
}

// Получить иконку материала
function getMaterialIcon(iconName) {
    const icons = {
        'map': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>',
        'book': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"/></svg>',
        'clipboard': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>',
        'home': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/></svg>',
        'currency': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
        'question': '<svg class="w-8 h-8 text-gray-600 mb-3" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
    };
    return icons[iconName] || icons['book'];
}

// Загрузить список учителей для автокомплита
async function loadTeachersList() {
    try {
        const { data, error } = await window.portalSupabase
            .from('vaishnavas')
            .select('spiritual_teacher')
            .not('spiritual_teacher', 'is', null)
            .not('spiritual_teacher', 'eq', '');

        if (error) throw error;

        // Уникальные значения
        const teachers = [...new Set(data.map(d => d.spiritual_teacher))].sort();
        const datalist = document.getElementById('teachers-list');
        datalist.innerHTML = teachers.map(t => `<option value="${escapeHtml(t)}">`).join('');
    } catch (e) {
        console.error('Ошибка загрузки учителей:', e);
    }
}

// Инициализация
async function init() {
    // Проверяем параметр view для просмотра чужого профиля
    const urlParams = new URLSearchParams(window.location.search);
    const viewId = urlParams.get('view');

    // Всегда проверяем авторизацию — для отображения в хедере
    const loggedInUser = await PortalAuth.checkGuestAuth();

    if (viewId && loggedInUser && viewId === loggedInUser.id) {
        // Свой профиль через ?view= — редирект на обычный режим
        window.location.replace('index.html');
        return;
    } else if (viewId) {
        // Режим просмотра чужого профиля
        isPublicView = true;

        // Заполняем хедер данными залогиненного пользователя
        if (loggedInUser) {
            document.getElementById('header-name').textContent = getDisplayName(loggedInUser);
            document.getElementById('mobile-name').textContent = getDisplayName(loggedInUser);
            if (loggedInUser.photoUrl) {
                document.getElementById('header-photo').innerHTML =
                    `<img src="${loggedInUser.photoUrl}" alt="" class="w-full h-full object-cover">`;
            }
        }

        await loadPublicProfile(viewId);
    } else if (loggedInUser) {
        // Обычный режим — свой профиль
        populateProfile(loggedInUser);
        initPhotoUpload();
        loadTeachersList();
        loadUpcomingRetreats(loggedInUser.id);
        loadActiveRetreat(loggedInUser.id);
        loadPhotoGalleryPreview(loggedInUser.id);
        loadMaterialsCards();
        document.getElementById('profile-form').addEventListener('submit', handleProfileSave);
    }

    setupPhotoPreviewScroller();
}

// Загрузить публичный профиль другого пользователя
async function loadPublicProfile(vaishnavId) {
    try {
        // Загружаем данные вайшнава
        const { data: vaishnava, error } = await window.portalSupabase
            .from('vaishnavas')
            .select(`
                id,
                first_name,
                last_name,
                spiritual_name,
                phone,
                telegram,
                country,
                city,
                photo_url,
                spiritual_teacher,
                no_spiritual_teacher,
                birth_date,
                is_profile_public
            `)
            .eq('id', vaishnavId)
            .single();

        if (error || !vaishnava) {
            console.error('Ошибка загрузки профиля:', error);
            document.body.innerHTML = '<div class="flex items-center justify-center min-h-screen text-gray-500">Профиль не найден</div>';
            return;
        }

        // Проверяем публичность профиля
        if (vaishnava.is_profile_public === false) {
            document.body.innerHTML = '<div class="flex items-center justify-center min-h-screen text-gray-500">Профиль скрыт пользователем</div>';
            return;
        }

        // Скрываем скелетоны
        document.getElementById('profile-skeleton').classList.add('hidden');
        document.getElementById('profile-card').classList.remove('hidden');
        document.getElementById('retreat-skeleton').classList.add('hidden');

        // Заполняем профиль
        const guest = {
            id: vaishnava.id,
            firstName: vaishnava.first_name,
            lastName: vaishnava.last_name,
            spiritualName: vaishnava.spiritual_name,
            phone: vaishnava.phone,
            telegram: vaishnava.telegram,
            country: vaishnava.country,
            city: vaishnava.city,
            photoUrl: vaishnava.photo_url,
            spiritualTeacher: vaishnava.spiritual_teacher,
            noSpiritualTeacher: vaishnava.no_spiritual_teacher || false,
            birthDate: vaishnava.birth_date
        };

        populateProfile(guest);

        // Скрываем элементы редактирования (в публичном профиле нельзя редактировать)
        document.getElementById('profile-edit-btn')?.classList.add('hidden');
        document.getElementById('profile-completeness')?.classList.add('hidden');

        // Загружаем ретриты и трансферы этого пользователя
        loadActiveRetreat(vaishnava.id);

        // Загружаем ближайшие ретриты (исключая те, на которые уже зарегистрирован)
        loadUpcomingRetreats(vaishnava.id);

        // Загружаем материалы
        loadMaterialsCards();

    } catch (e) {
        console.error('Ошибка:', e);
        document.body.innerHTML = '<div class="flex items-center justify-center min-h-screen text-gray-500">Ошибка загрузки</div>';
    }
}

// ==================== PHOTO GALLERY PREVIEW ====================
async function loadPhotoGalleryPreview(vaishnavId) {
    try {
        const supabase = window.portalSupabase;
        if (!supabase) {
            console.error('Supabase client not initialized');
            return;
        }

        // Get user's retreats
        const { data: registrations, error: regError } = await supabase
            .from('retreat_registrations')
            .select('retreat_id')
            .eq('vaishnava_id', vaishnavId)
            .in('status', ['guest', 'team']);

        if (regError || !registrations || registrations.length === 0) {
            // Нет ретритов - скрыть весь блок галереи
            const galleryBlock = document.getElementById('galleryPreview');
            if (galleryBlock && galleryBlock.parentElement) {
                galleryBlock.parentElement.style.display = 'none';
            }
            return;
        }

        const retreatIds = registrations.map(r => r.retreat_id);

        // TODO Фаза 2: Load photos with user's face first
        // const { data: myPhotoIds } = await supabase
        //     .from('face_tags')
        //     .select('photo_id')
        //     .eq('vaishnava_id', vaishnavId);
        // const myPhotos = myPhotoIds?.map(t => t.photo_id) || [];

        // Get total count
        const { count: totalCount } = await supabase
            .from('retreat_photos')
            .select('id', { count: 'exact', head: true })
            .in('retreat_id', retreatIds)
            .eq('index_status', 'indexed');

        // Load retreat details
        const { data: retreatsData, error: retreatsError } = await supabase
            .from('retreats')
            .select('id, name_ru, name_en, name_hi')
            .in('id', retreatIds);

        if (retreatsError) {
            console.error('Error loading retreats:', retreatsError);
            return;
        }

        const retreatsMap = {};
        (retreatsData || []).forEach(r => {
            retreatsMap[r.id] = r;
        });

        // Load my photos (with face tags) first if any, then fill with other photos
        let myPhotoIds = [];
        if (window.currentGuest && window.currentGuest.id) {
            const { data: myPhotoData } = await supabase
                .from('face_tags')
                .select('photo_id')
                .eq('vaishnava_id', window.currentGuest.id);

            myPhotoIds = myPhotoData?.map(t => t.photo_id) || [];
            console.debug('[gallery] myPhotoIds loaded:', myPhotoIds.length);
        } else {
            console.debug('[gallery] currentGuest missing, skipping myPhotoIds');
        }

        let photos = [];
        if (myPhotoIds.length > 0) {
            // First, load photos with user's face, limited to user's retreats
            const { data: myPhotos, error: myPhotosError } = await supabase
                .from('retreat_photos')
                .select('id, storage_path, thumb_path, retreat_id, uploaded_at')
                .in('id', myPhotoIds)
                .in('retreat_id', retreatIds)
                .eq('index_status', 'indexed')
                .order('uploaded_at', { ascending: false })
                .limit(10);

            if (myPhotosError) {
                console.error('Error loading my photos:', myPhotosError);
            } else {
                photos = myPhotos || [];
            }

            const remaining = Math.max(0, 10 - photos.length);
            if (remaining > 0) {
                const notInIds = myPhotoIds.map(id => `"${String(id)}"`).join(',');
                const { data: otherPhotos, error: otherError } = await supabase
                    .from('retreat_photos')
                    .select('id, storage_path, thumb_path, retreat_id, uploaded_at')
                    .in('retreat_id', retreatIds)
                    .eq('index_status', 'indexed')
                    .not('id', 'in', `(${notInIds})`)
                    .order('uploaded_at', { ascending: false })
                    .limit(remaining);

                if (otherError) {
                    console.error('Error loading other photos:', otherError);
                } else {
                    photos = photos.concat(otherPhotos || []);
                }
            }
        } else {
            // No face tags: just show recent photos from user's retreats
            const { data: recentPhotos, error: photosError } = await supabase
                .from('retreat_photos')
                .select('id, storage_path, thumb_path, retreat_id, uploaded_at')
                .in('retreat_id', retreatIds)
                .eq('index_status', 'indexed')
                .order('uploaded_at', { ascending: false })
                .limit(10);

            if (photosError) {
                console.error('Error loading photos:', photosError);
                return;
            }
            photos = recentPhotos || [];
        }

        // Add retreat info to photos (даже если пусто — для заглушки)
        const photosWithRetreats = photos && photos.length > 0
            ? photos.map((photo, idx) => ({
                ...photo,
                _idx: idx,
                retreat: retreatsMap[photo.retreat_id]
            }))
            : [];

        console.debug('[gallery] photos final count:', photosWithRetreats.length);
        renderPhotoPreview(photosWithRetreats, totalCount || photosWithRetreats.length, myPhotoIds);
    } catch (e) {
        console.error('Error loading photo gallery preview:', e);
    }
}

function renderPhotoPreview(photos, totalCount, myPhotoIds = []) {
    const container = document.getElementById('photoPreviewContainer');
    const titleEl = document.getElementById('galleryTitle');
    const prevBtn = document.getElementById('photoPreviewPrev');
    const nextBtn = document.getElementById('photoPreviewNext');
    const lang = localStorage.getItem('language') || 'ru';
    const myPhotoIdSet = new Set(myPhotoIds.map(id => String(id)));

    // Заглушка, если нет фото
    if (!photos || photos.length === 0) {
        if (titleEl) {
            titleEl.textContent = 'Фотографии ретрита';
        }

        // Скрыть кнопки навигации
        if (prevBtn) prevBtn.classList.add('hidden');
        if (nextBtn) nextBtn.classList.add('hidden');

        container.innerHTML = `
            <div class="w-full flex flex-col items-center justify-center py-12 px-4">
                <svg class="w-20 h-20 text-blue-200 mb-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
                </svg>
                <div class="text-gray-400 text-center mb-2 font-medium">Пока нет фотографий</div>
                <div class="text-gray-400 text-sm text-center">Фотографии появятся после вашего ретрита</div>
            </div>
        `;
        return;
    }

    // Update title with count
    if (titleEl) {
        const text = totalCount === 1 ? '1 фотография' : `${totalCount} фотографий`;
        titleEl.textContent = text;
    }

    container.innerHTML = photos.map(photo => {
        const url = getPhotoStorageUrl(photo.thumb_path || photo.storage_path);
        const retreatName = photo.retreat ? (photo.retreat[`name_${lang}`] || photo.retreat.name_ru) : '';
        const isMine = myPhotoIdSet.has(String(photo.id));

        return `
            <div class="flex-shrink-0 w-64 h-44 rounded-xl overflow-hidden cursor-pointer hover:scale-[1.02] transition-transform snap-start relative group">
                <img src="${url}" alt="Photo" class="w-full h-full object-cover">
                ${isMine ? '<div class="absolute top-2 right-2 bg-srsk-orange text-white text-xs px-2 py-1 rounded-full font-medium">Вы</div>' : ''}
                <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <div class="text-white text-sm truncate">${escapeHtml(retreatName)}</div>
                </div>
            </div>
        `;
    }).join('');

    // Обновить видимость стрелок
    setupPhotoPreviewScroller();
}

function setupPhotoPreviewScroller() {
    const container = document.getElementById('photoPreviewContainer');
    const prevBtn = document.getElementById('photoPreviewPrev');
    const nextBtn = document.getElementById('photoPreviewNext');
    if (!container) return;

    const scrollByAmount = () => Math.max(200, Math.round(container.clientWidth * 0.9));
    const updateArrowVisibility = () => {
        if (!prevBtn || !nextBtn) return;
        const maxScrollLeft = container.scrollWidth - container.clientWidth;
        const atStart = container.scrollLeft <= 1;
        const atEnd = container.scrollLeft >= maxScrollLeft - 1;
        prevBtn.classList.toggle('hidden', atStart);
        nextBtn.classList.toggle('hidden', atEnd);
    };

    if (prevBtn && !prevBtn.dataset.bound) {
        prevBtn.dataset.bound = '1';
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            container.scrollBy({ left: -scrollByAmount(), behavior: 'smooth' });
        });
    }

    if (nextBtn && !nextBtn.dataset.bound) {
        nextBtn.dataset.bound = '1';
        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            container.scrollBy({ left: scrollByAmount(), behavior: 'smooth' });
        });
    }

    if (!container.dataset.arrowBound) {
        container.dataset.arrowBound = '1';
        container.addEventListener('scroll', updateArrowVisibility, { passive: true });
        window.addEventListener('resize', updateArrowVisibility);
        requestAnimationFrame(updateArrowVisibility);
    }
}

function getPhotoStorageUrl(storagePath) {
    const supabase = window.portalSupabase;
    if (!supabase) return '';

    const { data } = supabase.storage
        .from('retreat-photos')
        .getPublicUrl(storagePath);
    return data.publicUrl;
}

/**
 * Telegram Bot Integration
 */

// Перезагрузить профиль гостя
async function loadGuestProfile() {
    try {
        const loggedInUser = await PortalAuth.checkGuestAuth();
        if (!loggedInUser) return;

        window.currentGuest = loggedInUser;
        populateProfile(loggedInUser);

        // Обновляем статус Telegram после перезагрузки профиля
        await checkTelegramStatus();

        console.log('Profile reloaded, telegram_chat_id:', loggedInUser.telegram_chat_id);
    } catch (err) {
        console.error('Error reloading profile:', err);
    }
}

// Проверка статуса подключения Telegram
async function checkTelegramStatus() {
    const guest = window.currentGuest;
    if (!guest) return;

    const connected = !!guest.telegram_chat_id;

    // Показываем/скрываем элементы в зависимости от статуса
    const connectedEl = document.getElementById('telegram-connected');
    const connectBtn = document.getElementById('telegram-connect-btn');
    const disconnectBtn = document.getElementById('telegram-disconnect-btn');

    if (connected) {
        connectedEl.classList.remove('hidden');
        connectedEl.classList.add('flex');
        connectBtn.classList.add('hidden');
        disconnectBtn.classList.remove('hidden');
    } else {
        connectedEl.classList.add('hidden');
        connectedEl.classList.remove('flex');
        connectBtn.classList.remove('hidden');
        disconnectBtn.classList.add('hidden');
    }
}

// Подключить Telegram уведомления
async function connectTelegram() {
    const guest = window.currentGuest;
    if (!guest?.id) {
        PortalLayout.showNotification('Ошибка загрузки профиля', 'error');
        return;
    }

    try {
        // Генерируем одноразовый токен с TTL 15 минут
        const token = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

        const { data, error } = await window.portalSupabase
            .from('telegram_link_tokens')
            .insert({
                token,
                vaishnava_id: guest.id,
                expires_at: expiresAt,
                used: false
            })
            .select()
            .single();

        if (error) {
            console.error('Error creating telegram token:', error);
            PortalLayout.showNotification('Ошибка создания ссылки', 'error');
            return;
        }

        // Получаем имя бота из конфига
        const botName = window.PORTAL_CONFIG?.TELEGRAM_BOT_NAME || 'rupaseva_bot';
        const deepLink = `https://t.me/${botName}?start=${token}`;

        // Показываем модальное окно с ссылкой
        showTelegramLinkModal(deepLink, token);

    } catch (err) {
        console.error('Error connecting telegram:', err);
        PortalLayout.showNotification('Ошибка подключения', 'error');
    }
}

// Показать модальное окно с deep link
function showTelegramLinkModal(deepLink, token) {
    const modal = document.getElementById('telegramLinkModal');
    if (!modal) return;

    document.getElementById('telegram-deep-link').href = deepLink;
    document.getElementById('telegram-deep-link').textContent = deepLink;

    // QR код (опционально, можно добавить библиотеку qrcode.js позже)
    // const qrContainer = document.getElementById('telegram-qr-code');
    // new QRCode(qrContainer, deepLink);

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Polling для проверки использования токена
    const pollInterval = setInterval(async () => {
        const { data, error } = await window.portalSupabase
            .from('telegram_link_tokens')
            .select('used')
            .eq('token', token)
            .single();

        if (error) {
            console.warn('Polling error:', error);
            clearInterval(pollInterval);
            return;
        }

        console.log('Polling token status:', data);

        if (data && data.used) {
            console.log('Token used! Updating profile...');
            clearInterval(pollInterval);
            closeTelegramLinkModal();

            // Обновляем профиль
            await loadGuestProfile();

            PortalLayout.showNotification('Telegram успешно подключён!', 'success');
        }
    }, 3000); // Проверяем каждые 3 секунды

    // Останавливаем polling через 15 минут (токен истекает)
    setTimeout(() => clearInterval(pollInterval), 15 * 60 * 1000);
}

function closeTelegramLinkModal() {
    const modal = document.getElementById('telegramLinkModal');
    if (!modal) return;

    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

// Отключить Telegram уведомления
async function disconnectTelegram() {
    const guest = window.currentGuest;
    if (!guest?.id) {
        PortalLayout.showNotification('Ошибка загрузки профиля', 'error');
        return;
    }

    if (!confirm('Отключить Telegram уведомления?')) {
        return;
    }

    try {
        const { error } = await window.portalSupabase
            .from('vaishnavas')
            .update({ telegram_chat_id: null })
            .eq('id', guest.id);

        if (error) {
            console.error('Error disconnecting telegram:', error);
            PortalLayout.showNotification('Ошибка отключения', 'error');
            return;
        }

        // Обновляем локальный кеш
        window.currentGuest.telegram_chat_id = null;

        // Обновляем UI
        await checkTelegramStatus();

        PortalLayout.showNotification('Telegram уведомления отключены', 'success');

    } catch (err) {
        console.error('Error disconnecting telegram:', err);
        PortalLayout.showNotification('Ошибка отключения', 'error');
    }
}

init();
