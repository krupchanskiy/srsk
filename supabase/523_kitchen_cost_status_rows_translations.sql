-- Себестоимость, режим «Ретрит»: участники по статусу на сегодня
insert into translations (key, ru, en, hi, context) values
('cost_st_left', 'Уже уехали', 'Already left', 'जा चुके हैं', 'Себестоимость'),
('cost_st_here', 'Сейчас на ретрите', 'At the retreat now', 'अभी रिट्रीट में', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
