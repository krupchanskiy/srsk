-- ============================================
-- Миграция 143: Чеклист гостя, данные рейсов, допполя
-- ============================================

-- Чеклист гостя
ALTER TABLE crm_deals
  ADD COLUMN IF NOT EXISTS checklist_accommodation TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checklist_meals TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checklist_transfer_arrival TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checklist_transfer_departure TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checklist_visa TEXT DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS checklist_tickets TEXT DEFAULT 'unknown';

-- Данные прибытия/отъезда
ALTER TABLE crm_deals
  ADD COLUMN IF NOT EXISTS arrival_type TEXT DEFAULT 'flight',  -- flight/self/other
  ADD COLUMN IF NOT EXISTS arrival_flight TEXT,
  ADD COLUMN IF NOT EXISTS arrival_datetime TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrival_airport TEXT,
  ADD COLUMN IF NOT EXISTS arrival_details TEXT,  -- откуда (для type=other)
  ADD COLUMN IF NOT EXISTS arrival_early_checkin BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS departure_type TEXT DEFAULT 'flight',  -- flight/self/other
  ADD COLUMN IF NOT EXISTS departure_flight TEXT,
  ADD COLUMN IF NOT EXISTS departure_datetime TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS departure_airport TEXT,
  ADD COLUMN IF NOT EXISTS departure_details TEXT,  -- куда (для type=other)
  ADD COLUMN IF NOT EXISTS departure_late_checkout BOOLEAN DEFAULT false;

-- Предпочтения по расселению
ALTER TABLE crm_deals
  ADD COLUMN IF NOT EXISTS roommate_preference TEXT,
  ADD COLUMN IF NOT EXISTS special_needs TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Духовный учитель (в таблице vaishnavas)
ALTER TABLE vaishnavas
  ADD COLUMN IF NOT EXISTS guru_name TEXT;
