-- Переводы для вкладки «Предоплата»

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_crm_prepayments', 'Предоплата', 'Prepayments', 'अग्रिम भुगतान', 'Навигация CRM'),
  ('crm_prepayments_page_title', 'Предоплата — CRM — ШРСК', 'Prepayments — CRM — SRSK', 'अग्रिम भुगतान — CRM — SRSK', 'Заголовок страницы'),
  ('crm_prepayment_confirmed', 'Подтверждена', 'Confirmed', 'पुष्टि की गई', 'CRM Предоплата'),
  ('crm_prepayment_not_confirmed', 'Не подтверждена', 'Not confirmed', 'पुष्टि नहीं हुई', 'CRM Предоплата'),
  ('crm_prepayment_confirmation_status', 'Статус подтверждения', 'Confirmation status', 'पुष्टि स्थिति', 'CRM Предоплата'),
  ('crm_payment_system', 'Платёжная система', 'Payment system', 'भुगतान प्रणाली', 'CRM Предоплата'),
  ('crm_all_systems', 'Все системы', 'All systems', 'सभी प्रणालियाँ', 'CRM Предоплата'),
  ('crm_all_statuses', 'Все статусы', 'All statuses', 'सभी स्थितियाँ', 'CRM Предоплата'),
  ('crm_payment_history', 'История изменений', 'Change history', 'परिवर्तन इतिहास', 'CRM Предоплата'),
  ('crm_no_prepayments', 'Нет предоплат', 'No prepayments', 'कोई अग्रिम भुगतान नहीं', 'CRM Предоплата'),
  ('crm_saved', 'Сохранено', 'Saved', 'सहेजा गया', 'Общее')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
