-- ============================================
-- Миграция 144: Состав группы (участники сделки)
-- ============================================

CREATE TABLE IF NOT EXISTS crm_deal_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    relation TEXT,  -- wife/husband/child/friend/colleague
    age INTEGER,    -- для детей
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE crm_deal_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated manage deal members" ON crm_deal_members
  FOR ALL TO authenticated USING (true);
