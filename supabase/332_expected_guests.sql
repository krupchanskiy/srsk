-- Ожидаемые гости: бронь есть, «Заселить» ещё не нажимали.
--
-- Просьба ВГ (02.08.2026): «Существует единая динамическая группа „Ожидаемые
-- гости“, которая в любой момент времени показывает актуальное количество
-- гостей, планирующих заезд на выбранную дату».
insert into translations (key, ru, en, hi) values
  ('expected_guests',    'Ожидаются',        'Expected',          'अपेक्षित'),
  ('expected_guest_row', 'Ожидается заезд',  'Awaiting check-in', 'चेक-इन की प्रतीक्षा')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
