-- Решение ВГ (23.07.2026): детализация для семьи регулируемая.
-- Старт с минимума (итог + блоки), флаг full_details на связи открывает
-- конкретной семье полный расклад (строки начислений и платежей родственника).
-- «Включить всем по умолчанию» в будущем = ALTER COLUMN SET DEFAULT true
-- + UPDATE существующих — одна миграция, ничего не переделывается.
--
-- portal_fin_get_my_finances переопределена: family-элемент дополнительно несёт
-- charges/payments при f.full_details (jsonb_strip_nulls убирает ключи при
-- выключенном флаге). Полный текст — pg_get_functiondef на проде.

ALTER TABLE family_links ADD COLUMN IF NOT EXISTS full_details boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN family_links.full_details IS
'true — обе стороны связи видят в портале полную детализацию друг друга (строки начислений/платежей), а не только итог и блоки.';

INSERT INTO translations (key, ru, en, hi) VALUES
  ('family_full_details', 'Полная детализация', 'Full details', 'पूर्ण विवरण'),
  ('family_full_details_hint', 'Обе стороны видят строки начислений и платежей друг друга', 'Both sides see each other''s charge and payment lines', 'दोनों पक्ष एक-दूसरे की पंक्तियाँ देखते हैं')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
