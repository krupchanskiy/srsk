-- ============================================
-- 061: Система бронирования
-- ============================================

-- ============================================
-- 1. ТАБЛИЦА БРОНИРОВАНИЙ
-- ============================================
CREATE TABLE IF NOT EXISTS bookings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

    -- Название брони (опционально, для отображения в списках)
    name TEXT,

    -- Контактное лицо (сам гость или организатор группы)
    contact_name TEXT NOT NULL,
    contact_phone TEXT,
    contact_email TEXT,
    contact_country TEXT,

    -- Параметры брони
    beds_count INTEGER NOT NULL DEFAULT 1,  -- Сколько мест нужно
    check_in DATE NOT NULL,
    check_out DATE NOT NULL,

    -- Связь с ретритом (опционально)
    retreat_id UUID REFERENCES retreats(id) ON DELETE SET NULL,

    -- Статус
    status TEXT DEFAULT 'active',   -- active, cancelled, completed

    -- Примечания
    notes TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all bookings" ON bookings;
CREATE POLICY "Allow all bookings" ON bookings FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(check_in, check_out);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_retreat ON bookings(retreat_id);

-- Добавить поле name если его нет (для существующих таблиц)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS name TEXT;

-- Триггер для updated_at
DROP TRIGGER IF EXISTS update_bookings_updated_at ON bookings;
CREATE TRIGGER update_bookings_updated_at BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- 2. ДОБАВИТЬ booking_id В RESIDENTS
-- ============================================
ALTER TABLE residents ADD COLUMN IF NOT EXISTS booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_residents_booking ON residents(booking_id);

-- ============================================
-- 3. ИЗМЕНИТЬ CONSTRAINT RESIDENTS
-- Теперь разрешены placeholder-записи для бронирований
-- ============================================
ALTER TABLE residents DROP CONSTRAINT IF EXISTS residents_has_person;
ALTER TABLE residents ADD CONSTRAINT residents_has_person CHECK (
    team_member_id IS NOT NULL
    OR guest_name IS NOT NULL
    OR booking_id IS NOT NULL
);

-- ============================================
-- 4. ФУНКЦИЯ: ПОЛУЧИТЬ ЗАНЯТОСТЬ С БРОНЯМИ
-- Возвращает: occupied, booked, needs_cleaning
-- ВАЖНО: check_out = target_date означает ВЫЕЗД (комната освобождается, нужна уборка)
-- ============================================
DROP FUNCTION IF EXISTS get_room_occupancy_with_bookings(DATE);

CREATE OR REPLACE FUNCTION get_room_occupancy_with_bookings(target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    room_id UUID,
    room_number TEXT,
    floor INTEGER,
    capacity INTEGER,
    room_type_id UUID,
    room_type_name_ru TEXT,
    room_type_name_en TEXT,
    room_status TEXT,
    building_id UUID,
    building_name_ru TEXT,
    building_name_en TEXT,
    occupied INTEGER,
    booked INTEGER,
    needs_cleaning INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id AS room_id,
        r.number AS room_number,
        r.floor,
        r.capacity,
        r.room_type_id,
        rt.name_ru AS room_type_name_ru,
        rt.name_en AS room_type_name_en,
        r.status AS room_status,
        r.building_id,
        b.name_ru AS building_name_ru,
        b.name_en AS building_name_en,
        -- Занято (гость ещё живёт: check_out > target_date или бессрочно)
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.room_id = r.id
              AND res.status = 'confirmed'
              AND res.check_in <= target_date
              AND (res.check_out IS NULL OR res.check_out > target_date)
              AND (res.team_member_id IS NOT NULL OR res.guest_name IS NOT NULL)
        ), 0) AS occupied,
        -- Забронировано (placeholder, check_out > target_date)
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.room_id = r.id
              AND res.status = 'confirmed'
              AND res.check_in <= target_date
              AND (res.check_out IS NULL OR res.check_out > target_date)
              AND res.booking_id IS NOT NULL
              AND res.team_member_id IS NULL
              AND res.guest_name IS NULL
        ), 0) AS booked,
        -- Требует уборки (выезд сегодня: check_out = target_date)
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.room_id = r.id
              AND res.status = 'confirmed'
              AND res.check_out = target_date
        ), 0) AS needs_cleaning
    FROM rooms r
    LEFT JOIN room_types rt ON r.room_type_id = rt.id
    LEFT JOIN buildings b ON r.building_id = b.id
    WHERE r.is_active = true
    ORDER BY b.sort_order, r.floor, r.number;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 5. ФУНКЦИЯ: СТАТИСТИКА БРОНИРОВАНИЙ
-- ============================================
DROP FUNCTION IF EXISTS get_booking_stats(DATE);

CREATE OR REPLACE FUNCTION get_booking_stats(target_date DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    total_bookings INTEGER,
    total_beds_booked INTEGER,
    beds_filled INTEGER,
    beds_pending INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(DISTINCT b.id)::INTEGER AS total_bookings,
        COALESCE(SUM(b.beds_count), 0)::INTEGER AS total_beds_booked,
        -- Заполненные (места с реальными данными)
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.booking_id IN (SELECT id FROM bookings WHERE status = 'active')
              AND res.status = 'confirmed'
              AND res.check_in <= target_date
              AND (res.check_out IS NULL OR res.check_out >= target_date)
              AND (res.team_member_id IS NOT NULL OR res.guest_name IS NOT NULL)
        ), 0) AS beds_filled,
        -- Ожидают заполнения (placeholder)
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.booking_id IN (SELECT id FROM bookings WHERE status = 'active')
              AND res.status = 'confirmed'
              AND res.check_in <= target_date
              AND (res.check_out IS NULL OR res.check_out >= target_date)
              AND res.team_member_id IS NULL
              AND res.guest_name IS NULL
        ), 0) AS beds_pending
    FROM bookings b
    WHERE b.status = 'active'
      AND b.check_in <= target_date
      AND b.check_out >= target_date;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 6. ФУНКЦИЯ: ПОЛУЧИТЬ ДЕТАЛИ БРОНИРОВАНИЯ
-- ============================================
-- ============================================
-- 7. ТАБЛИЦА ЗАДАЧ УБОРКИ (РУЧНЫЕ)
-- ============================================
CREATE TABLE IF NOT EXISTS cleaning_tasks (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    cleaning_date DATE NOT NULL,
    notes TEXT,
    status TEXT DEFAULT 'pending',  -- pending, completed, cancelled
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cleaning_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all cleaning_tasks" ON cleaning_tasks;
CREATE POLICY "Allow all cleaning_tasks" ON cleaning_tasks FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_date ON cleaning_tasks(cleaning_date);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_room ON cleaning_tasks(room_id);
CREATE INDEX IF NOT EXISTS idx_cleaning_tasks_status ON cleaning_tasks(status);

-- ============================================
-- 8. ФУНКЦИЯ: ПОЛУЧИТЬ ДЕТАЛИ БРОНИРОВАНИЯ
-- ============================================
DROP FUNCTION IF EXISTS get_booking_details(UUID);

CREATE OR REPLACE FUNCTION get_booking_details(booking_uuid UUID)
RETURNS TABLE (
    booking_id UUID,
    name TEXT,
    contact_name TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    contact_country TEXT,
    beds_count INTEGER,
    check_in DATE,
    check_out DATE,
    retreat_id UUID,
    retreat_name_ru TEXT,
    retreat_name_en TEXT,
    status TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ,
    beds_filled INTEGER,
    beds_pending INTEGER,
    rooms JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        b.id AS booking_id,
        b.name,
        b.contact_name,
        b.contact_phone,
        b.contact_email,
        b.contact_country,
        b.beds_count,
        b.check_in,
        b.check_out,
        b.retreat_id,
        ret.name_ru AS retreat_name_ru,
        ret.name_en AS retreat_name_en,
        b.status,
        b.notes,
        b.created_at,
        -- Заполненные места
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.booking_id = b.id
              AND res.status = 'confirmed'
              AND (res.team_member_id IS NOT NULL OR res.guest_name IS NOT NULL)
        ), 0) AS beds_filled,
        -- Ожидают заполнения
        COALESCE((
            SELECT COUNT(*)::INTEGER
            FROM residents res
            WHERE res.booking_id = b.id
              AND res.status = 'confirmed'
              AND res.team_member_id IS NULL
              AND res.guest_name IS NULL
        ), 0) AS beds_pending,
        -- Комнаты с местами брони
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'room_id', r.id,
                'room_number', r.number,
                'building_name_ru', bld.name_ru,
                'building_name_en', bld.name_en,
                'resident_id', res.id,
                'is_filled', (res.team_member_id IS NOT NULL OR res.guest_name IS NOT NULL),
                'guest_name', res.guest_name,
                'team_member_name', COALESCE(tm.spiritual_name, tm.first_name)
            ))
            FROM residents res
            JOIN rooms r ON res.room_id = r.id
            JOIN buildings bld ON r.building_id = bld.id
            LEFT JOIN team_members tm ON res.team_member_id = tm.id
            WHERE res.booking_id = b.id
              AND res.status = 'confirmed'
        ), '[]'::jsonb) AS rooms
    FROM bookings b
    LEFT JOIN retreats ret ON b.retreat_id = ret.id
    WHERE b.id = booking_uuid;
END;
$$ LANGUAGE plpgsql;
