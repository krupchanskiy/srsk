-- ============================================
-- Публичные поля ретритов для rupaseva.com
-- ============================================

-- Новые колонки для карточек на публичном сайте
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS speakers_ru TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS speakers_en TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS registration_url TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;

-- RLS-политика: анонимное чтение публичных ретритов
DROP POLICY IF EXISTS "Public read retreats" ON retreats;
CREATE POLICY "Public read retreats" ON retreats
  FOR SELECT TO anon
  USING (is_public = true);
