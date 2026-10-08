-- Шахматка: короткие заголовки блоков самостоятельного проживания для узкой колонки
insert into translations (key, ru, en, hi, context) values
('timeline_self_short_guests', 'Вне ШРСК — гости', 'Outside SRSK — guests', 'SRSK के बाहर — अतिथि', 'Шахматка'),
('timeline_self_short_team', 'Вне ШРСК — команда', 'Outside SRSK — team', 'SRSK के बाहर — टीम', 'Шахматка'),
('timeline_self_header_hint', 'Живут вне ашрама. Здесь можно добавить человека или бронь.', 'Living outside the ashram. You can add a person or a booking here.', 'आश्रम के बाहर रहते हैं। यहाँ व्यक्ति या बुकिंग जोड़ सकते हैं।', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
