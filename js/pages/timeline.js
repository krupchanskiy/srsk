// Шахматка проживания — Timeline Module
// Вынесено из placement/timeline.html

// Конфигурация
const DAYS_TO_SHOW = 90; // 3 месяца
const CELL_WIDTH = 24;   // ширина половины дня
const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);

// Состояние сворачивания
const collapsedBuildings = new Set();
const collapsedRooms = new Set();

// Данные из БД
let timelineData = {
    retreats: [],
    buildings: []
};

// Справочники для форм
let categories = [];
let vaishnavas = [];

// Хранилище гостей для кликов
let guestsMap = new Map();

// Хранилище уборок для кликов
let cleaningsMap = new Map();

// Флаг права на редактирование таймлайна
const canEditTimeline = () => window.hasPermission?.('edit_timeline') ?? false;

// Базовая дата (сегодня минус 2 дня)
let baseDate = new Date();
baseDate.setHours(0, 0, 0, 0);
baseDate.setDate(baseDate.getDate() - 2);

// Индекс сегодняшнего дня относительно baseDate
const TODAY_INDEX = 2;

// Преобразовать дату в dayIndex относительно baseDate
function dateToDayIndex(dateStr) {
    const date = DateUtils.parseDate(dateStr);
    date.setHours(0, 0, 0, 0);
    const diff = date - baseDate;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// Загрузка данных из БД
async function loadTimelineData() {
    const endDate = new Date(baseDate);
    endDate.setDate(endDate.getDate() + DAYS_TO_SHOW);
    const startDateStr = formatDateYMD(baseDate);
    const endDateStr = formatDateYMD(endDate);

    // Загружаем параллельно
    const [buildingsData, roomsRes, residentsRes, retreatsRes, cleaningsRes] = await Promise.all([
        Cache.getOrLoad('buildings', async () => {
            const { data, error } = await Layout.db.from('buildings')
                .select('*, building_types(id, slug, color, name_ru, name_en, name_hi)')
                .eq('is_active', true)
                .order('sort_order');
            if (error) { console.error('Error loading buildings:', error); return null; }
            return data;
        }),
        Layout.db.from('rooms')
            .select('id, number, floor, building_id, capacity, status, plan_x, plan_y, plan_width, plan_height')
            .eq('is_active', true)
            .order('building_id')
            .order('floor')
            .order('number'),
        Layout.db.from('residents')
            .select(`*,
                resident_categories(id, name_ru, name_en, name_hi, color),
                vaishnavas(id, first_name, last_name, spiritual_name),
                bookings(id, name, contact_name)`)
            .in('status', ['confirmed', 'checked_out'])
            .lte('check_in', endDateStr)
            .or(`check_out.is.null,check_out.gte.${startDateStr}`),
        Layout.db.from('retreats')
            .select('id, name_ru, name_en, name_hi, start_date, end_date, color')
            .lte('start_date', endDateStr)
            .gte('end_date', startDateStr)
            .order('start_date'),
        Layout.db.from('room_cleanings')
            .select('id, room_id, start_date, end_date, type, completed, completed_at')
            .lte('start_date', endDateStr)
            .gte('end_date', startDateStr)
    ]);

    if (roomsRes.error) console.error('Error loading rooms:', roomsRes.error);
    if (residentsRes.error) console.error('Error loading residents:', residentsRes.error);
    if (retreatsRes.error) console.error('Error loading retreats:', retreatsRes.error);
    if (cleaningsRes.error) console.error('Error loading cleanings:', cleaningsRes.error);

    let buildings = buildingsData || [];
    const rooms = roomsRes.data || [];
    const residents = residentsRes.data || [];
    const retreats = retreatsRes.data || [];
    const cleanings = cleaningsRes.data || [];

    // Фильтруем временные здания по датам шахматки
    buildings = buildings.filter(b => {
        // Постоянные здания показываем всегда
        if (!b.is_temporary) return true;
        // Временные — только если период аренды пересекается с диапазоном шахматки
        return b.available_from <= endDateStr && b.available_until >= startDateStr;
    });

    // Сортируем: сначала постоянные, потом временные (внутри — по sort_order)
    buildings.sort((a, b) => (a.is_temporary ? 1 : 0) - (b.is_temporary ? 1 : 0) || (a.sort_order || 0) - (b.sort_order || 0));

    // Очищаем хранилища
    guestsMap.clear();
    cleaningsMap.clear();

    // Преобразуем ретриты
    timelineData.retreats = retreats.map(r => {
        const rawStartDay = dateToDayIndex(r.start_date);
        const rawEndDay = dateToDayIndex(r.end_date);
        return {
            name: Layout.getName(r),
            startDay: Math.max(0, rawStartDay),
            endDay: Math.min(DAYS_TO_SHOW - 1, rawEndDay),
            rawStartDay,
            rawEndDay
        };
    }).filter(r => r.rawStartDay <= DAYS_TO_SHOW - 1 && r.rawEndDay >= 0);

    // Группируем комнаты по зданиям
    const roomsByBuilding = {};
    rooms.forEach(room => {
        if (!roomsByBuilding[room.building_id]) {
            roomsByBuilding[room.building_id] = [];
        }
        roomsByBuilding[room.building_id].push(room);
    });

    // Сортируем номера числовым способом (1, 2, 3, 10, 11, а не 1, 10, 11, 2, 3)
    Object.values(roomsByBuilding).forEach(roomList => {
        roomList.sort((a, b) => {
            // Сначала по этажу
            if (a.floor !== b.floor) return (a.floor || 0) - (b.floor || 0);
            // Потом по номеру (натуральная сортировка)
            return a.number.localeCompare(b.number, undefined, { numeric: true });
        });
    });

    // Группируем резидентов по комнатам (исключаем самостоятельное размещение)
    const residentsByRoom = {};
    residents.forEach(res => {
        // Skip self-accommodation (NULL room_id)
        if (!res.room_id) return;

        if (!residentsByRoom[res.room_id]) {
            residentsByRoom[res.room_id] = [];
        }
        residentsByRoom[res.room_id].push(res);
    });

    // Группируем ручные уборки по комнатам
    const cleaningsByRoom = {};
    cleanings.forEach(c => {
        if (!cleaningsByRoom[c.room_id]) {
            cleaningsByRoom[c.room_id] = [];
        }
        cleaningsByRoom[c.room_id].push(c);
    });

    // Формируем структуру данных
    timelineData.buildings = buildings.map(building => {
        const buildingRooms = roomsByBuilding[building.id] || [];

        return {
            id: building.id,
            name: Layout.getName(building),
            isTemporary: building.is_temporary || false,
            availableFromDay: building.available_from ? dateToDayIndex(building.available_from) : null,
            availableUntilDay: building.available_until ? dateToDayIndex(building.available_until) : null,
            rooms: buildingRooms.map(room => {
                const capacity = room.capacity || 1;
                const roomResidents = residentsByRoom[room.id] || [];

                // Создаём виртуальные места
                const beds = [];
                for (let i = 0; i < capacity; i++) {
                    beds.push({
                        name: capacity === 1 ? '' : `${i + 1}`,
                        roomId: room.id,
                        bedIndex: i,
                        guests: []
                    });
                }

                // Массив уборок на уровне комнаты
                const roomCleaningsList = [];

                // Распределяем резидентов по местам
                // Сортируем по дате заселения
                roomResidents.sort((a, b) => DateUtils.parseDate(a.check_in) - DateUtils.parseDate(b.check_in));

                roomResidents.forEach(res => {
                    const startDay = Math.max(0, dateToDayIndex(res.check_in));
                    const endDay = res.check_out
                        ? Math.min(DAYS_TO_SHOW - 1, dateToDayIndex(res.check_out))
                        : DAYS_TO_SHOW - 1;

                    if (startDay > DAYS_TO_SHOW - 1 || endDay < 0) return;

                    // Получаем имя резидента
                    let guestName = res.guest_name || '';
                    if (res.vaishnavas) {
                        guestName = getVaishnavName(res.vaishnavas, '');
                    }
                    // Если это бронирование - показываем название брони или имя контакта
                    if (!guestName && res.bookings) {
                        guestName = res.bookings.name || res.bookings.contact_name || '';
                    }

                    // Определяем, это бронирование или заселение
                    // Бронирование = есть booking_id, но нет реального гостя (vaishnava или guest_name)
                    const isBooking = res.booking_id && !res.vaishnava_id && !res.guest_name;

                    // Получаем цвет категории
                    const category = res.resident_categories;
                    const color = category?.color || '#3b82f6';
                    // Делаем border темнее
                    const border = color;

                    // Ранний заезд = обе половины дня заезда (startHalf = 0)
                    // Обычный заезд = только вторая половина (startHalf = 1)
                    // Поздний выезд = обе половины дня выезда (endHalf = 1)
                    // Обычный выезд = только первая половина (endHalf = 0)
                    let startHalf = res.early_checkin === true ? 0 : 1;
                    let endHalf = res.late_checkout === true ? 1 : 0;

                    // Если заезд и выезд в один день, корректируем чтобы span был минимум 1
                    if (startDay === endDay && startHalf > endHalf) {
                        // Показываем хотя бы одну половину
                        endHalf = startHalf;
                    }

                    const guest = {
                        id: res.id,
                        name: guestName || '—',
                        startDay,
                        startHalf,
                        endDay,
                        endHalf,
                        color,
                        border,
                        isBooking,
                        isCheckedOut: res.status === 'checked_out',
                        // Сырые данные для модалки
                        rawData: res
                    };

                    // Уборка после выезда (не для временных зданий)
                    // Обычный выезд (endHalf=0): уборка со второй половины дня выезда
                    // Поздний выезд (endHalf=1): уборка с первой половины СЛЕДУЮЩЕГО дня
                    // ВАЖНО: уборка создаётся только если нет пересекающихся проживаний с более поздним выездом
                    let cleaningEntry = null;
                    const hasOthersStayingLonger = roomResidents.some(other => {
                        if (other.id === res.id) return false;
                        // Проверяем пересечение периодов проживания
                        const overlaps = other.check_in < res.check_out &&
                                         (other.check_out === null || other.check_out > res.check_in);
                        // И что другой выезжает позже
                        const staysLonger = other.check_out === null || other.check_out > res.check_out;
                        return overlaps && staysLonger;
                    });
                    if (res.check_out && !building.isTemporary && !hasOthersStayingLonger) {
                        let cleaningStartDay, cleaningStartHalf, cleaningEndDay, cleaningEndHalf;

                        if (endHalf === 0) {
                            // Обычный выезд — уборка начинается во второй половине дня выезда
                            cleaningStartDay = endDay;
                            cleaningStartHalf = 1;
                            cleaningEndDay = endDay + 1;
                            cleaningEndHalf = 0;
                        } else {
                            // Поздний выезд — уборка начинается на следующий день
                            cleaningStartDay = endDay + 1;
                            cleaningStartHalf = 0;
                            cleaningEndDay = endDay + 1;
                            cleaningEndHalf = 1;
                        }

                        // Если уборка попадает в диапазон отображения — показываем (выполненные тоже, но не удалённые)
                        if (cleaningStartDay < DAYS_TO_SHOW && !res.cleaning_skipped) {
                            const autoCleaningId = 'cleaning-' + res.id;
                            cleaningEntry = {
                                id: autoCleaningId,
                                cleaningId: autoCleaningId,
                                residentId: res.id, // для обновления cleaning_done
                                name: '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>',
                                startDay: cleaningStartDay,
                                startHalf: cleaningStartHalf,
                                endDay: Math.min(cleaningEndDay, DAYS_TO_SHOW - 1),
                                endHalf: cleaningEndDay >= DAYS_TO_SHOW ? 1 : cleaningEndHalf,
                                isCleaning: true,
                                isAutoCleaning: true,
                                isCompleted: res.cleaning_done || false,
                                rawData: {
                                    room_id: room.id,
                                    start_date: formatDateYMD(getDateForDay(cleaningStartDay)),
                                    end_date: formatDateYMD(getDateForDay(cleaningEndDay))
                                }
                            };
                        }
                    }

                    // Ищем свободное место для этого периода
                    let placed = false;
                    let placedBed = null;
                    for (const bed of beds) {
                        const hasOverlap = bed.guests.some(g => {
                            if (g.isCleaning) return false; // Уборка не блокирует
                            const gStart = g.startDay * 2 + g.startHalf;
                            const gEnd = g.endDay * 2 + g.endHalf;
                            const rStart = guest.startDay * 2 + guest.startHalf;
                            const rEnd = guest.endDay * 2 + guest.endHalf;
                            return !(rEnd < gStart || rStart > gEnd);
                        });

                        if (!hasOverlap) {
                            bed.guests.push(guest);
                            // Сохраняем в хранилище с контекстом
                            guestsMap.set(guest.id, { ...guest, buildingName: Layout.getName(building), roomName: room.number });
                            placedBed = bed;
                            placed = true;
                            break;
                        }
                    }

                    // Если не нашли место, добавляем в первое (будет визуальное наложение)
                    if (!placed && beds.length > 0) {
                        beds[0].guests.push(guest);
                        guestsMap.set(guest.id, { ...guest, buildingName: Layout.getName(building), roomName: room.number });
                        placedBed = beds[0];
                    }

                    // Добавляем автоуборку в cleaningsMap (не в beds!)
                    if (cleaningEntry) {
                        cleaningsMap.set(cleaningEntry.id, {
                            ...cleaningEntry,
                            roomId: room.id,
                            buildingName: Layout.getName(building),
                            roomName: room.number,
                            isAuto: true,
                            residentId: res.id
                        });
                        roomCleaningsList.push(cleaningEntry);
                    }
                });

                // Добавляем ручные уборки
                const roomCleanings = cleaningsByRoom[room.id] || [];
                roomCleanings.forEach(c => {
                    const startDay = Math.max(0, dateToDayIndex(c.start_date));
                    const endDay = Math.min(DAYS_TO_SHOW - 1, dateToDayIndex(c.end_date));

                    if (startDay > DAYS_TO_SHOW - 1 || endDay < 0) return;

                    // Определяем половины дня:
                    // - bedding: только первая половина дня (0-0)
                    // - cleaning с start_date === end_date: обе половины одного дня (0-1)
                    // - cleaning с end_date = start_date + 1: вторая половина первого + первая второго (1-0)
                    const isBedding = c.type === 'bedding';
                    const sameDay = c.start_date === c.end_date;
                    let startHalf, endHalf;
                    if (isBedding) {
                        startHalf = 0;
                        endHalf = 0; // только первая половина
                    } else if (sameDay) {
                        startHalf = 0;
                        endHalf = 1;
                    } else {
                        startHalf = 1;
                        endHalf = 0;
                    }

                    // Иконка зависит от типа
                    const icon = isBedding
                        ? '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16"/></svg>'
                        : '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z"/></svg>';

                    const cleaningEntry = {
                        id: 'manual-cleaning-' + c.id,
                        cleaningId: c.id,
                        name: icon,
                        type: c.type || 'cleaning',
                        startDay,
                        startHalf,
                        endDay,
                        endHalf,
                        isCleaning: true,
                        isManualCleaning: true,
                        isCompleted: c.completed || false,
                        rawData: c
                    };

                    // Сохраняем в хранилище с контекстом
                    cleaningsMap.set(c.id, {
                        ...cleaningEntry,
                        roomId: room.id,
                        buildingName: Layout.getName(building),
                        roomName: room.number
                    });

                    roomCleaningsList.push(cleaningEntry);
                });

                return {
                    id: room.id,
                    name: room.number,
                    beds,
                    cleanings: roomCleaningsList // Уборки на уровне комнаты
                };
            })
        };
    }).filter(b => b.rooms.length > 0);
}

// Получить дату для дня
function getDateForDay(dayIndex) {
    const date = new Date(baseDate);
    date.setDate(baseDate.getDate() + dayIndex);
    return date;
}

// Проверка выходного
function isWeekend(dayIndex) {
    const date = getDateForDay(dayIndex);
    const day = date.getDay();
    return day === 0 || day === 6;
}

// Получить день недели
function getWeekdayName(dayIndex) {
    const days = DateUtils.dayNamesShort[Layout.currentLang] || DateUtils.dayNamesShort.ru;
    const date = getDateForDay(dayIndex);
    return days[date.getDay()];
}

// Переключить сворачивание здания
function toggleBuilding(buildingId) {
    if (collapsedBuildings.has(buildingId)) {
        collapsedBuildings.delete(buildingId);
    } else {
        collapsedBuildings.add(buildingId);
    }
    renderTable();
}

// Переключить сворачивание номера
function toggleRoom(roomId) {
    if (collapsedRooms.has(roomId)) {
        collapsedRooms.delete(roomId);
    } else {
        collapsedRooms.add(roomId);
    }
    renderTable();
}

// Свернуть все номера (здания остаются развёрнутыми)
function collapseAllRooms() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    timelineData.buildings.forEach(building => {
        building.rooms.forEach(room => {
            collapsedRooms.add(room.id);
        });
    });
    renderTable();
}

// Свернуть всё (включая здания)
function collapseAllBuildings() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    timelineData.buildings.forEach(building => {
        collapsedBuildings.add(building.id);
        building.rooms.forEach(room => {
            collapsedRooms.add(room.id);
        });
    });
    renderTable();
}

// Развернуть всё
function expandAll() {
    collapsedBuildings.clear();
    collapsedRooms.clear();
    renderTable();
}

// Текущий контекст модалки
let modalContext = null;

// Форматировать дату для input[type="date"]
function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Открыть модалку действий
function openActionModal(dayIndex, roomId, buildingName, roomName, bedName, halfIndex = 0) {
    // Проверка прав на редактирование
    if (!canEditTimeline()) return;

    const checkInDate = getDateForDay(dayIndex);
    const checkOutDate = getDateForDay(dayIndex + 1);

    // Сохраняем контекст (сбрасываем флаг конвертации)
    modalContext = { dayIndex, halfIndex, roomId, buildingName, roomName, bedName, isConversion: false };

    // Заполняем поля
    const location = bedName
        ? `${buildingName} → ${roomName} → ${t('timeline_bed')} ${bedName}`
        : `${buildingName} → ${roomName}`;
    document.getElementById('modalLocation').textContent = location;
    document.getElementById('modalCheckIn').value = formatDateForInput(checkInDate);
    document.getElementById('modalCheckOut').value = formatDateForInput(checkOutDate);

    // Показываем экран выбора действия
    showActionScreen();

    // Открываем модалку
    document.getElementById('actionModal').showModal();
}

// Загрузка справочников
async function loadDictionaries() {
    const [catData, vaishnavasRes] = await Promise.all([
        Cache.getOrLoad('resident_categories', async () => {
            const { data, error } = await Layout.db.from('resident_categories').select('*').order('sort_order');
            if (error) { console.error('Error loading resident_categories:', error); return null; }
            return (data || []).filter(c => (c.sort_order || 0) < 999);
        }),
        Utils.fetchAll((from, to) => Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name, gender, phone, birth_date').eq('is_deleted', false).order('spiritual_name').range(from, to))
    ]);
    categories = catData || [];
    vaishnavas = vaishnavasRes.data || [];

    // Заполняем категории
    const catSelect = document.getElementById('checkinCategory');
    catSelect.innerHTML = '<option value="">—</option>' +
        categories.map(c => `<option value="${c.id}">${Layout.getName(c)}</option>`).join('');

    // Рендерим легенду
    renderLegend();
}

// Легенда цветов
function renderLegend() {
    const legend = document.getElementById('legend');

    // Категории заселений
    const categoriesHtml = categories.map(c => {
        const color = c.color || '#3b82f6';
        return `<div class="flex items-center gap-1.5">
            <span class="w-4 h-4 rounded" style="background: ${color}; border: 1px solid rgba(0,0,0,0.15);"></span>
            <span class="text-sm text-gray-600">${Layout.getName(c)}</span>
        </div>`;
    }).join('');

    // Бронирования (штриховка)
    const bookingHtml = `<div class="flex items-center gap-1.5">
        <span class="w-4 h-4 rounded" style="background: repeating-linear-gradient(45deg, #3b82f6, #3b82f6 2px, rgba(255,255,255,0.5) 2px, rgba(255,255,255,0.5) 4px); border: 1px dashed rgba(0,0,0,0.3);"></span>
        <span class="text-sm text-gray-600">${t('timeline_booking')}</span>
    </div>`;

    // Уборка и бельё
    const cleaningHtml = `<div class="flex items-center gap-1.5">
        <span class="w-4 h-4 rounded" style="background: #9ca3af;"></span>
        <span class="text-sm text-gray-600">${t('timeline_cleaning')}</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span class="w-4 h-4 rounded" style="background: #06b6d4;"></span>
        <span class="text-sm text-gray-600">${t('timeline_bedding')}</span>
    </div>
    <div class="flex items-center gap-1.5">
        <span class="w-4 h-4 rounded" style="background: #22c55e;"></span>
        <span class="text-sm text-gray-600">${t('timeline_done')}</span>
    </div>`;

    legend.innerHTML = categoriesHtml + bookingHtml + cleaningHtml;
}

// Переключение экранов
function showActionScreen() {
    document.getElementById('actionScreen').classList.remove('hidden');
    document.getElementById('checkinScreen').classList.add('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');
}

function showCheckinForm() {
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.remove('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');

    // Копируем данные
    document.getElementById('checkinLocation').textContent =
        document.getElementById('modalLocation').textContent;
    document.getElementById('checkinDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('checkinDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем форму
    document.getElementById('checkinForm').reset();
    document.getElementById('checkinDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('checkinDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем выбор вайшнава
    clearVaishnavSelection();
}

function showBookingForm() {
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.add('hidden');
    document.getElementById('bookingScreen').classList.remove('hidden');

    // Копируем данные
    document.getElementById('bookingLocation').textContent =
        document.getElementById('modalLocation').textContent;
    document.getElementById('bookingDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('bookingDateOut').value =
        document.getElementById('modalCheckOut').value;

    // Сбрасываем форму
    document.getElementById('bookingForm').reset();
    document.getElementById('bookingDateIn').value =
        document.getElementById('modalCheckIn').value;
    document.getElementById('bookingDateOut').value =
        document.getElementById('modalCheckOut').value;
}

// ===== Поиск вайшнавов =====
function searchVaishnavas(query) {
    const suggestionsEl = document.getElementById('vaishnavaSuggestions');
    if (!query || query.length < 2) {
        suggestionsEl.classList.add('hidden');
        return;
    }

    const q = query.toLowerCase();
    const matches = vaishnavas.filter(v => {
        const name = getVaishnavName(v).toLowerCase();
        const phone = (v.phone || '').toLowerCase();
        return name.includes(q) || phone.includes(q);
    }).slice(0, 10);

    if (matches.length === 0) {
        suggestionsEl.innerHTML = `<div class="p-3 text-gray-500 text-sm">${t('timeline_not_found')}</div>`;
    } else {
        suggestionsEl.innerHTML = matches.map(v => {
            const name = getVaishnavName(v);
            const badge = v.is_team_member ? `<span class="badge badge-sm badge-primary ml-2">${t('timeline_team')}</span>` : '';
            return `<div class="p-2 hover:bg-base-200 cursor-pointer flex items-center" data-action="select-vaishnava" data-id="${v.id}">
                <span>${e(name)}</span>${badge}
            </div>`;
        }).join('');
    }
    suggestionsEl.classList.remove('hidden');
}

function showVaishnavaSuggestions() {
    const query = document.getElementById('checkinVaishnavSearch').value;
    if (query.length >= 2) {
        searchVaishnavas(query);
    }
}

function selectVaishnava(id) {
    const v = vaishnavas.find(v => v.id === id);
    const name = v ? getVaishnavName(v) : '';
    document.getElementById('checkinVaishnavId').value = id;
    document.getElementById('checkinVaishnavSearch').value = name;
    document.getElementById('vaishnavaSuggestions').classList.add('hidden');
    document.getElementById('clearVaishnava').classList.remove('hidden');
    // Скрываем поля нового гостя
    document.getElementById('guestFields').classList.add('hidden');
    document.getElementById('checkinGuestName').value = '';
}

function clearVaishnavSelection() {
    document.getElementById('checkinVaishnavId').value = '';
    document.getElementById('checkinVaishnavSearch').value = '';
    document.getElementById('clearVaishnava').classList.add('hidden');
    // Показываем поля нового гостя
    document.getElementById('guestFields').classList.remove('hidden');
}

// Закрытие подсказок при клике вне
document.addEventListener('click', (e) => {
    const suggestions = document.getElementById('vaishnavaSuggestions');
    const searchInput = document.getElementById('checkinVaishnavSearch');
    if (suggestions && !suggestions.contains(e.target) && e.target !== searchInput) {
        suggestions.classList.add('hidden');
    }
});

// Делегирование кликов на подсказках вайшнавов
document.getElementById('vaishnavaSuggestions').addEventListener('click', ev => {
    const el = ev.target.closest('[data-action="select-vaishnava"]');
    if (el) selectVaishnava(el.dataset.id);
});

// Сохранение заселения
async function saveCheckin(e) {
    e.preventDefault();
    if (!canEditTimeline()) return;
    const form = e.target;

    const mealTypeVal = form.meal_type.value || 'prasad';
    const data = {
        room_id: modalContext.roomId,
        category_id: form.category_id.value || null,
        vaishnava_id: form.vaishnava_id.value || null,
        guest_name: form.guest_name.value || null,
        guest_phone: form.guest_phone?.value || null,
        check_in: form.check_in.value,
        check_out: form.check_out.value || null,
        early_checkin: form.early_checkin.checked,
        late_checkout: form.late_checkout.checked,
        meal_type: mealTypeVal,
        has_housing: true,
        has_meals: mealTypeVal !== 'self',
        notes: form.notes.value || null,
        status: 'confirmed'
    };

    // Проверка: должен быть либо вайшнав из БД, либо имя нового гостя
    if (!data.vaishnava_id && !data.guest_name) {
        alert(Layout.t('select_vaishnava_or_enter_name'));
        return;
    }

    let error;

    if (modalContext.isConversion && modalContext.residentId) {
        // Конвертация брони в заселение — обновляем существующую запись
        const result = await Layout.db
            .from('residents')
            .update(data)
            .eq('id', modalContext.residentId);
        error = result.error;
    } else {
        // Новое заселение
        const result = await Layout.db.from('residents').insert(data);
        error = result.error;
    }

    if (error) {
        console.error('Error saving checkin:', error);
        alert(Layout.t('checkin_error') + ': ' + error.message);
        return;
    }

    document.getElementById('actionModal').close();
    showActionScreen();
    await loadTimelineData();
    renderTable();
}

// Сохранение бронирования
async function saveBooking(e) {
    e.preventDefault();
    if (!canEditTimeline()) return;
    const form = e.target;

    const bedsCount = parseInt(form.beds_count.value) || 1;

    // Создаём бронирование
    const earlyCheckin = form.early_checkin.checked;
    const lateCheckout = form.late_checkout.checked;
    const bookingName = form.name.value.trim() || null;

    const bookingData = {
        name: bookingName,
        contact_name: form.contact_name.value,
        contact_phone: form.contact_phone.value || null,
        check_in: form.check_in.value,
        check_out: form.check_out.value,
        beds_count: bedsCount,
        early_checkin: earlyCheckin,
        late_checkout: lateCheckout,
        notes: form.notes.value || null,
        status: 'confirmed'
    };

    const { data: booking, error: bookingError } = await Layout.db
        .from('bookings')
        .insert(bookingData)
        .select()
        .single();

    if (bookingError) {
        console.error('Error saving booking:', bookingError);
        alert(Layout.t('booking_error') + ': ' + bookingError.message);
        return;
    }

    // Создаём placeholder резидентов для бронирования
    const residents = [];
    for (let i = 0; i < bedsCount; i++) {
        residents.push({
            room_id: modalContext.roomId,
            booking_id: booking.id,
            check_in: form.check_in.value,
            check_out: form.check_out.value,
            early_checkin: earlyCheckin,
            late_checkout: lateCheckout,
            has_housing: true,
            has_meals: null,
            status: 'confirmed'
        });
    }

    const { error: residentsError } = await Layout.db.from('residents').insert(residents);

    if (residentsError) {
        console.error('Error saving booking residents:', residentsError);
    }

    document.getElementById('actionModal').close();
    showActionScreen();
    await loadTimelineData();
    renderTable();
}

// Обработчик других действий
async function handleAction(action) {
    const startDate = document.getElementById('modalCheckIn').value;
    const endDate = document.getElementById('modalCheckOut').value;

    if (action === 'cleaning' || action === 'bedding') {
        // Для белья: только половина ячейки (end_date = start_date)
        const finalEndDate = action === 'bedding' ? startDate : endDate;

        const { error } = await Layout.db.from('room_cleanings').insert({
            room_id: modalContext.roomId,
            start_date: startDate,
            end_date: finalEndDate,
            type: action
        });

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('actionModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    if (action === 'repair') {
        // TODO: Закрытие на ремонт
        alert(Layout.t('feature_in_development'));
    }

    document.getElementById('actionModal').close();
}

// Текущий резидент для модалки
let currentResident = null;
// День, на который кликнули (для выселения)
let clickedDayIndex = null;

// Открыть модалку резидента из хранилища
function openResidentFromMap(guestId, event) {
    const guestData = guestsMap.get(guestId);
    if (!guestData) {
        console.error('Guest not found:', guestId);
        return;
    }

    // Вычисляем день клика по позиции мыши на плашке
    // Используем полудни (колонки) для точного расчёта
    if (event) {
        const bar = event.target.closest('.guest-bar');
        if (bar) {
            const rect = bar.getBoundingClientRect();
            const clickX = event.clientX - rect.left;
            const barWidth = rect.width;
            // Считаем в полуднях (колонках) для точности
            const startCol = guestData.startDay * 2 + guestData.startHalf;
            const endCol = guestData.endDay * 2 + guestData.endHalf;
            const totalCols = endCol - startCol + 1;
            const colOffset = Math.floor((clickX / barWidth) * totalCols);
            const clickedCol = startCol + colOffset;
            // Конвертируем колонку обратно в день
            clickedDayIndex = Math.floor(clickedCol / 2);
        } else {
            clickedDayIndex = guestData.endDay;
        }
    } else {
        clickedDayIndex = guestData.endDay;
    }

    openResidentModal(guestData, guestData.buildingName, guestData.roomName);
}

// Открыть модалку резидента
function openResidentModal(guestData, buildingName, roomName) {
    currentResident = guestData;
    const res = guestData.rawData;
    const isBooking = guestData.isBooking;
    const isCheckedOut = res.status === 'checked_out';

    // Заголовок
    let title = isBooking ? t('timeline_booking') : t('timeline_stay');
    if (isCheckedOut) title = t('timeline_checked_out');
    document.getElementById('residentModalTitle').textContent = title;

    // Локация
    document.getElementById('residentModalLocation').textContent =
        `${buildingName} → ${t('timeline_room')} ${roomName}`;

    // Информация
    let infoHtml = '';

    // Имя (с ссылкой на профиль, если есть vaishnava_id)
    const nameLink = res.vaishnava_id
        ? `<a href="../vaishnavas/person.html?id=${res.vaishnava_id}" class="link link-primary">${guestData.name}</a>`
        : guestData.name;
    infoHtml += `<div class="flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_guest')}:</span>
        <span class="font-medium">${nameLink}</span>
    </div>`;

    // Категория
    if (res.resident_categories) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_category')}:</span>
            <span class="font-medium">${Layout.getName(res.resident_categories)}</span>
        </div>`;
    }

    // Даты
    infoHtml += `<div class="flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_checkin')}:</span>
        <span class="font-medium">${formatDisplayDate(res.check_in)}${res.early_checkin ? ` (${t('timeline_early')})` : ''}</span>
    </div>`;
    // Плейсхолдер для времени приезда (заполняется асинхронно)
    infoHtml += `<div id="residentArrivalTime" class="hidden flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_arrival_time')}:</span>
        <span class="font-medium" id="residentArrivalTimeValue"></span>
    </div>`;

    if (res.check_out) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_checkout')}:</span>
            <span class="font-medium">${formatDisplayDate(res.check_out)}${res.late_checkout ? ` (${t('timeline_late')})` : ''}</span>
        </div>`;
    }
    // Плейсхолдер для времени отъезда
    infoHtml += `<div id="residentDepartureTime" class="hidden flex justify-between py-1 border-b">
        <span class="text-gray-500">${t('timeline_departure_time')}:</span>
        <span class="font-medium" id="residentDepartureTimeValue"></span>
    </div>`;

    // Телефон
    if (res.guest_phone) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_phone')}:</span>
            <span class="font-medium">${e(res.guest_phone)}</span>
        </div>`;
    }

    // Питание
    if (!isBooking) {
        const mealsLabel = res.has_meals === true ? t('timeline_meals_yes') : res.has_meals === false ? t('timeline_meals_no') : t('timeline_meals_unknown');
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_meals')}:</span>
            <span class="font-medium">${mealsLabel}</span>
        </div>`;
    }

    // Примечания
    if (res.notes) {
        infoHtml += `<div class="flex justify-between py-1 border-b">
            <span class="text-gray-500">${t('timeline_notes')}:</span>
            <span class="font-medium">${e(res.notes)}</span>
        </div>`;
    }

    // Бронирование
    if (res.bookings) {
        if (res.bookings.name) {
            infoHtml += `<div class="flex justify-between py-1 border-b">
                <span class="text-gray-500">${t('timeline_booking')}:</span>
                <span class="font-medium">${e(res.bookings.name)}</span>
            </div>`;
        }
        if (res.bookings.contact_name) {
            infoHtml += `<div class="flex justify-between py-1 border-b">
                <span class="text-gray-500">${t('timeline_contact')}:</span>
                <span class="font-medium">${e(res.bookings.contact_name)}</span>
            </div>`;
        }
    }

    document.getElementById('residentInfo').innerHTML = infoHtml;

    // Кнопки действий (только если есть права на редактирование)
    let actionsHtml = '';
    const canEdit = canEditTimeline();

    if (canEdit) {
        if (isBooking) {
            // Действия для бронирования
            actionsHtml += `<button class="btn btn-primary" data-action="convert-to-checkin">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
                ${t('timeline_checkin_action')}
            </button>`;
            actionsHtml += `<button class="btn btn-info btn-outline" data-action="show-move-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                ${t('timeline_move')}
            </button>`;
            actionsHtml += `<button class="btn btn-error btn-outline" data-action="cancel-booking">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
                ${t('timeline_cancel')}
            </button>`;
        } else if (!isCheckedOut) {
            // Действия для заселённого гостя (не выселенного)
            actionsHtml += `<button class="btn btn-warning" data-action="checkout-resident">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                ${t('timeline_checkout_action')}
            </button>`;
            actionsHtml += `<button class="btn btn-outline" data-action="show-edit-dates-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                ${t('timeline_dates')}
            </button>`;
            actionsHtml += `<button class="btn btn-info btn-outline" data-action="show-move-screen">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                ${t('timeline_move')}
            </button>`;
        }
        // Для выселенных (isCheckedOut) — только кнопка удаления

        // Кнопка удаления для всех
        actionsHtml += `<button class="btn btn-error btn-outline" data-action="delete-resident">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            ${t('timeline_delete')}
        </button>`;
    } else {
        actionsHtml = `<p class="text-sm opacity-60">${t('timeline_view_only')}</p>`;
    }

    document.getElementById('residentActions').innerHTML = actionsHtml;

    // Показываем экран информации (сбрасываем если был на экране перемещения)
    showResidentInfoScreen();

    // Открываем модалку
    document.getElementById('residentModal').showModal();

    // Подгружаем время приезда/отъезда из retreat_registrations
    if (res.retreat_id && res.vaishnava_id) {
        loadRetreatTimes(res.retreat_id, res.vaishnava_id);
    }
}

// Подгрузка arrival/departure datetime из retreat_registrations
async function loadRetreatTimes(retreatId, vaishnavId) {
    const { data } = await Layout.db
        .from('retreat_registrations')
        .select('arrival_datetime, departure_datetime')
        .eq('retreat_id', retreatId)
        .eq('vaishnava_id', vaishnavId)
        .eq('is_deleted', false)
        .maybeSingle();

    if (!data) return;

    if (data.arrival_datetime) {
        const el = document.getElementById('residentArrivalTime');
        const val = document.getElementById('residentArrivalTimeValue');
        if (el && val) {
            val.textContent = formatTimestampShort(data.arrival_datetime);
            el.classList.remove('hidden');
        }
    }
    if (data.departure_datetime) {
        const el = document.getElementById('residentDepartureTime');
        const val = document.getElementById('residentDepartureTimeValue');
        if (el && val) {
            val.textContent = formatTimestampShort(data.departure_datetime);
            el.classList.remove('hidden');
        }
    }
}

// Форматирует TIMESTAMPTZ в читаемый вид: "7 фев, 10:35"
function formatTimestampShort(datetimeStr) {
    if (!datetimeStr) return '—';
    const d = new Date(datetimeStr.slice(0, 16));
    const months = DateUtils.monthNamesShort.ru;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Форматирование даты для отображения
function formatDisplayDate(dateStr) {
    const date = DateUtils.parseDate(dateStr);
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Форматирование даты в YYYY-MM-DD без сдвига часового пояса
function formatDateYMD(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Выселить резидента (установить дату выезда = кликнутый день)
async function checkoutResident() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const res = currentResident.rawData;
    let checkoutDate;

    // Если кликнули на конкретный день — используем его
    if (clickedDayIndex !== null && clickedDayIndex >= currentResident.startDay) {
        checkoutDate = formatDateYMD(getDateForDay(clickedDayIndex));
    } else {
        // Если день не определён или некорректный — используем оригинальную дату выезда
        checkoutDate = res.check_out;
    }

    // Финальная проверка: дата не раньше заезда
    if (!checkoutDate || checkoutDate < res.check_in) {
        checkoutDate = res.check_out || res.check_in;
    }

    // Если дата выезда в прошлом — используем сегодня (реальный день выселения)
    const today = formatDateYMD(new Date());
    if (checkoutDate < today) {
        checkoutDate = today;
    }

    const { error } = await Layout.db
        .from('residents')
        .update({ check_out: checkoutDate, status: 'checked_out' })
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Удалить резидента
async function deleteResident() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;
    if (!confirm(Layout.t('confirm_delete_entry'))) return;

    const { error } = await Layout.db
        .from('residents')
        .delete()
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Отменить бронирование
async function cancelBooking() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;
    if (!confirm(Layout.t('confirm_cancel_booking'))) return;

    const res = currentResident.rawData;

    // Удаляем резидента
    const { error: resError } = await Layout.db
        .from('residents')
        .delete()
        .eq('id', currentResident.id);

    if (resError) {
        alert(Layout.t('error') + ': ' + resError.message);
        return;
    }

    // Если это было связано с бронированием, обновляем статус брони
    if (res.booking_id) {
        await Layout.db
            .from('bookings')
            .update({ status: 'cancelled' })
            .eq('id', res.booking_id);
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Показать экран информации о резиденте
function showResidentInfoScreen() {
    document.getElementById('residentInfoScreen').classList.remove('hidden');
    document.getElementById('moveScreen').classList.add('hidden');
    document.getElementById('editDatesScreen').classList.add('hidden');
}

// Показать экран редактирования дат
function showEditDatesScreen() {
    if (!currentResident) return;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('moveScreen').classList.add('hidden');
    document.getElementById('editDatesScreen').classList.remove('hidden');

    document.getElementById('editDatesGuestName').textContent = currentResident.name;

    const res = currentResident.rawData;
    document.getElementById('editCheckIn').value = res.check_in || '';
    document.getElementById('editCheckOut').value = res.check_out || '';
    document.getElementById('editEarlyCheckin').checked = res.early_checkin || false;
    document.getElementById('editLateCheckout').checked = res.late_checkout || false;
}

// Сохранить изменённые даты
async function saveDates() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const checkIn = document.getElementById('editCheckIn').value;
    const checkOut = document.getElementById('editCheckOut').value;
    const earlyCheckin = document.getElementById('editEarlyCheckin').checked;
    const lateCheckout = document.getElementById('editLateCheckout').checked;

    if (!checkIn) {
        alert(Layout.t('specify_checkin_date'));
        return;
    }

    const { error } = await Layout.db
        .from('residents')
        .update({
            check_in: checkIn,
            check_out: checkOut || null,
            early_checkin: earlyCheckin,
            late_checkout: lateCheckout
        })
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// Показать экран выбора номера для перемещения
async function showMoveScreen() {
    if (!currentResident) return;

    document.getElementById('residentInfoScreen').classList.add('hidden');
    document.getElementById('moveScreen').classList.remove('hidden');
    document.getElementById('editDatesScreen').classList.add('hidden');
    document.getElementById('moveGuestName').textContent = currentResident.name;

    // Загружаем список номеров
    const roomsList = document.getElementById('roomsList');
    roomsList.innerHTML = `<div class="text-center py-4">${t('timeline_loading')}</div>`;

    const res = currentResident.rawData;
    const checkIn = res.check_in;
    const checkOut = res.check_out || '2099-12-31'; // если нет даты выезда

    // Получаем здания, номера и текущих резидентов
    const [buildingsData, residentsRes] = await Promise.all([
        Cache.getOrLoad('buildings_with_rooms', async () => {
            const { data, error } = await Layout.db.from('buildings')
                .select('*, rooms(*)')
                .eq('is_active', true)
                .order('sort_order');
            if (error) { console.error('Error loading buildings:', error); return null; }
            return data;
        }, 3600000),
        Layout.db
            .from('residents')
            .select('room_id, check_in, check_out')
            .eq('status', 'confirmed')
            .neq('id', currentResident.id) // исключаем текущего резидента
            .lte('check_in', checkOut)
            .or(`check_out.is.null,check_out.gte.${checkIn}`)
    ]);

    const buildings = buildingsData || [];
    const residents = residentsRes.data || [];

    if (buildings.length === 0) {
        roomsList.innerHTML = `<div class="text-center py-4 text-gray-500">${t('timeline_no_rooms')}</div>`;
        return;
    }

    // Считаем занятость по комнатам на период перемещаемого резидента
    const roomOccupancy = {};
    residents.forEach(r => {
        if (!roomOccupancy[r.room_id]) {
            roomOccupancy[r.room_id] = 0;
        }
        roomOccupancy[r.room_id]++;
    });

    const currentRoomId = res.room_id;

    let html = '';
    buildings.forEach(building => {
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
                <div class="grid grid-cols-3 gap-1 p-2">`;

        rooms.forEach(room => {
            const isCurrent = room.id === currentRoomId;
            const occupied = roomOccupancy[room.id] || 0;
            const capacity = room.capacity || 1;
            const isFull = occupied >= capacity;

            let btnClass, label, disabled;

            if (isCurrent) {
                btnClass = 'btn-disabled bg-gray-200';
                label = `${room.number} ←`;
                disabled = true;
            } else if (isFull) {
                btnClass = 'btn-disabled bg-red-100 text-red-400';
                label = `${room.number} (${occupied}/${capacity})`;
                disabled = true;
            } else if (occupied > 0) {
                btnClass = 'btn-outline btn-warning';
                label = `${room.number} (${occupied}/${capacity})`;
                disabled = false;
            } else {
                btnClass = 'btn-outline btn-success';
                label = room.number;
                disabled = false;
            }

            html += `<button class="btn btn-sm ${btnClass}"
                ${disabled ? 'disabled' : `data-action="move-to-room" data-id="${room.id}"`}>
                ${label}
            </button>`;
        });

        html += `</div></div></div>`;
    });

    roomsList.innerHTML = html;
}

// Перенос резидента в другой номер
async function moveToRoom(newRoomId) {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    const { error } = await Layout.db
        .from('residents')
        .update({ room_id: newRoomId })
        .eq('id', currentResident.id);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('residentModal').close();
    await loadTimelineData();
    renderTable();
}

// === Модалка управления уборкой ===
let currentCleaning = null;

function openCleaningModal(cleaningId) {
    const cleaningData = cleaningsMap.get(cleaningId);
    if (!cleaningData) {
        console.error('Cleaning not found:', cleaningId);
        return;
    }

    currentCleaning = cleaningData;
    const raw = cleaningData.rawData;

    // Локация
    document.getElementById('cleaningModalLocation').textContent =
        `${cleaningData.buildingName} → ${t('timeline_room')} ${cleaningData.roomName}`;

    // Даты
    document.getElementById('cleaningStartDate').value = raw.start_date;
    document.getElementById('cleaningEndDate').value = raw.end_date;

    // Показываем/скрываем элементы в зависимости от статуса и прав
    const isCompleted = cleaningData.isCompleted;
    const canManageCleaning = window.hasPermission?.('manage_cleaning') ?? false;
    document.getElementById('cleaningCompletedStatus').classList.toggle('hidden', !isCompleted);
    // Скрываем действия если нет прав или уборка уже выполнена
    document.getElementById('cleaningActions').classList.toggle('hidden', isCompleted || !canManageCleaning);

    document.getElementById('cleaningModal').showModal();
}

// Уборка выполнена — помечаем как выполненную (перекрашивается в зелёный)
async function completeCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    // Для автоуборки — ставим флаг cleaning_done в residents
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('residents')
            .update({ cleaning_done: true })
            .eq('id', currentCleaning.residentId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('cleaningModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    // Для ручной уборки — помечаем как выполненную
    const { error } = await Layout.db
        .from('room_cleanings')
        .update({ completed: true, completed_at: new Date().toISOString() })
        .eq('id', currentCleaning.cleaningId);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Продлить уборку — обновляем дату окончания (ручная) или создаём новую запись (авто)
async function extendCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    const newEndDate = document.getElementById('cleaningEndDate').value;
    if (!newEndDate) {
        alert(Layout.t('select_new_checkout_date'));
        return;
    }

    const raw = currentCleaning.rawData;

    // Для автоуборки — создаём новую запись в room_cleanings
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('room_cleanings')
            .insert({
                room_id: raw.room_id,
                start_date: raw.start_date,
                end_date: newEndDate
            });

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }
    } else {
        // Для ручной уборки — обновляем существующую запись
        const { error } = await Layout.db
            .from('room_cleanings')
            .update({ end_date: newEndDate })
            .eq('id', currentCleaning.cleaningId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Удалить уборку (скрыть совсем, в отличие от "Выполнена" которая делает зелёной)
async function deleteCleaning() {
    if (!currentCleaning) return;
    if (!window.hasPermission?.('manage_cleaning')) return;

    // Для автоуборки — помечаем как пропущенную (скрываем)
    if (currentCleaning.isAuto || currentCleaning.isAutoCleaning) {
        const { error } = await Layout.db
            .from('residents')
            .update({ cleaning_skipped: true })
            .eq('id', currentCleaning.residentId);

        if (error) {
            alert(Layout.t('error') + ': ' + error.message);
            return;
        }

        document.getElementById('cleaningModal').close();
        await loadTimelineData();
        renderTable();
        return;
    }

    // Для ручной уборки — удаляем из БД
    const { error } = await Layout.db
        .from('room_cleanings')
        .delete()
        .eq('id', currentCleaning.cleaningId);

    if (error) {
        alert(Layout.t('error') + ': ' + error.message);
        return;
    }

    document.getElementById('cleaningModal').close();
    await loadTimelineData();
    renderTable();
}

// Превратить бронирование в заселение
async function convertToCheckin() {
    if (!currentResident) return;
    if (!canEditTimeline()) return;

    // Закрываем модалку резидента
    document.getElementById('residentModal').close();

    // Открываем модалку заселения с предзаполненными данными
    const res = currentResident.rawData;

    modalContext = {
        roomId: res.room_id,
        residentId: currentResident.id,
        isConversion: true
    };

    // Показываем форму заселения
    document.getElementById('actionScreen').classList.add('hidden');
    document.getElementById('checkinScreen').classList.remove('hidden');
    document.getElementById('bookingScreen').classList.add('hidden');

    document.getElementById('checkinLocation').textContent =
        document.getElementById('residentModalLocation').textContent;
    document.getElementById('checkinDateIn').value = res.check_in;
    document.getElementById('checkinDateOut').value = res.check_out || '';

    // Сбрасываем форму
    document.getElementById('checkinForm').reset();
    document.getElementById('checkinDateIn').value = res.check_in;
    document.getElementById('checkinDateOut').value = res.check_out || '';

    if (res.early_checkin) {
        document.querySelector('#checkinForm [name="early_checkin"]').checked = true;
    }
    if (res.late_checkout) {
        document.querySelector('#checkinForm [name="late_checkout"]').checked = true;
    }

    clearVaishnavSelection();

    document.getElementById('actionModal').showModal();
}

// ==================== ПОИСК ПО ШАХМАТКЕ ====================

// Текущий запрос поиска
let _searchQuery = '';

function onTimelineSearch(query) {
    _searchQuery = query.trim().toLowerCase();
    if (_searchQuery.length < 2) {
        clearTimelineSearch();
        return;
    }

    // Собираем ID совпавших гостей
    const matchedIds = new Set();
    for (const [id, guest] of guestsMap) {
        if (guest.name.toLowerCase().includes(_searchQuery)) {
            matchedIds.add(id);
        }
    }

    // Разворачиваем свёрнутые здания/комнаты, если в них есть совпадения
    let needRerender = false;
    for (const id of matchedIds) {
        const guest = guestsMap.get(id);
        if (!guest?.rawData?.room_id) continue;
        const roomId = guest.rawData.room_id;

        // Ищем building по room_id
        for (const building of timelineData.buildings) {
            const room = building.rooms.find(r => r.id === roomId);
            if (room) {
                if (collapsedBuildings.has(building.id)) {
                    collapsedBuildings.delete(building.id);
                    needRerender = true;
                }
                if (collapsedRooms.has(room.id)) {
                    collapsedRooms.delete(room.id);
                    needRerender = true;
                }
                break;
            }
        }
    }

    if (needRerender) {
        renderTable(); // applySearchHighlight вызовется внутри
    } else {
        applySearchHighlight();
    }
}

function applySearchHighlight() {
    if (!_searchQuery || _searchQuery.length < 2) return;

    const matchedIds = new Set();
    for (const [id, guest] of guestsMap) {
        if (guest.name.toLowerCase().includes(_searchQuery)) {
            matchedIds.add(id);
        }
    }

    const bars = document.querySelectorAll('.guest-bar');
    let firstMatch = null;

    bars.forEach(bar => {
        const id = bar.dataset.id;
        if (matchedIds.has(id)) {
            bar.classList.add('search-highlight');
            bar.classList.remove('search-dim');
            if (!firstMatch) firstMatch = bar;
        } else {
            bar.classList.add('search-dim');
            bar.classList.remove('search-highlight');
        }
    });

    // Счётчик
    const countEl = document.getElementById('searchCount');
    if (countEl) {
        if (matchedIds.size > 0) {
            countEl.textContent = matchedIds.size;
            countEl.classList.remove('hidden');
        } else {
            countEl.textContent = '0';
            countEl.classList.remove('hidden');
        }
    }

    // Прокрутка к первому совпадению
    if (firstMatch) {
        firstMatch.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
}

function clearTimelineSearch() {
    _searchQuery = '';
    document.querySelectorAll('.guest-bar.search-highlight, .guest-bar.search-dim').forEach(bar => {
        bar.classList.remove('search-highlight', 'search-dim');
    });
    const countEl = document.getElementById('searchCount');
    if (countEl) countEl.classList.add('hidden');
}

// Рендер таблицы
// Рендер полосы ретритов (отдельно от таблицы)
function renderRetreats() {
    const container = document.getElementById('retreatsScroll');
    if (!container) return;

    let html = '';

    // Половинки дней (как в таблице — 2 на день)
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        html += '<div class="retreat-half day-start"></div>';
        html += '<div class="retreat-half"></div>';
    }

    // Плашки ретритов
    timelineData.retreats.forEach(r => {
        // Позиция: каждая половина = 24px + 1px border, первая половина ещё +2px border-left
        // Упрощённо: startDay * (24+1+24+1) + 2 для border-left
        const left = r.startDay * CELL_WIDTH * 2 + 2; // +2 для первой границы
        const spanDays = r.endDay - r.startDay + 1;
        const width = spanDays * CELL_WIDTH * 2 - 4;
        html += `<div class="retreat-chip" style="left: ${left}px; width: ${width}px;">${r.name}</div>`;
    });

    // Названия месяцев на первых числах
    const monthNamesArr = DateUtils.monthNames[Layout.currentLang] || DateUtils.monthNames.ru;
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const date = getDateForDay(day);
        if (date.getDate() === 1) {
            const left = day * CELL_WIDTH * 2 + 2;
            html += `<div class="month-label" style="left: ${left}px;">${monthNamesArr[date.getMonth()].toUpperCase()}</div>`;
        }
    }

    container.innerHTML = html;
}

// Синхронизация скролла ретритов с таблицей
function syncScroll() {
    const tableContainer = document.getElementById('tableContainer');
    const retreatsScroll = document.getElementById('retreatsScroll');
    if (!tableContainer || !retreatsScroll) return;

    tableContainer.addEventListener('scroll', () => {
        retreatsScroll.style.transform = `translateX(-${tableContainer.scrollLeft}px)`;
    });
}

function renderTable() {
    const table = document.getElementById('timelineTable');

    let html = '<thead>';

    // Строка с числами
    html += `<tr class="row-dates"><th class="sticky-col">
        <div class="flex gap-1">
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="collapse-all-buildings" title="${t('timeline_collapse_all')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 9H4m16 6H4" /></svg>
            </button>
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="collapse-all-rooms" title="${t('timeline_collapse_rooms')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" /></svg>
            </button>
            <button class="btn btn-xs btn-ghost opacity-60 hover:opacity-100" data-action="expand-all" title="${t('timeline_expand_all')}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" /></svg>
            </button>
        </div>
    </th>`;
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const date = getDateForDay(day);
        const weekend = isWeekend(day) ? 'weekend' : '';
        const today = day === TODAY_INDEX ? 'today' : '';
        html += `<th colspan="2" class="day-start ${weekend} ${today}">${date.getDate()}</th>`;
    }
    html += '</tr>';

    // Строка с днями недели
    html += '<tr class="row-weekdays"><th class="sticky-col"></th>';
    for (let day = 0; day < DAYS_TO_SHOW; day++) {
        const weekend = isWeekend(day) ? 'weekend' : '';
        const today = day === TODAY_INDEX ? 'today' : '';
        html += `<th colspan="2" class="day-start ${weekend} ${today}">${getWeekdayName(day)}</th>`;
    }
    html += '</tr>';

    html += '</thead><tbody>';

    // Калибровочная строка для фиксации ширины колонок
    html += '<tr class="row-calibration"><td class="sticky-col"></td>';
    for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
        html += '<td class="half-day"></td>';
    }
    html += '</tr>';

    // Здания
    timelineData.buildings.forEach(building => {
        const buildingCollapsed = collapsedBuildings.has(building.id);
        const arrowClass = buildingCollapsed ? 'collapsed' : '';

        // Заголовок здания
        const tempBadge = building.isTemporary ? ' <span style="font-size: 10px; color: #d97706;">⏱</span>' : '';
        const tempClass = building.isTemporary ? ' temporary' : '';
        html += `<tr class="row-building${tempClass}">`;
        html += `<td class="sticky-col" data-action="toggle-building" data-id="${building.id}">`;
        html += `<span class="toggle-arrow ${arrowClass}">▼</span> ${building.name}${tempBadge}</td>`;
        for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
            const dayIndex = Math.floor(col / 2);
            const isFirstHalf = col % 2 === 0;
            const dayStart = isFirstHalf ? 'day-start' : '';

            // Для временных зданий закрашиваем ячейки вне периода аренды
            const isOutsideRental = building.isTemporary &&
                (dayIndex < building.availableFromDay || dayIndex > building.availableUntilDay);

            if (isOutsideRental) {
                html += `<td class="${dayStart}" style="background: #d1d5db;"></td>`;
            } else {
                html += `<td class="${dayStart}"></td>`;
            }
        }
        html += '</tr>';

        // Номера (скрыты если здание свёрнуто)
        building.rooms.forEach(room => {
            const roomCollapsed = collapsedRooms.has(room.id);
            const roomArrowClass = roomCollapsed ? 'collapsed' : '';
            const hiddenClass = buildingCollapsed ? 'collapsed' : '';

            // Заголовок номера — показываем сводку по занятости
            html += `<tr class="row-room ${hiddenClass}">`;
            html += `<td class="sticky-col" data-action="toggle-room" data-id="${room.id}">`;
            html += `<span class="toggle-arrow ${roomArrowClass}">▼</span> ${t('timeline_room')} ${room.name}</td>`;

            // Вычисляем сегменты занятости только для свёрнутых номеров
            let segments = [];
            let totalBeds = room.beds.length;

            if (roomCollapsed) {
                const allGuests = room.beds.flatMap(bed =>
                    bed.guests.filter(g => !g.isCleaning)
                );

                let currentSegment = null;

                for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                    const occupying = allGuests.filter(g => {
                        const gStart = g.startDay * 2 + g.startHalf;
                        const gEnd = g.endDay * 2 + g.endHalf;
                        return col >= gStart && col <= gEnd;
                    });

                    const occupiedCount = occupying.length;
                    const ids = occupying.map(g => g.id).sort().join(',');

                    if (currentSegment && currentSegment.ids === ids) {
                        currentSegment.endCol = col;
                    } else {
                        if (currentSegment && currentSegment.count > 0) {
                            segments.push(currentSegment);
                        }
                        if (occupiedCount > 0) {
                            currentSegment = {
                                startCol: col,
                                endCol: col,
                                count: occupiedCount,
                                ids: ids,
                                guests: occupying
                            };
                        } else {
                            currentSegment = null;
                        }
                    }
                }
                if (currentSegment && currentSegment.count > 0) {
                    segments.push(currentSegment);
                }
            }

            // Рендерим ячейки строки номера
            for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                const dayIndex = Math.floor(col / 2);
                const halfIndex = col % 2;
                const isFirstHalf = halfIndex === 0;
                const dayStart = isFirstHalf ? 'day-start' : '';

                // Проверка: для временных зданий закрашиваем ячейки вне периода аренды
                const isOutsideRental = building.isTemporary &&
                    (dayIndex < building.availableFromDay || dayIndex > building.availableUntilDay);

                if (isOutsideRental) {
                    html += `<td class="${dayStart}" style="background: #e5e7eb; pointer-events: none;"></td>`;
                    continue;
                }

                html += `<td class="${dayStart}">`;

                // Показываем сводку только когда номер свёрнут
                if (roomCollapsed) {
                    const segment = segments.find(s => s.startCol === col);
                    if (segment) {
                        const spanCells = segment.endCol - segment.startCol + 1;
                        const width = spanCells * CELL_WIDTH - 2;

                        const firstGuest = segment.guests[0];
                        const bgColor = firstGuest?.color || '#3b82f6';
                        const isBooking = segment.guests.some(g => g.isBooking);
                        const isCheckedOut = segment.guests.some(g => g.isCheckedOut);
                        const isPartial = segment.count < totalBeds;

                        let label = '';
                        if (totalBeds === 1) {
                            // Одноместный номер — показываем имя
                            label = firstGuest.name;
                        } else {
                            // Многоместный номер — всегда показываем дробь
                            label = `<span class="fraction">${segment.count}/${totalBeds}</span>`;
                        }

                        const bookingClass = isBooking ? 'booking' : '';
                        const checkedOutClass = isCheckedOut ? ' checked-out' : '';
                        const style = isBooking
                            ? `width: ${width}px; --bar-color: ${bgColor}; border-color: ${bgColor};`
                            : `width: ${width}px; background: ${bgColor};`;

                        html += `<div class="room-summary-bar ${bookingClass}${checkedOutClass}" style="${style}">${label}</div>`;
                    }
                }

                // Рендерим уборки на строке номера (всегда, независимо от сворачивания)
                const cleaning = (room.cleanings || []).find(c =>
                    c.startDay === dayIndex && c.startHalf === halfIndex
                );
                if (cleaning) {
                    const startCol = cleaning.startDay * 2 + cleaning.startHalf;
                    const endCol = cleaning.endDay * 2 + cleaning.endHalf;
                    const spanCells = Math.max(1, endCol - startCol + 1);
                    const width = spanCells * CELL_WIDTH - 2;
                    const completedClass = cleaning.isCompleted ? ' completed' : '';
                    const typeClass = cleaning.type === 'bedding' ? ' bedding' : '';
                    html += `<div class="cleaning-bar clickable${completedClass}${typeClass}" style="width: ${width}px;" data-action="open-cleaning-modal" data-id="${cleaning.cleaningId}">${cleaning.name}</div>`;
                }

                html += '</td>';
            }
            html += '</tr>';

            // Места (скрыты если здание или номер свёрнуты)
            const bedsHiddenClass = (buildingCollapsed || roomCollapsed) ? 'collapsed' : '';

            room.beds.forEach(bed => {
                const bedLabel = bed.name ? `${t('timeline_bed')} ${bed.name}` : '';
                html += `<tr class="row-bed ${bedsHiddenClass}"><td class="sticky-col">${bedLabel}</td>`;

                // Всегда рендерим все ячейки (DAYS_TO_SHOW * 2)
                for (let col = 0; col < DAYS_TO_SHOW * 2; col++) {
                    const dayIndex = Math.floor(col / 2);
                    const halfIndex = col % 2;
                    const isFirstHalf = halfIndex === 0;
                    const dayStart = isFirstHalf ? 'day-start' : '';
                    const weekend = isWeekend(dayIndex) ? 'weekend' : '';
                    const today = dayIndex === TODAY_INDEX ? 'today' : '';

                    // Проверка: для временных зданий закрашиваем ячейки вне периода аренды
                    const isOutsideRental = building.isTemporary &&
                        (dayIndex < building.availableFromDay || dayIndex > building.availableUntilDay);

                    if (isOutsideRental) {
                        html += `<td class="half-day ${dayStart}" style="background: #e5e7eb; pointer-events: none;"></td>`;
                        continue;
                    }

                    // Проверяем есть ли гость начинающийся здесь
                    const guest = bed.guests.find(g =>
                        g.startDay === dayIndex && g.startHalf === halfIndex
                    );

                    // Экранируем кавычки в именах
                    const bName = building.name.replace(/'/g, "\\'");
                    const rName = room.name.replace(/'/g, "\\'");
                    const bedName = bed.name.replace(/'/g, "\\'");

                    html += `<td class="half-day clickable ${dayStart} ${weekend} ${today}" data-action="open-action-modal" data-day-index="${dayIndex}" data-room-id="${room.id}" data-building-name="${bName}" data-room-name="${rName}" data-bed-name="${bedName}" data-half-index="${halfIndex}">`;

                    // Если здесь начинается гость — добавляем плашку
                    // (уборки теперь рендерятся на строке номера, не на строке места)
                    if (guest && !guest.isCleaning) {
                        const startCol = guest.startDay * 2 + guest.startHalf;
                        const endCol = guest.endDay * 2 + guest.endHalf;
                        const spanCells = Math.max(1, endCol - startCol + 1);
                        const width = spanCells * CELL_WIDTH - 2; // минус отступы
                        const checkedOutClass = guest.isCheckedOut ? ' checked-out' : '';

                        if (guest.isBooking) {
                            // Бронирование — штриховка
                            const bgColor = guest.color || '#3b82f6';
                            html += `<div class="guest-bar booking${checkedOutClass}" style="width: ${width}px; --bar-color: ${bgColor}; border-color: ${bgColor};" data-action="open-resident-from-map" data-id="${guest.id}">${guest.name}</div>`;
                        } else {
                            // Обычное заселение
                            const bgColor = guest.color || '#3b82f6';
                            const borderColor = guest.border || '#facc15';
                            html += `<div class="guest-bar${checkedOutClass}" style="width: ${width}px; background: ${bgColor}; border-color: ${borderColor};" data-action="open-resident-from-map" data-id="${guest.id}">${guest.name}</div>`;
                        }
                    }

                    html += '</td>';
                }

                html += '</tr>';
            });
        });
    });

    html += '</tbody>';
    table.innerHTML = html;

    // Повторно применить подсветку поиска после перерисовки
    if (_searchQuery) applySearchHighlight();
}

// Перезагрузка данных и рендеринг
async function reload() {
    Layout.showLoader();
    await Promise.all([
        loadTimelineData(),
        loadDictionaries()
    ]);
    renderRetreats();
    renderTable();
    syncScroll();
    Layout.hideLoader();
}

// Сдвиг на месяц вперёд или назад
function shiftMonth(direction) {
    baseDate.setMonth(baseDate.getMonth() + direction);
    reload();
}

// Сброс к сегодняшнему дню
async function resetToToday() {
    baseDate = new Date();
    baseDate.setHours(0, 0, 0, 0);
    baseDate.setDate(baseDate.getDate() - 2);

    await reload();

    // Сбросить скролл к началу ПОСЛЕ перерисовки
    setTimeout(() => {
        const tableContainer = document.getElementById('tableContainer');
        if (tableContainer) {
            tableContainer.scrollLeft = 0;
        }
    }, 100);
}

// Инициализация
// ==================== ДЕЛЕГИРОВАНИЕ КЛИКОВ ====================
function setupTimelineDelegation() {
    // Делегирование для таблицы таймлайна
    const table = document.getElementById('timelineTable');
    if (table && !table._delegated) {
        table._delegated = true;
        table.addEventListener('click', ev => {
            const el = ev.target.closest('[data-action]');
            if (!el) return;
            ev.stopPropagation();
            const { action, id } = el.dataset;
            switch (action) {
                case 'toggle-building': toggleBuilding(id); break;
                case 'toggle-room': toggleRoom(id); break;
                case 'collapse-all-buildings': collapseAllBuildings(); break;
                case 'collapse-all-rooms': collapseAllRooms(); break;
                case 'expand-all': expandAll(); break;
                case 'open-action-modal':
                    openActionModal(
                        Number(el.dataset.dayIndex),
                        el.dataset.roomId,
                        el.dataset.buildingName,
                        el.dataset.roomName,
                        el.dataset.bedName,
                        Number(el.dataset.halfIndex)
                    );
                    break;
                case 'open-resident-from-map': openResidentFromMap(id, ev); break;
                case 'open-cleaning-modal': openCleaningModal(id); break;
            }
        });
    }

    // Делегирование для кнопок действий с резидентом
    const residentActions = document.getElementById('residentActions');
    if (residentActions && !residentActions._delegated) {
        residentActions._delegated = true;
        residentActions.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action]');
            if (!btn) return;
            switch (btn.dataset.action) {
                case 'convert-to-checkin': convertToCheckin(); break;
                case 'show-move-screen': showMoveScreen(); break;
                case 'cancel-booking': cancelBooking(); break;
                case 'checkout-resident': checkoutResident(); break;
                case 'show-edit-dates-screen': showEditDatesScreen(); break;
                case 'delete-resident': deleteResident(); break;
            }
        });
    }

    // Делегирование для списка комнат при перемещении
    const roomsList = document.getElementById('roomsList');
    if (roomsList && !roomsList._delegated) {
        roomsList._delegated = true;
        roomsList.addEventListener('click', ev => {
            const btn = ev.target.closest('[data-action="move-to-room"]');
            if (btn) moveToRoom(btn.dataset.id);
        });
    }
}

async function init() {
    await Layout.init({ module: 'housing', menuId: 'reception', itemId: 'timeline' });
    Layout.showLoader();
    await Promise.all([
        loadTimelineData(),
        loadDictionaries()
    ]);
    renderRetreats();
    renderTable();
    syncScroll();
    setupTimelineDelegation();
    Layout.hideLoader();

    // Подписка на изменения в реальном времени
    subscribeToRealtime();
}

// Realtime: автоматическое обновление при изменениях в БД
function subscribeToRealtime() {
    const channel = Layout.db.channel('timeline-realtime');

    // Подписка на изменения в residents
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'residents' },
        handleRealtimeChange
    );

    // Подписка на изменения в bookings
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'bookings' },
        handleRealtimeChange
    );

    // Подписка на изменения в room_cleanings
    channel.on('postgres_changes',
        { event: '*', schema: 'public', table: 'room_cleanings' },
        handleRealtimeChange
    );

    channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
            console.log('Realtime: подключено к шахматке');
        }
    });
}

// Обработка изменений — перезагрузка данных с debounce
let realtimeTimeout = null;
function handleRealtimeChange(payload) {
    console.log('Realtime изменение:', payload.table, payload.eventType);

    // Debounce: если несколько изменений подряд — ждём 500мс
    if (realtimeTimeout) clearTimeout(realtimeTimeout);
    realtimeTimeout = setTimeout(async () => {
        await loadTimelineData();
        renderTable();
        Layout.showNotification(t('timeline_data_updated'), 'info');
    }, 500);
}

window.onLanguageChange = () => {
    Layout.updateAllTranslations();
    renderRetreats();
    renderTable();
    renderLegend();
};

init();
