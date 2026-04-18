-- Недостающий перевод для пункта меню «UTM-метки»

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_crm_utm_links', 'UTM-метки', 'UTM links', 'UTM लिंक', 'Навигация CRM')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
