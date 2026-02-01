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
    const date = new Date(dateStr);
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
    const start = new Date(startDate);
    const end = new Date(endDate);
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
            ${transfer.taxi_driver_info ? `<div class="text-xs text-gray-500 mt-1">${transfer.taxi_driver_info}</div>` : ''}
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

    } catch (e) {
        console.error('Ошибка загрузки ретрита:', e);
        // Скрываем скелетон даже при ошибке
        document.getElementById('retreat-skeleton').classList.add('hidden');
        document.getElementById('no-retreat-block').classList.remove('hidden');
    }
}

// Загрузить ближайшие ретриты
async function loadUpcomingRetreats() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const { data, error } = await window.portalSupabase
            .from('retreats')
            .select('id, name_ru, start_date, end_date, description_ru, image_url, registration_open')
            .gte('start_date', today)
            .order('start_date')
            .limit(3);

        if (error) throw error;

        const container = document.getElementById('upcoming-retreats');
        if (!data || data.length === 0) {
            container.innerHTML = '<div class="col-span-3 text-center text-gray-500 py-8">Нет запланированных ретритов</div>';
            return;
        }

        container.innerHTML = data.map(retreat => `
            <a href="retreat.html?id=${retreat.id}" class="bg-white rounded-xl overflow-hidden border-2 border-transparent hover:border-[#6B5B95] transition-all flex group">
                <div class="w-28 bg-gray-100 flex-shrink-0 flex items-center justify-center overflow-hidden">
                    ${retreat.image_url
                        ? `<img src="${retreat.image_url}" alt="" class="w-full h-full object-cover">`
                        : `<img src="images/tilak-placeholder.svg" alt="" class="w-12 h-12 opacity-30">`
                    }
                </div>
                <div class="p-3 flex flex-col flex-1">
                    <div class="text-xs text-srsk-green font-medium">${formatRetreatDates(retreat.start_date, retreat.end_date)}</div>
                    <div class="font-medium text-gray-800 text-sm mt-1">${retreat.name_ru}</div>
                    <div class="text-xs text-gray-500 mt-1 line-clamp-2">${retreat.description_ru || ''}</div>
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
        datalist.innerHTML = teachers.map(t => `<option value="${t}">`).join('');
    } catch (e) {
        console.error('Ошибка загрузки учителей:', e);
    }
}

// Инициализация
async function init() {
    // Проверяем параметр view для просмотра чужого профиля
    const urlParams = new URLSearchParams(window.location.search);
    const viewId = urlParams.get('view');

    console.log('[Portal] URL:', window.location.href);
    console.log('[Portal] viewId:', viewId);

    // Всегда проверяем авторизацию — для отображения в хедере
    const loggedInUser = await PortalAuth.checkGuestAuth();

    if (viewId) {
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
        loadUpcomingRetreats();
        loadActiveRetreat(loggedInUser.id);
        document.getElementById('profile-form').addEventListener('submit', handleProfileSave);
    }
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

        // Загружаем ближайшие ретриты
        loadUpcomingRetreats();

    } catch (e) {
        console.error('Ошибка:', e);
        document.body.innerHTML = '<div class="flex items-center justify-center min-h-screen text-gray-500">Ошибка загрузки</div>';
    }
}

init();
