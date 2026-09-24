-- «Гость без события» вместо «Самостоятельный гость»: слово «самостоятельный» оставляем только
-- за проживанием вне ашрама (решение ВГ 24.09.2026). Блок под шахматкой — «Самостоятельное проживание».
insert into translations (key, ru, en, hi, context) values
('timeline_self_guest', 'Гость без события', 'Guest without event', 'बिना आयोजन के अतिथि', 'Шахматка'),
('timeline_self_block', 'Самостоятельное проживание', 'Self-arranged accommodation', 'स्व-व्यवस्थित आवास', 'Шахматка'),
('group_event_none', 'Без события', 'No event', 'कोई आयोजन नहीं', 'Группы'),
('group_event_hint', 'Нужно, чтобы посчитать затраты на питание по ретриту или мероприятию. Если группа приехала не на ретрит и не на мероприятие — «Без события».', 'Needed to calculate meal costs per retreat or event. If the group did not come for a retreat or event, choose «No event».', 'रिट्रीट या आयोजन के अनुसार भोजन का खर्च निकालने के लिए। यदि समूह किसी रिट्रीट या आयोजन के लिए नहीं आया है — «कोई आयोजन नहीं» चुनें।', 'Группы')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
