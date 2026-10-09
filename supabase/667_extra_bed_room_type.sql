-- 667: доп. кровать — третье место в номере «Два плюс один» (ВГ, 09.10.2026, «Шахматка 12»).
-- Номер остаётся трёхместным (запрет накладок, CRM, цены — как были); в шахматке
-- последнее место такого номера подписано «Доп. кровать», в окнах брони — «2 + доп. кровать»
-- и «осталась только доп. кровать». Доп. кровать обычно для семьи или близких друзей.
-- Номер с доп. кроватью = тип doubleplus: ГД №7, №8, №17 и №3 (у №3 стоял «Двухместная»
-- при 3 местах — исправлено). Коттеджи («Трёхместная») не трогаем — там три кровати.

update rooms set room_type_id = (select id from room_types where slug = 'doubleplus')
 where id = '993a5518-8f0f-48bc-878d-ffe787331d3e'   -- Гостевой дом №3
   and room_type_id = (select id from room_types where slug = 'double');

insert into translations (key, ru, en, hi, context) values
('timeline_extra_bed', 'Доп. кровать', 'Extra bed', 'अतिरिक्त बिस्तर', 'Шахматка'),
('timeline_room_two_plus', '2 + доп. кровать', '2 + extra bed', '2 + अतिरिक्त बिस्तर', 'Шахматка'),
('timeline_room_extra_only', 'осталась только доп. кровать', 'only the extra bed is left', 'केवल अतिरिक्त बिस्तर बचा है', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
