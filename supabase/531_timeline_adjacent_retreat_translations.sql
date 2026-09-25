-- Шахматка: соседняя бронь встык с другим ретритом — предложить тот же ретрит
insert into translations (key, ru, en, hi, context) values
('timeline_adjacent_retreat_q',
 'Соседняя бронь этого человека встык ({range}) — {cur}. Поставить и на неё «{retreat}»?',
 'This person''s adjacent booking ({range}) is {cur}. Set «{retreat}» on it too?',
 'इस व्यक्ति की सटी हुई बुकिंग ({range}) — {cur}। क्या उस पर भी «{retreat}» लगाएँ?',
 'Шахматка'),
('timeline_adjacent_no_retreat', 'без ретрита', 'without a retreat', 'बिना रिट्रीट', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
