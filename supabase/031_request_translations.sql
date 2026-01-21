-- ============================================
-- ПЕРЕВОДЫ ДЛЯ ЗАЯВОК НА ЗАКУПКУ
-- ============================================

insert into translations (key, ru, en, hi, context) values
('request', 'Заявка', 'Request', 'अनुरोध', 'Заявки'),
('items_short', 'поз.', 'items', 'आइटम', 'Заявки'),
('period', 'Период', 'Period', 'अवधि', 'Заявки'),
('created', 'Создано', 'Created', 'बनाया गया', 'Заявки'),
('view', 'Просмотр', 'View', 'देखें', 'Заявки'),
('print', 'Печать', 'Print', 'प्रिंट', 'Заявки'),
('to_archive', 'В архив', 'Archive', 'संग्रह में', 'Заявки'),
('restore', 'Восстановить', 'Restore', 'पुनर्स्थापित', 'Заявки'),
('delete', 'Удалить', 'Delete', 'हटाएं', 'Заявки'),
('no_active_requests', 'Нет сохранённых заявок', 'No saved requests', 'कोई सहेजे गए अनुरोध नहीं', 'Заявки'),
('archive_empty', 'Нет заявок в архиве', 'No archived requests', 'संग्रह में कोई अनुरोध नहीं', 'Заявки'),
('archive_confirm', 'Переместить в архив?', 'Move to archive?', 'संग्रह में ले जाएं?', 'Заявки'),
('permanent_delete_confirm', 'Удалить заявку навсегда?', 'Delete request permanently?', 'अनुरोध स्थायी रूप से हटाएं?', 'Заявки')

on conflict (key) do update set
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
