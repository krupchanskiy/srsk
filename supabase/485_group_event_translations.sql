-- Переводы поля «Событие» на странице «Группы» (см. 484)
insert into translations (key, ru, en, hi, context) values
('group_event', 'Событие', 'Event', 'आयोजन', 'Группы → событие'),
('group_event_hint', 'Нужно, чтобы посчитать затраты на питание по ретриту или мероприятию. Самостоятельным гостям событие не нужно.', 'Needed to calculate meal costs per retreat or event. Independent guests do not need an event.', 'रिट्रीट या आयोजन के अनुसार भोजन का खर्च निकालने के लिए। स्वतंत्र अतिथियों के लिए आयोजन आवश्यक नहीं।', 'Группы → событие'),
('group_event_none', 'Без события (самостоятельные гости)', 'No event (independent guests)', 'कोई आयोजन नहीं (स्वतंत्र अतिथि)', 'Группы → событие'),
('group_event_own', 'Отдельное событие (сама группа)', 'Separate event (the group itself)', 'अलग आयोजन (स्वयं समूह)', 'Группы → событие'),
('group_event_retreat', 'Наш ретрит', 'Our retreat', 'हमारा रिट्रीट', 'Группы → событие')
on conflict (key) do nothing;
