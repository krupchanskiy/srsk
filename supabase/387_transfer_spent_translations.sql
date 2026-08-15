-- 387: переводы для галочки «деньги уже потрачены» в форме перевода
--
-- Оплатили билет за департамент напрямую с карты ашрама: учётно нужны обе
-- стороны — и выдача департаменту, и его расход. Раньше это делалось двумя
-- операциями руками (ВГ, 15.08).

insert into translations (key, ru, en, hi) values
('fin_transfer_spent',
 'Деньги уже потрачены получателем',
 'Recipient has already spent it',
 'प्राप्तकर्ता पहले ही खर्च कर चुका है'),
('fin_transfer_spent_hint',
 'Кроме перевода сразу проведём расход на ту же сумму по счёту получателя',
 'Along with the transfer we will post an expense of the same amount on the recipient''s account',
 'स्थानांतरण के साथ ही प्राप्तकर्ता के खाते में उतनी ही राशि का खर्च दर्ज होगा'),
('fin_transfer_spent_failed',
 'Перевод создан, а расход провести не удалось — проведите его отдельно',
 'Transfer created, but the expense failed — post it separately',
 'स्थानांतरण बन गया, पर खर्च दर्ज नहीं हुआ — उसे अलग से दर्ज करें')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
