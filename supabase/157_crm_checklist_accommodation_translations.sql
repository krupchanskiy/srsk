-- Недостающие переводы опций селекта "Проживание" в чеклисте сделки CRM
-- В UI показывались сырые ключи (crm_accom_guest_house, crm_other_hotels и т.д.)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('crm_accom_guest_house',    'Гостевой дом ШРСК',    'SRSK Guest House',      'SRSK अतिथि गृह',         'Чеклист: проживание'),
  ('crm_accom_staff_house',    'Служебные дома ШРСК',  'SRSK Staff Houses',     'SRSK कर्मचारी आवास',     'Чеклист: проживание'),
  ('crm_other_hotels',         'Другие отели',         'Other hotels',          'अन्य होटल',              'Чеклист: проживание'),
  ('crm_self_arrangement',     'Сам организует',       'Self-arranged',         'स्वयं व्यवस्था',          'Чеклист: проживание'),
  ('crm_guest_house_no_room',  'Гостевой дом — нет номера', 'Guest House — no room assigned', 'अतिथि गृह — कोई कमरा नहीं', 'Чеклист: проживание'),
  ('crm_staff_house_no_room',  'Служебный дом — нет номера', 'Staff House — no room assigned', 'कर्मचारी आवास — कोई कमरा नहीं', 'Чеклист: проживание')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context,
  updated_at = NOW();
