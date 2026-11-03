-- 769: «Разовое питание» → «Питание по заявке» (решение ВГ 03.11.2026): там же питание группы
-- ретрита «По дням», а не только разовые приходы. Вкладки «Текущие / Прошедшие».
update translations set ru = 'Питание по заявке', en = 'Meals on request', hi = 'अनुरोध पर भोजन' where key = 'nav_groups';
update translations set ru = 'Питание по заявке без события', en = 'Meals on request without event', hi = 'बिना आयोजन के अनुरोध पर भोजन' where key = 'cost_groups_no_event';
update translations set
    ru = 'Разовые приходы: человек или группа пришли поесть на день-два, в шахматку можно не заносить. Питание группы ретрита «По дням»: кухня считает только по числам заявки, в шахматке у мест галочек прасада нет. Кто ходит регулярно или живёт несколько дней сам по себе — заведите в шахматку.',
    en = 'One-time visits: a person or group came to eat for a day or two, no need to add them to the timeline. Retreat group meals «By day»: the kitchen counts only the numbers in the request, places in the timeline have no prasad ticks. Anyone who comes regularly or stays several days on their own — add to the timeline.',
    hi = 'एक बार आने वाले: कोई व्यक्ति या समूह एक-दो दिन भोजन करने आया — टाइमलाइन में जोड़ना ज़रूरी नहीं। रिट्रीट समूह का भोजन «दिन के अनुसार»: रसोई केवल अनुरोध की संख्याएँ गिनती है, टाइमलाइन में स्थानों पर प्रसाद के निशान नहीं होते। जो नियमित आते हैं या कई दिन अलग से रहते हैं — उन्हें टाइमलाइन में जोड़ें।'
 where key = 'one_time_meals_rule';
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'groups'
  from (values
    ('groups_tab_current', 'Текущие', 'Current', 'वर्तमान'),
    ('groups_tab_past', 'Прошедшие', 'Past', 'बीते हुए'),
    ('timeline_same_day_use_meals',
     'Заезд и выезд в один день — ни одной ночи. Чтобы покормить без ночёвки, внесите в «Питание по заявке»',
     'Check-in and check-out on the same day — no nights. To provide meals without a stay, add to «Meals on request»',
     'एक ही दिन आगमन और प्रस्थान — एक भी रात नहीं। बिना ठहरे भोजन के लिए «अनुरोध पर भोजन» में जोड़ें')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
