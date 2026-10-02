-- Шахматка: категория брони подсказана по статусу человека в карточке (ВГ 02.10.2026)
insert into translations (key, ru, en, hi) values
  ('timeline_category_by_status', 'по статусу в карточке', 'by status in the card', 'कार्ड में स्थिति के अनुसार')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
