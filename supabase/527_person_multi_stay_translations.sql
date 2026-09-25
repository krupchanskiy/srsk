-- Карточка вайшнава: несколько броней одного ретрита — статус каждой
insert into translations (key, ru, en, hi, context) values
('person_stay_left', 'выехал(а)', 'left', 'जा चुके', 'Карточка вайшнава'),
('person_stay_now', 'живёт сейчас', 'staying now', 'अभी रह रहे हैं', 'Карточка вайшнава')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
