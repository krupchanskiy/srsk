-- Шахматка: «+ Добавить» в блоке «Самостоятельное проживание»
insert into translations (key, ru, en, hi, context) values
('timeline_self_add', 'Добавить', 'Add', 'जोड़ें', 'Шахматка'),
('timeline_self_add_hint', 'без номера — живёт вне ашрама', 'no room — lives outside the ashram', 'कमरा नहीं — आश्रम के बाहर रहते हैं', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
