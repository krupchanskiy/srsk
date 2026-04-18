-- Недостающие переводы стадий CRM-воронки (Kanban)
-- В работе / Выставлен счёт / Оплачена бронь / Чек лист — показывались на русском в EN/HI-режимах

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('crm_status_working',   'В работе',        'In progress',     'प्रगति में',     'Статус CRM-воронки'),
  ('crm_status_invoiced',  'Выставлен счёт',  'Invoiced',        'चालान जारी',     'Статус CRM-воронки'),
  ('crm_status_booked',    'Оплачена бронь',  'Booking paid',    'बुकिंग भुगतान',  'Статус CRM-воронки'),
  ('crm_status_checklist', 'Чек лист',        'Checklist',       'चेकलिस्ट',        'Статус CRM-воронки')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context,
  updated_at = NOW();
