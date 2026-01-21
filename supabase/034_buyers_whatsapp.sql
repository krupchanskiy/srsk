-- ============================================
-- WHATSAPP ДЛЯ ЗАКУПЩИКОВ
-- ============================================

ALTER TABLE buyers ADD COLUMN IF NOT EXISTS whatsapp TEXT;

-- Перевод для интерфейса
INSERT INTO translations (key, ru, en, hi, context) VALUES
('whatsapp', 'WhatsApp', 'WhatsApp', 'व्हाट्सएप', 'Поле закупщика')
ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
