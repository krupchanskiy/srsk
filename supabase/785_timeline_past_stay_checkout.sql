-- Шахматка: «Жил — выселить» у брони, даты которой прошли, а «Заселить» не нажали (ВГ 16.11.2026)
insert into translations (key, ru, en, hi, context) values
('timeline_past_stay_checkout', 'Жил — выселить', 'Stayed — check out', 'रुके — चेक-आउट', 'Шахматка'),
('timeline_past_stay_confirm', '%s: %d. Отметить «заселён» и «выселен»?', '%s: %d. Mark as checked in and checked out?', '%s: %d. चेक-इन और चेक-आउट दर्ज करें?', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
