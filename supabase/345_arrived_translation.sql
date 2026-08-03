-- Галочка «Гость уже приехал» в форме заселения.
insert into translations (key, ru, en, hi) values
  ('timeline_arrived', 'Гость уже приехал', 'Guest has arrived', 'अतिथि आ चुके हैं')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
