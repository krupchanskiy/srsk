// ==================== PORTAL-DATA.JS ====================
// Загрузка данных для Guest Portal
// Текущий ретрит, размещение, трансферы, материалы

(function() {
'use strict';

const db = window.portalSupabase;

/**
 * Загрузить текущий ретрит гостя (даты пересекаются с сегодня)
 * @param {string} guestId - ID гостя из vaishnavas
 * @returns {Promise<object|null>}
 */
async function getCurrentRetreat(guestId) {
    try {
        const today = new Date().toISOString().split('T')[0];

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
                check_in_date,
                check_out_date,
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
            .eq('is_deleted', false)
            .maybeSingle();

        if (error) {
            console.error('Ошибка загрузки размещения:', error);
            return null;
        }

        // Если есть комната, загружаем соседа
        if (data?.room?.id) {
            const { data: roommates, error: roommatesError } = await db
                .from('residents')
                .select(`
                    vaishnava:vaishnavas (
                        id,
                        first_name,
                        last_name,
                        spiritual_name,
                        photo_url
                    )
                `)
                .eq('room_id', data.room.id)
                .eq('retreat_id', retreatId)
                .eq('is_deleted', false)
                .neq('vaishnava_id', guestId);

            if (!roommatesError && roommates?.length > 0) {
                data.roommates = roommates.map(r => r.vaishnava);
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
                type,
                date,
                time,
                flight_number,
                airport,
                station,
                notes,
                taxi_driver,
                taxi_phone,
                taxi_car,
                taxi_price,
                status
            `)
            .eq('registration_id', registrationId)
            .order('date');

        if (error) {
            console.error('Ошибка загрузки трансферов:', error);
            return { arrival: null, departure: null };
        }

        const result = { arrival: null, departure: null };

        for (const transfer of data || []) {
            if (transfer.type === 'arrival') {
                result.arrival = transfer;
            } else if (transfer.type === 'departure') {
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
        const today = new Date().toISOString().split('T')[0];

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
        const today = new Date().toISOString().split('T')[0];

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
        const today = new Date().toISOString().split('T')[0];

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
                is_registration_open,
                max_guests
            `)
            .eq('is_registration_open', true)
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
                telegram: profileData.telegram,
                country: profileData.country,
                city: profileData.city,
                spiritual_teacher: profileData.spiritualTeacher,
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
        currentRetreat,
        upcomingRetreats,
        materials,
        availableRetreats
    ] = await Promise.all([
        getCurrentRetreat(guestId),
        getUpcomingRetreats(guestId),
        getMaterials(),
        getAvailableRetreats()
    ]);

    let accommodation = null;
    let transfers = { arrival: null, departure: null };

    // Если есть текущий ретрит, загружаем размещение и трансферы
    if (currentRetreat) {
        [accommodation, transfers] = await Promise.all([
            getAccommodation(guestId, currentRetreat.retreat.id),
            getTransfers(currentRetreat.id)
        ]);
    }

    return {
        currentRetreat,
        accommodation,
        transfers,
        upcomingRetreats,
        materials: materials.slice(0, 6), // Только первые 6 для превью
        availableRetreats,
        hasCurrentRetreat: !!currentRetreat
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
        availableRetreats
    ] = await Promise.all([
        getCurrentRetreat(guestId),
        getUpcomingRetreats(guestId),
        getPastRetreats(guestId),
        getAvailableRetreats()
    ]);

    return {
        currentRetreat,
        upcomingRetreats,
        pastRetreats,
        availableRetreats
    };
}

// Экспорт
window.PortalData = {
    getCurrentRetreat,
    getAccommodation,
    getTransfers,
    getUpcomingRetreats,
    getPastRetreats,
    getAvailableRetreats,
    getMaterials,
    getMaterialBySlug,
    updateProfile,
    uploadPhoto,
    loadDashboardData,
    loadRetreatsData
};

})();
