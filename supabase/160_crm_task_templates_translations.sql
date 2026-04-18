-- Переводы для страницы шаблонов автозадач CRM

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_crm_task_templates',               'Шаблоны автозадач',             'Auto-task templates',       'ऑटो-टास्क टेम्पलेट',         'Навигация CRM'),
  ('crm_task_templates_page_title',        'Шаблоны автозадач — CRM — ШРСК','Auto-task templates — CRM — SRSK','ऑटो-टास्क टेम्पलेट — CRM — SRSK','Заголовок страницы'),
  ('crm_task_template',                    'Шаблон задачи',                  'Task template',              'टास्क टेम्पलेट',              'Заголовок модалки'),
  ('crm_task_templates_new',               'Новый шаблон',                   'New template',               'नया टेम्पलेट',                'Заголовок модалки (создание)'),
  ('crm_task_templates_edit',              'Редактирование шаблона',         'Edit template',              'टेम्पलेट संपादित करें',        'Заголовок модалки (редактирование)'),
  ('crm_task_templates_default',           'По умолчанию',                   'Default',                    'डिफ़ॉल्ट',                    'Селектор ретрита'),
  ('crm_task_templates_stage',             'Стадия',                          'Stage',                      'चरण',                         'Поле стадии'),
  ('crm_task_templates_title',             'Название задачи',                 'Task title',                 'कार्य शीर्षक',                'Поле названия'),
  ('crm_task_templates_days_offset',       'Через (дней)',                    'After (days)',               'बाद (दिन)',                   'Поле смещения'),
  ('crm_task_templates_days_short',        '+дней',                           '+days',                       '+दिन',                         'Колонка таблицы'),
  ('crm_task_templates_is_active',         'Активен',                         'Active',                     'सक्रिय',                      'Поле активности'),
  ('crm_task_templates_guest_hint',        '— имя гостя',                     '— guest name',                '— अतिथि का नाम',               'Подсказка в форме'),
  ('crm_task_templates_hint',              'При входе сделки в стадию автоматически создаются задачи по активным шаблонам этой стадии. Используйте <code>{guest}</code> в названии для подстановки имени гостя.', 'When a deal enters a stage, tasks are auto-created from active templates of that stage. Use <code>{guest}</code> in the title to insert the guest name.', 'जब सौदा किसी चरण में प्रवेश करता है, तो उस चरण के सक्रिय टेम्पलेट से कार्य स्वचालित रूप से बनते हैं। शीर्षक में अतिथि का नाम डालने के लिए <code>{guest}</code> का उपयोग करें।', 'Подсказка в верху страницы'),
  ('crm_task_templates_override_notice',   'Если у ретрита есть свои шаблоны для стадии — они полностью заменяют дефолтные для этой стадии.', 'If a retreat has its own templates for a stage, they fully override the defaults for that stage.', 'यदि किसी रिट्रीट के पास चरण के लिए अपने टेम्पलेट हैं, तो वे उस चरण के डिफ़ॉल्ट को पूरी तरह से बदल देते हैं।', 'Предупреждение о переопределении'),
  ('crm_task_templates_empty',             'Нет шаблонов. Добавьте первый или скопируйте из «По умолчанию».', 'No templates. Add one or copy from "Default".', 'कोई टेम्पलेट नहीं। एक जोड़ें या "डिफ़ॉल्ट" से कॉपी करें।', 'Пустое состояние'),
  ('crm_task_templates_copy_defaults',     'Скопировать «По умолчанию»',      'Copy from "Default"',         '"डिफ़ॉल्ट" से कॉपी करें',      'Кнопка'),
  ('crm_task_templates_confirm_copy',      'Скопировать все дефолтные шаблоны в этот ретрит?', 'Copy all default templates to this retreat?', 'इस रिट्रीट में सभी डिफ़ॉल्ट टेम्पलेट कॉपी करें?', 'Подтверждение копирования'),
  ('crm_task_templates_confirm_delete',    'Удалить шаблон?',                 'Delete template?',            'टेम्पलेट हटाएं?',              'Подтверждение удаления'),
  ('crm_task_templates_no_defaults',       'Нет дефолтных шаблонов для копирования','No default templates to copy','कॉपी करने के लिए कोई डिफ़ॉल्ट टेम्पलेट नहीं','Уведомление')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context,
  updated_at = NOW();
