-- Подсказка, когда счёта в выбранной валюте нет: принять деньги некуда,
-- сначала нужно завести счёт в этой валюте
insert into translations (key, ru, en, hi) values
  ('fin_no_account_in_currency',
   'Нет счёта в этой валюте — заведите его в разделе «Счета»',
   'No account in this currency — create one in Accounts',
   'इस मुद्रा में कोई खाता नहीं — «खाते» में बनाएँ')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
