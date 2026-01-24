-- Таблица уборок номеров
CREATE TABLE IF NOT EXISTS room_cleanings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

-- Индекс для быстрого поиска по датам
CREATE INDEX IF NOT EXISTS idx_room_cleanings_dates ON room_cleanings(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_room_cleanings_room ON room_cleanings(room_id);

-- RLS
ALTER TABLE room_cleanings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_cleanings_select" ON room_cleanings FOR SELECT USING (true);
CREATE POLICY "room_cleanings_insert" ON room_cleanings FOR INSERT WITH CHECK (true);
CREATE POLICY "room_cleanings_update" ON room_cleanings FOR UPDATE USING (true);
CREATE POLICY "room_cleanings_delete" ON room_cleanings FOR DELETE USING (true);
