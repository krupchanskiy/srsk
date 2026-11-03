-- 770: заявка «Питание по заявке» прямо из шахматки (решение ВГ 03.11.2026):
-- в брони группы — «По заявке — числа по дням», в «+ Добавить» гостей — «Только питание группы»;
-- после сохранения заявки — предложение снять прасад у мест ретрита на те же дни.
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_meal_by_request', 'По заявке — числа по дням', 'On request — numbers by day', 'अनुरोध पर — दिन के अनुसार संख्या'),
    ('timeline_meal_open', 'Открыть заявку', 'Open request', 'अनुरोध खोलें'),
    ('timeline_meal_need_retreat', 'Сначала выберите ретрит: заявка по дням привязана к ретриту', 'Choose a retreat first: a by-day request is tied to a retreat', 'पहले रिट्रीट चुनें: दिन के अनुसार अनुरोध रिट्रीट से जुड़ा है'),
    ('timeline_meal_only_group', 'Только питание группы', 'Group meals only', 'केवल समूह का भोजन'),
    ('mge_seat_no_name', 'место без имени', 'unnamed place', 'बिना नाम का स्थान'),
    ('mge_and_more', 'и ещё', 'and more', 'और'),
    ('mge_clear_prasad_ask', 'Мест ретрита с прасадом на эти дни: %n — кухня посчитает их второй раз, сверх заявки. Снять у них завтрак и обед?', 'Retreat places with prasad on these days: %n — the kitchen will count them a second time, on top of the request. Remove breakfast and lunch from them?', 'इन दिनों प्रसाद वाले रिट्रीट स्थान: %n — रसोई उन्हें अनुरोध के ऊपर दूसरी बार गिनेगी। उनसे नाश्ता और दोपहर का भोजन हटाएँ?'),
    ('mge_prasad_cleared', 'Прасад снят у мест: %n', 'Prasad removed from places: %n', 'स्थानों से प्रसाद हटाया गया: %n')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
