-- Перевод для фильтра исполнителя задач CRM (crm/tasks.html)

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('crm_all_tasks', 'Все задачи', 'All tasks', 'सभी कार्य', 'Фильтр задач CRM по исполнителю')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context,
  updated_at = NOW();
