-- Шахматка: департамент и служение в брони, черновая карточка (ВГ 02.10.2026)
insert into translations (key, ru, en, hi) values
  ('timeline_service_placeholder', 'Например: повар', 'E.g.: cook', 'उदा.: रसोइया'),
  ('timeline_new_person_hint', 'Нет в справочнике — при сохранении будет заведена черновая карточка «{name}»', 'Not in the directory — a draft card «{name}» will be created on save', 'सूची में नहीं — सहेजने पर «{name}» का प्रारूप कार्ड बनेगा'),
  ('timeline_department_required', 'Выберите департамент: у волонтёра и команды он обязателен', 'Choose a department: it is required for volunteers and team', 'विभाग चुनें: स्वयंसेवकों और टीम के लिए अनिवार्य है'),
  ('timeline_person_required', 'Укажите человека: выберите из справочника или впишите имя — заведём черновую карточку', 'Specify the person: pick from the directory or type a name — a draft card will be created', 'व्यक्ति बताएं: सूची से चुनें या नाम लिखें — प्रारूप कार्ड बनेगा'),
  ('timeline_draft_card', 'Черновая карточка', 'Draft card', 'प्रारूप कार्ड'),
  ('timeline_draft_card_created', 'Заведена черновая карточка «{name}» — дополните её, когда будут данные', 'Draft card «{name}» created — complete it when details are known', 'प्रारूप कार्ड «{name}» बना — जानकारी मिलने पर पूरा करें'),
  ('timeline_department_saved', 'Департамент изменён', 'Department changed', 'विभाग बदला गया')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
