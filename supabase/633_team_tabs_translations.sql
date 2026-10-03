-- «Неполные»: у живущих — «живёт с», у будущих — «заезд» (ВГ 03.10.2026, чат «Вайшнавы 1»)
insert into translations (key, ru, en, hi) values
  ('incomplete_living_since', 'живёт с', 'staying since', 'से रह रहे हैं')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
