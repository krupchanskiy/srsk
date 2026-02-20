// ==================== PORTAL-DATA.JS ====================
// Загрузка данных для Guest Portal
// Текущий ретрит, размещение, трансферы, материалы

(function() {
'use strict';

const db = window.portalSupabase;

/**
 * Загрузить текущий или ближайший предстоящий ретрит гостя
 * @param {string} guestId - ID гостя из vaishnavas
 * @returns {Promise<object|null>}
 */
async function getCurrentOrUpcomingRetreat(guestId) {
    try {
        const today = DateUtils.toISO(new Date());

        // Загружаем все регистрации пользователя
        const { data: registrations, error } = await db
            .from('retreat_registrations')
            .select(`
                id,
                status,
                created_at,
                retreat:retreats (
                    id,
                    name_ru,
                    name_en,
                    name_hi,
                    start_date,
                    end_date,
                    description_ru,
                    description_en,
                    description_hi,
                    image_url
                )
            `)
            .eq('vaishnava_id', guestId)
            .eq('is_deleted', false);

        if (error) {
            console.error('Ошибка загрузки регистраций:', error);
            return null;
        }

        if (!registrations || registrations.length === 0) {
            return null;
        }

        // Фильтруем на клиенте
        // Сначала ищем текущий ретрит
        const current = registrations.find(r =>
            r.retreat && r.retreat.start_date <= today && r.retreat.end_date >= today
        );

        if (current) {
            current.isCurrent = true;
            return current;
        }

        // Ищем ближайший предстоящий
        const upcoming = registrations
            .filter(r => r.retreat && r.retreat.start_date > today)
            .sort((a, b) => a.retreat.start_date.localeCompare(b.retreat.start_date))[0];

        if (upcoming) {
            upcoming.isCurrent = false;
            return upcoming;
        }

        return null;

    } catch (error) {
        console.error('Ошибка загрузки ретрита:', error);
        return null;
    }
}

/**
 * Загрузить текущий ретрит гостя (даты пересекаются с сегодня)
 * @param {string} guestId - ID гостя из vaishnavas
 * @returns {Promise<object|null>}
 */
async function getCurrentRetreat(guestId) {
    try {
        const today = DateUtils.toISO(new Date());

        const { data, error } = await db
            .from('retreat_registrations')
            .select(`
                id,
                status,
                created_at,
                retreat:retreats (
                    id,
                    name_ru,
                    name_en,
                    name_hi,
                    start_date,
                    end_date,
                    description_ru,
                    description_en,
                    description_hi
                )
            `)
            .eq('vaishnava_id', guestId)
            .eq('is_deleted', false)
            .lte('retreat.start_date', today)
            .gte('retreat.end_date', today)
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('Ошибка загрузки текущего ретрита:', error);
            return null;
        }

        return data;

    } catch (error) {
        console.error('Ошибка загрузки текущего ретрита:', error);
        return null;
    }
}

/**
 * Загрузить размещение гостя на ретрите
 * @param {string} guestId
 * @param {string} retreatId
 * @returns {Promise<object|null>}
 */
async function getAccommodation(guestId, retreatId) {
    try {
        const { data, error } = await db
            .from('residents')
            .select(`
                id,
                check_in,
                check_out,
                room:rooms (
                    id,
                    number,
                    building:buildings (
                        id,
                        name_ru,
                        name_en,
                        name_hi
                    )
                )
            `)
            .eq('vaishnava_id', guestId)
            .eq('retreat_id', retreatId)
            .maybeSingle();

        if (error) {
            console.error('Ошибка загрузки размещения:', error);
            return null;
        }

        // Если есть комната, загружаем соседей (по пересекающимся датам)
        if (data?.room?.id && data.check_in && data.check_out) {
            const { data: roommates, error: roommatesError } = await db
                .from('residents')
                .select(`
                    check_in,
                    check_out,
                    vaishnava:vaishnavas (
                        id,
                        first_name,
                        last_name,
                        spiritual_name,
                        photo_url
                    )
                `)
                .eq('room_id', data.room.id)
                .neq('vaishnava_id', guestId)
                .lte('check_in', data.check_out)
                .gte('check_out', data.check_in);

            if (!roommatesError && roommates?.length > 0) {
                data.roommates = roommates.map(r => r.vaishnava).filter(v => v);
            }
        }

        return data;

    } catch (error) {
        console.error('Ошибка загрузки размещения:', error);
        return null;
    }
}

/**
 * Загрузить трансферы гостя
 * @param {string} registrationId - ID регистрации на ретрит
 * @returns {Promise<object>} { arrival, departure }
 */
async function getTransfers(registrationId) {
    try {
        const { data, error } = await db
            .from('guest_transfers')
            .select(`
                id,
                direction,
                flight_datetime,
                flight_number,
                needs_transfer,
                transfer_group,
                notes,
                taxi_status,
                taxi_driver_info,
                taxi_ordered_by
            `)
            .eq('registration_id', registrationId)
            .order('flight_datetime');

        if (error) {
            console.error('Ошибка загрузки трансферов:', error);
            return { arrival: null, departure: null };
        }

        const result = { arrival: null, departure: null };

        for (const transfer of data || []) {
            if (transfer.direction === 'arrival') {
                result.arrival = transfer;
            } else if (transfer.direction === 'departure') {
                result.departure = transfer;
            }
        }

        return result;

    } catch (error) {
        console.error('Ошибка загрузки трансферов:', error);
        return { arrival: null, departure: null };
    }
}

/**
 * Загрузить предстоящие ретриты гостя
 * @param {string} guestId
 * @returns {Promise<array>}
 */
async function getUpcomingRetreats(guestId) {
    try {
        const today = DateUtils.toISO(new Date());

        const { data, error } = await db
            .from('retreat_registrations')
            .select(`
                id,
                status,
                created_at,
                retreat:retreats (
                    id,
                    name_ru,
                    name_en,
                    name_hi,
                    start_date,
                    end_date
                )
            `)
            .eq('vaishnava_id', guestId)
            .eq('is_deleted', false)
            .gt('retreat.start_date', today)
            .order('retreat(start_date)', { ascending: true });

        if (error) {
            console.error('Ошибка загрузки предстоящих ретритов:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки предстоящих ретритов:', error);
        return [];
    }
}

/**
 * Загрузить историю ретритов гостя
 * @param {string} guestId
 * @returns {Promise<array>}
 */
async function getPastRetreats(guestId) {
    try {
        const today = DateUtils.toISO(new Date());

        const { data, error } = await db
            .from('retreat_registrations')
            .select(`
                id,
                status,
                created_at,
                retreat:retreats (
                    id,
                    name_ru,
                    name_en,
                    name_hi,
                    start_date,
                    end_date
                )
            `)
            .eq('vaishnava_id', guestId)
            .eq('is_deleted', false)
            .lt('retreat.end_date', today)
            .order('retreat(end_date)', { ascending: false });

        if (error) {
            console.error('Ошибка загрузки истории ретритов:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки истории ретритов:', error);
        return [];
    }
}

/**
 * Загрузить доступные для регистрации ретриты
 * @returns {Promise<array>}
 */
async function getAvailableRetreats() {
    try {
        const today = DateUtils.toISO(new Date());

        const { data, error } = await db
            .from('retreats')
            .select(`
                id,
                name_ru,
                name_en,
                name_hi,
                start_date,
                end_date,
                description_ru,
                description_en,
                description_hi,
                registration_open,
                image_url
            `)
            .eq('registration_open', true)
            .gt('start_date', today)
            .order('start_date');

        if (error) {
            console.error('Ошибка загрузки доступных ретритов:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки доступных ретритов:', error);
        return [];
    }
}

/**
 * Загрузить материалы (гайды)
 * @returns {Promise<array>}
 */
async function getMaterials() {
    try {
        const { data, error } = await db
            .from('materials')
            .select(`
                id,
                slug,
                title_ru,
                title_en,
                title_hi,
                content_ru,
                content_en,
                content_hi,
                icon,
                sort_order
            `)
            .eq('is_published', true)
            .order('sort_order');

        if (error) {
            console.error('Ошибка загрузки материалов:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки материалов:', error);
        return [];
    }
}

/**
 * Загрузить один материал по slug
 * @param {string} slug
 * @returns {Promise<object|null>}
 */
async function getMaterialBySlug(slug) {
    try {
        const { data, error } = await db
            .from('materials')
            .select(`
                id,
                slug,
                title_ru,
                title_en,
                title_hi,
                content_ru,
                content_en,
                content_hi,
                icon,
                updated_at
            `)
            .eq('slug', slug)
            .eq('is_published', true)
            .single();

        if (error) {
            console.error('Ошибка загрузки материала:', error);
            return null;
        }

        return data;

    } catch (error) {
        console.error('Ошибка загрузки материала:', error);
        return null;
    }
}

/**
 * Обновить профиль гостя
 * @param {string} guestId
 * @param {object} data - Данные для обновления
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateProfile(guestId, profileData) {
    try {
        const { error } = await db
            .from('vaishnavas')
            .update({
                first_name: profileData.firstName,
                last_name: profileData.lastName,
                spiritual_name: profileData.spiritualName,
                phone: profileData.phone,
                has_whatsapp: profileData.hasWhatsapp || false,
                telegram: profileData.telegram,
                country: profileData.country,
                city: profileData.city,
                spiritual_teacher: profileData.spiritualTeacher,
                no_spiritual_teacher: profileData.noSpiritualTeacher || false,
                birth_date: profileData.birthDate,
                photo_url: profileData.photoUrl,
                is_profile_public: profileData.isProfilePublic,
                updated_at: new Date().toISOString()
            })
            .eq('id', guestId);

        if (error) {
            console.error('Ошибка обновления профиля:', error);
            return { success: false, error: error.message };
        }

        // Обновляем глобальный объект
        if (window.currentGuest) {
            Object.assign(window.currentGuest, profileData);
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Загрузить фото в Storage
 * @param {File} file
 * @param {string} guestId
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function uploadPhoto(file, guestId) {
    try {
        const bucket = window.PORTAL_CONFIG.PHOTO_BUCKET;
        const ext = file.name.split('.').pop();
        const fileName = `${guestId}_${Date.now()}.${ext}`;
        const filePath = `${guestId}/${fileName}`;

        // Загружаем файл
        const { error: uploadError } = await db.storage
            .from(bucket)
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: true
            });

        if (uploadError) {
            console.error('Ошибка загрузки файла:', uploadError);
            return { success: false, error: uploadError.message };
        }

        // Получаем публичный URL
        const { data: { publicUrl } } = db.storage
            .from(bucket)
            .getPublicUrl(filePath);

        return { success: true, url: publicUrl };

    } catch (error) {
        console.error('Ошибка загрузки фото:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Загрузить все данные для Dashboard
 * @param {string} guestId
 * @returns {Promise<object>}
 */
async function loadDashboardData(guestId) {
    // Параллельная загрузка
    const [
        activeRetreat,
        upcomingRetreats,
        materials,
        availableRetreats,
        childrenData
    ] = await Promise.all([
        getCurrentOrUpcomingRetreat(guestId),
        getUpcomingRetreats(guestId),
        getMaterials(),
        getAvailableRetreats(),
        getChildren(guestId)
    ]);

    let accommodation = null;
    let transfers = { arrival: null, departure: null };

    // Если есть активный/предстоящий ретрит, загружаем размещение и трансферы
    if (activeRetreat && activeRetreat.retreat) {
        [accommodation, transfers] = await Promise.all([
            getAccommodation(guestId, activeRetreat.retreat.id),
            getTransfers(activeRetreat.id)
        ]);
    }

    return {
        activeRetreat,
        accommodation,
        transfers,
        upcomingRetreats,
        materials: materials.slice(0, 6), // Только первые 6 для превью
        availableRetreats,
        children: childrenData,
        hasActiveRetreat: !!activeRetreat,
        isCurrentRetreat: activeRetreat?.isCurrent || false
    };
}

/**
 * Загрузить данные для страницы ретритов
 * @param {string} guestId
 * @returns {Promise<object>}
 */
async function loadRetreatsData(guestId) {
    const [
        currentRetreat,
        upcomingRetreats,
        pastRetreats,
        availableRetreats,
        crmDeals
    ] = await Promise.all([
        getCurrentRetreat(guestId),
        getUpcomingRetreats(guestId),
        getPastRetreats(guestId),
        getAvailableRetreats(),
        getCrmDeals(guestId)
    ]);

    return {
        currentRetreat,
        upcomingRetreats,
        pastRetreats,
        availableRetreats,
        crmDeals
    };
}

/**
 * Загрузить CRM-заявки гостя (активные сделки)
 * @param {string} guestId
 * @returns {Promise<array>}
 */
async function getCrmDeals(guestId) {
    try {
        const { data, error } = await db
            .from('crm_deals')
            .select(`
                id,
                status,
                total_services,
                total_paid,
                currency,
                created_at,
                retreat:retreats (
                    id,
                    name_ru,
                    name_en,
                    name_hi,
                    start_date,
                    end_date
                )
            `)
            .eq('vaishnava_id', guestId)
            .not('status', 'in', '(completed,cancelled)')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Ошибка загрузки CRM заявок:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки CRM заявок:', error);
        return [];
    }
}

// ==================== CHILDREN ====================

/**
 * Загрузить детей гостя
 * @param {string} parentId - ID родителя
 * @returns {Promise<array>}
 */
async function getChildren(parentId) {
    try {
        const { data, error } = await db
            .from('vaishnavas')
            .select('id, first_name, last_name, spiritual_name, gender, birth_date, photo_url')
            .eq('parent_id', parentId)
            .eq('is_deleted', false)
            .order('birth_date');

        if (error) {
            console.error('Ошибка загрузки детей:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки детей:', error);
        return [];
    }
}

/**
 * Создать ребёнка
 * @param {string} parentId
 * @param {object} childData
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function createChild(parentId, childData) {
    try {
        const { data, error } = await db
            .from('vaishnavas')
            .insert({
                parent_id: parentId,
                first_name: childData.firstName,
                last_name: childData.lastName,
                gender: childData.gender || null,
                birth_date: childData.birthDate || null,
                is_guest: true
            })
            .select('id, first_name, last_name, gender, birth_date')
            .single();

        if (error) {
            console.error('Ошибка создания ребёнка:', error);
            return { success: false, error: error.message };
        }

        return { success: true, data };

    } catch (error) {
        console.error('Ошибка создания ребёнка:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Обновить ребёнка
 * @param {string} childId
 * @param {object} childData
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateChild(childId, parentId, childData) {
    try {
        const { error } = await db
            .from('vaishnavas')
            .update({
                first_name: childData.firstName,
                last_name: childData.lastName,
                gender: childData.gender || null,
                birth_date: childData.birthDate || null
            })
            .eq('id', childId)
            .eq('parent_id', parentId);

        if (error) {
            console.error('Ошибка обновления ребёнка:', error);
            return { success: false, error: error.message };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка обновления ребёнка:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Удалить ребёнка (soft delete)
 * @param {string} childId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteChild(childId, parentId) {
    try {
        const { error } = await db
            .from('vaishnavas')
            .update({ is_deleted: true, parent_id: null })
            .eq('id', childId)
            .eq('parent_id', parentId);

        if (error) {
            console.error('Ошибка удаления ребёнка:', error);
            return { success: false, error: error.message };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка удаления ребёнка:', error);
        return { success: false, error: error.message };
    }
}

// ==================== SCHEDULE & MENU ====================

/**
 * Загрузить расписание на сегодня для ретрита
 * @param {string} retreatId
 * @returns {Promise<{day: object, items: array}|null>}
 */
async function getTodaySchedule(retreatId) {
    try {
        const today = DateUtils.toISO(new Date());

        const { data: day, error: dayError } = await db
            .from('retreat_schedule_days')
            .select('id, date, theme, description')
            .eq('retreat_id', retreatId)
            .eq('date', today)
            .maybeSingle();

        if (dayError) {
            console.error('Ошибка загрузки расписания дня:', dayError);
            return null;
        }

        if (!day) return null;

        const { data: items, error: itemsError } = await db
            .from('retreat_schedule_items')
            .select('id, time_start, time_end, title, location, description, sort_order')
            .eq('day_id', day.id)
            .order('time_start')
            .order('sort_order');

        if (itemsError) {
            console.error('Ошибка загрузки событий расписания:', itemsError);
            return { day, items: [] };
        }

        return { day, items: items || [] };

    } catch (error) {
        console.error('Ошибка загрузки расписания:', error);
        return null;
    }
}

/**
 * Загрузить меню на сегодня (основная кухня)
 * @returns {Promise<array>} массив приёмов пищи с блюдами
 */
async function getTodayMenu() {
    try {
        const today = DateUtils.toISO(new Date());

        // Сначала находим location_id основной кухни
        const { data: location, error: locError } = await db
            .from('locations')
            .select('id')
            .eq('slug', 'main')
            .maybeSingle();

        if (locError || !location) {
            console.error('Ошибка загрузки локации кухни:', locError);
            return [];
        }

        // Загружаем приёмы пищи на сегодня
        const { data: meals, error: mealsError } = await db
            .from('menu_meals')
            .select(`
                id,
                meal_type,
                menu_dishes (
                    id,
                    sort_order,
                    recipe:recipes (
                        id,
                        name_ru,
                        name_en,
                        name_hi
                    )
                )
            `)
            .eq('location_id', location.id)
            .eq('date', today)
            .order('meal_type');

        if (mealsError) {
            console.error('Ошибка загрузки меню:', mealsError);
            return [];
        }

        return meals || [];

    } catch (error) {
        console.error('Ошибка загрузки меню:', error);
        return [];
    }
}

// ==================== ADMIN: MATERIALS CRUD ====================

/**
 * Загрузить все материалы (включая неопубликованные) — для админки
 * @returns {Promise<array>}
 */
async function getAllMaterials() {
    try {
        const { data, error } = await db
            .from('materials')
            .select('*')
            .order('sort_order');

        if (error) {
            console.error('Ошибка загрузки материалов:', error);
            return [];
        }

        return data || [];

    } catch (error) {
        console.error('Ошибка загрузки материалов:', error);
        return [];
    }
}

/**
 * Получить материал по ID — для редактирования
 * @param {string} id
 * @returns {Promise<object|null>}
 */
async function getMaterialById(id) {
    try {
        const { data, error } = await db
            .from('materials')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            console.error('Ошибка загрузки материала:', error);
            return null;
        }

        return data;

    } catch (error) {
        console.error('Ошибка загрузки материала:', error);
        return null;
    }
}

/**
 * Создать материал
 * @param {object} materialData
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function createMaterial(materialData) {
    try {
        const { data, error } = await db
            .from('materials')
            .insert({
                slug: materialData.slug,
                title_ru: materialData.title_ru,
                title_en: materialData.title_en,
                title_hi: materialData.title_hi,
                content_ru: materialData.content_ru,
                content_en: materialData.content_en,
                content_hi: materialData.content_hi,
                icon: materialData.icon || 'book',
                sort_order: materialData.sort_order || 0,
                is_published: materialData.is_published || false
            })
            .select()
            .single();

        if (error) {
            console.error('Ошибка создания материала:', error);
            return { success: false, error: error.message };
        }

        return { success: true, data };

    } catch (error) {
        console.error('Ошибка создания материала:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Обновить материал
 * @param {string} id
 * @param {object} materialData
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateMaterial(id, materialData) {
    try {
        const { error } = await db
            .from('materials')
            .update({
                slug: materialData.slug,
                title_ru: materialData.title_ru,
                title_en: materialData.title_en,
                title_hi: materialData.title_hi,
                content_ru: materialData.content_ru,
                content_en: materialData.content_en,
                content_hi: materialData.content_hi,
                icon: materialData.icon,
                sort_order: materialData.sort_order,
                is_published: materialData.is_published,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) {
            console.error('Ошибка обновления материала:', error);
            return { success: false, error: error.message };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка обновления материала:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Удалить материал
 * @param {string} id
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteMaterial(id) {
    try {
        const { error } = await db
            .from('materials')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Ошибка удаления материала:', error);
            return { success: false, error: error.message };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка удаления материала:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Переключить публикацию материала
 * @param {string} id
 * @param {boolean} isPublished
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function toggleMaterialPublished(id, isPublished) {
    try {
        const { error } = await db
            .from('materials')
            .update({
                is_published: isPublished,
                updated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) {
            console.error('Ошибка обновления статуса:', error);
            return { success: false, error: error.message };
        }

        return { success: true };

    } catch (error) {
        console.error('Ошибка обновления статуса:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Загрузить изображение для материала
 * @param {File} file
 * @param {string} materialId
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
async function uploadMaterialImage(file, materialId) {
    try {
        const ext = file.name.split('.').pop();
        const fileName = `${Date.now()}.${ext}`;
        const filePath = `${materialId}/${fileName}`;

        const { error: uploadError } = await db.storage
            .from('materials')
            .upload(filePath, file, {
                cacheControl: '3600',
                upsert: false
            });

        if (uploadError) {
            console.error('Ошибка загрузки изображения:', uploadError);
            return { success: false, error: uploadError.message };
        }

        const { data: { publicUrl } } = db.storage
            .from('materials')
            .getPublicUrl(filePath);

        return { success: true, url: publicUrl };

    } catch (error) {
        console.error('Ошибка загрузки изображения:', error);
        return { success: false, error: error.message };
    }
}

// Экспорт
window.PortalData = {
    getCurrentRetreat,
    getCurrentOrUpcomingRetreat,
    getAccommodation,
    getTransfers,
    getUpcomingRetreats,
    getPastRetreats,
    getAvailableRetreats,
    getCrmDeals,
    getMaterials,
    getMaterialBySlug,
    updateProfile,
    uploadPhoto,
    loadDashboardData,
    loadRetreatsData,
    // Children
    getChildren,
    createChild,
    updateChild,
    deleteChild,
    // Schedule & Menu
    getTodaySchedule,
    getTodayMenu,
    // Admin: Materials
    getAllMaterials,
    getMaterialById,
    createMaterial,
    updateMaterial,
    deleteMaterial,
    toggleMaterialPublished,
    uploadMaterialImage
};

})();
