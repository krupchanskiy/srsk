-- 608: «Группы» (meal_groups) → «Разовое питание» (решение ВГ 02.10.2026).
-- Разовые приходы на день-два — здесь, в шахматку можно не заносить; регулярных — в шахматку.
update translations set ru = 'Разовое питание', en = 'One-time meals', hi = 'एक बार का भोजन' where key = 'nav_groups';
update translations set ru = 'Разовое питание без события', en = 'One-time meals without event', hi = 'बिना आयोजन के एक बार का भोजन' where key = 'cost_groups_no_event';
update translations set ru = 'Добавить', en = 'Add', hi = 'जोड़ें' where key = 'add_group';
update translations set ru = 'Изменить запись', en = 'Edit entry', hi = 'प्रविष्टि संपादित करें' where key = 'edit_group';
update translations set ru = 'Нет записей', en = 'No entries', hi = 'कोई प्रविष्टि नहीं' where key = 'no_groups';
update translations set ru = 'Кто пришёл', en = 'Who came', hi = 'कौन आया' where key = 'group_name';
update translations set ru = 'Сохранено', en = 'Saved', hi = 'सहेजा गया' where key = 'groups_saved';
update translations set ru = 'Удалено', en = 'Deleted', hi = 'हटाया गया' where key = 'groups_deleted';
update translations set ru = 'Удалить эту запись?', en = 'Delete this entry?', hi = 'यह प्रविष्टि हटाएं?' where key = 'groups_delete_confirm';
update translations set
    ru = 'Нужно, чтобы посчитать затраты на питание по ретриту или мероприятию. Если пришли не на ретрит и не на мероприятие — «Без события».',
    en = 'Needed to calculate meal costs per retreat or event. If they did not come for a retreat or event, choose «No event».',
    hi = 'रिट्रीट या आयोजन के अनुसार भोजन का खर्च निकालने के लिए। यदि वे किसी रिट्रीट या आयोजन के लिए नहीं आए — «कोई आयोजन नहीं» चुनें।'
 where key = 'group_event_hint';

insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'groups'
  from (values
    ('one_time_meals_rule',
     'Для разовых приходов: человек или группа пришли поесть на день-два, в шахматку можно не заносить. Кто ходит регулярно или живёт несколько дней — заведите в шахматку (бронь, в том числе без номера в «Самостоятельном проживании»).',
     'For one-time visits: a person or group came to eat for a day or two, no need to add them to the timeline. Anyone who comes regularly or stays several days — add to the timeline (a booking, also without a room in «Self accommodation»).',
     'एक बार आने वालों के लिए: कोई व्यक्ति या समूह एक-दो दिन भोजन करने आया — टाइमलाइन में जोड़ना ज़रूरी नहीं। जो नियमित आते हैं या कई दिन रहते हैं — उन्हें टाइमलाइन में जोड़ें (बुकिंग, «स्वयं आवास» में बिना कमरे के भी)।'),
    ('one_time_meals_long_warn',
     'Запись на %n дн. Если человек ходит регулярно или живёт у нас — заведите его в шахматку (бронь, можно без номера). Всё равно сохранить здесь?',
     'The entry covers %n days. If the person comes regularly or stays with us, add them to the timeline (a booking, room optional). Save here anyway?',
     'प्रविष्टि %n दिनों की है। यदि व्यक्ति नियमित आता है या हमारे यहाँ रहता है — उसे टाइमलाइन में जोड़ें (बुकिंग, कमरा वैकल्पिक)। फिर भी यहाँ सहेजें?'),
    ('one_time_meals_double_title',
     'Записаны и здесь, и в шахматке с питанием',
     'Listed both here and in the timeline with meals',
     'यहाँ भी और टाइमलाइन में भोजन के साथ भी दर्ज'),
    ('one_time_meals_double_hint',
     'кухня считает их дважды. Уберите запись здесь или сократите даты.',
     'the kitchen counts them twice. Remove the entry here or shorten the dates.',
     'रसोई इन्हें दो बार गिनती है। यहाँ से प्रविष्टि हटाएँ या तारीखें कम करें।'),
    ('one_time_meals_in_timeline', 'в шахматке', 'in the timeline', 'टाइमलाइन में')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
