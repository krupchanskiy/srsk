-- Текст для случая, когда у проверки нет расшифровки
insert into translations (key, ru, en, hi) values
  ('fin_signal_no_details', 'Расшифровки для этой проверки пока нет — смотрите в ДДС',
   'No breakdown for this check yet — see the ledger', 'इस जाँच का विवरण अभी नहीं है')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
