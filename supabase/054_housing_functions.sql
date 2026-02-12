-- ============================================
-- 054: Модуль "Проживание" - Функции
-- ============================================

-- ============================================
-- 1. ПОЛУЧИТЬ ЗАПОЛНЕННОСТЬ КОМНАТ НА ДАТУ
-- ============================================
CREATE OR REPLACE FUNCTION get_room_occupancy(target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    room_id UUID,
    building_id UUID,
    building_name_ru TEXT,
    building_name_en TEXT,
    room_number TEXT,
    floor INTEGER,
    capacity INTEGER,
    occupied INTEGER,
    available INTEGER,
    room_type_name_ru TEXT,
    room_type_name_en TEXT,
    room_type_color TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id AS room_id,
        b.id AS building_id,
        b.name_ru::TEXT AS building_name_ru,
        b.name_en::TEXT AS building_name_en,
        r.number::TEXT AS room_number,
        r.floor,
        r.capacity,
        COALESCE(occ.occupied_count, 0)::INTEGER AS occupied,
        (r.capacity - COALESCE(occ.occupied_count, 0))::INTEGER AS available,
        rt.name_ru::TEXT AS room_type_name_ru,
        rt.name_en::TEXT AS room_type_name_en,
        rt.color::TEXT AS room_type_color
    FROM rooms r
    JOIN buildings b ON b.id = r.building_id
    LEFT JOIN room_types rt ON rt.id = r.room_type_id
    LEFT JOIN (
        SELECT
            res.room_id,
            COUNT(*)::INTEGER AS occupied_count
        FROM residents res
        WHERE res.status = 'confirmed'
          AND res.check_in <= target_date
          AND (res.check_out IS NULL OR res.check_out > target_date)
        GROUP BY res.room_id
    ) occ ON occ.room_id = r.id
    WHERE r.is_active = true
      AND b.is_active = true
    ORDER BY b.sort_order, b.name_ru, r.floor, r.sort_order, r.number;
END;
$$;

-- ============================================
-- 2. ПОЛУЧИТЬ СТАТИСТИКУ ПРОЖИВАНИЯ
-- ============================================
CREATE OR REPLACE FUNCTION get_housing_stats(target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    total_rooms INTEGER,
    total_capacity INTEGER,
    total_occupied INTEGER,
    total_available INTEGER,
    occupancy_rate NUMERIC,
    buildings_count INTEGER,
    active_residents INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    RETURN QUERY
    WITH room_stats AS (
        SELECT
            COUNT(r.id)::INTEGER AS rooms,
            SUM(r.capacity)::INTEGER AS capacity
        FROM rooms r
        JOIN buildings b ON b.id = r.building_id
        WHERE r.is_active = true AND b.is_active = true
    ),
    resident_stats AS (
        SELECT COUNT(*)::INTEGER AS occupied
        FROM residents res
        WHERE res.status = 'confirmed'
          AND res.check_in <= target_date
          AND (res.check_out IS NULL OR res.check_out > target_date)
    ),
    building_stats AS (
        SELECT COUNT(*)::INTEGER AS buildings
        FROM buildings
        WHERE is_active = true
    )
    SELECT
        rs.rooms,
        rs.capacity,
        res.occupied,
        (rs.capacity - res.occupied)::INTEGER,
        CASE WHEN rs.capacity > 0 THEN ROUND((res.occupied::NUMERIC / rs.capacity) * 100, 1) ELSE 0 END,
        bs.buildings,
        res.occupied
    FROM room_stats rs, resident_stats res, building_stats bs;
END;
$$;

-- ============================================
-- 3. ПОЛУЧИТЬ ПРОЖИВАЮЩИХ В КОМНАТЕ
-- ============================================
CREATE OR REPLACE FUNCTION get_room_residents(target_room_id UUID, target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    resident_id UUID,
    display_name TEXT,
    category_name_ru TEXT,
    category_name_en TEXT,
    category_color TEXT,
    check_in DATE,
    check_out DATE,
    team_member_id UUID,
    is_team_member BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        res.id AS resident_id,
        COALESCE(
            tm.spiritual_name,
            tm.first_name,
            res.guest_name
        )::TEXT AS display_name,
        rc.name_ru::TEXT AS category_name_ru,
        rc.name_en::TEXT AS category_name_en,
        rc.color::TEXT AS category_color,
        res.check_in,
        res.check_out,
        res.team_member_id,
        (res.team_member_id IS NOT NULL) AS is_team_member
    FROM residents res
    LEFT JOIN team_members tm ON tm.id = res.team_member_id
    LEFT JOIN resident_categories rc ON rc.id = res.category_id
    WHERE res.room_id = target_room_id
      AND res.status = 'confirmed'
      AND res.check_in <= target_date
      AND (res.check_out IS NULL OR res.check_out >= target_date)
    ORDER BY res.check_in;
END;
$$;

-- ============================================
-- 4. ПРОВЕРИТЬ ДОСТУПНОСТЬ КОМНАТЫ
-- ============================================
CREATE OR REPLACE FUNCTION check_room_availability(
    target_room_id UUID,
    start_date DATE,
    end_date DATE,
    exclude_resident_id UUID DEFAULT NULL
)
RETURNS TABLE (
    is_available BOOLEAN,
    current_occupancy INTEGER,
    room_capacity INTEGER,
    available_beds INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    room_cap INTEGER;
    current_occ INTEGER;
BEGIN
    -- Получаем вместимость комнаты
    SELECT capacity INTO room_cap FROM rooms WHERE id = target_room_id;

    IF room_cap IS NULL THEN
        RETURN QUERY SELECT false, 0, 0, 0;
        RETURN;
    END IF;

    -- Считаем текущую заполненность на период
    SELECT COUNT(*)::INTEGER INTO current_occ
    FROM residents res
    WHERE res.room_id = target_room_id
      AND res.status = 'confirmed'
      AND res.id IS DISTINCT FROM exclude_resident_id
      AND res.check_in < end_date
      AND (res.check_out IS NULL OR res.check_out > start_date);

    RETURN QUERY SELECT
        (room_cap > current_occ) AS is_available,
        current_occ,
        room_cap,
        (room_cap - current_occ)::INTEGER AS available_beds;
END;
$$;

-- ============================================
-- 5. ПОЛУЧИТЬ ЗАЕЗДЫ/ВЫЕЗДЫ НА ДАТУ
-- ============================================
CREATE OR REPLACE FUNCTION get_arrivals_departures(target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    event_type TEXT,
    resident_id UUID,
    display_name TEXT,
    room_number TEXT,
    building_name_ru TEXT,
    building_name_en TEXT,
    category_name_ru TEXT,
    category_color TEXT,
    event_date DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
BEGIN
    -- Заезды
    RETURN QUERY
    SELECT
        'arrival'::TEXT AS event_type,
        res.id AS resident_id,
        COALESCE(tm.spiritual_name, tm.first_name, res.guest_name)::TEXT AS display_name,
        r.number::TEXT AS room_number,
        b.name_ru::TEXT AS building_name_ru,
        b.name_en::TEXT AS building_name_en,
        rc.name_ru::TEXT AS category_name_ru,
        rc.color::TEXT AS category_color,
        res.check_in AS event_date
    FROM residents res
    JOIN rooms r ON r.id = res.room_id
    JOIN buildings b ON b.id = r.building_id
    LEFT JOIN team_members tm ON tm.id = res.team_member_id
    LEFT JOIN resident_categories rc ON rc.id = res.category_id
    WHERE res.check_in = target_date
      AND res.status = 'confirmed';

    -- Выезды
    RETURN QUERY
    SELECT
        'departure'::TEXT AS event_type,
        res.id AS resident_id,
        COALESCE(tm.spiritual_name, tm.first_name, res.guest_name)::TEXT AS display_name,
        r.number::TEXT AS room_number,
        b.name_ru::TEXT AS building_name_ru,
        b.name_en::TEXT AS building_name_en,
        rc.name_ru::TEXT AS category_name_ru,
        rc.color::TEXT AS category_color,
        res.check_out AS event_date
    FROM residents res
    JOIN rooms r ON r.id = res.room_id
    JOIN buildings b ON b.id = r.building_id
    LEFT JOIN team_members tm ON tm.id = res.team_member_id
    LEFT JOIN resident_categories rc ON rc.id = res.category_id
    WHERE res.check_out = target_date
      AND res.status = 'confirmed';
END;
$$;
