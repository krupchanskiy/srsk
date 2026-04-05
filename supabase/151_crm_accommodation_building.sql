-- Колонка для хранения конкретного здания-гостиницы в чеклисте сделки
ALTER TABLE crm_deals
ADD COLUMN IF NOT EXISTS checklist_accommodation_building_id UUID REFERENCES buildings(id);
