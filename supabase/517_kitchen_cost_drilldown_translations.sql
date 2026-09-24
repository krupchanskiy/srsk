-- Себестоимость: вкладка «Команда и волонтёры», раскрывающиеся списки людей, приходов и расходов
insert into translations (key, ru, en, hi, context) values
('cost_tab_departments', 'Команда и волонтёры', 'Team and volunteers', 'टीम और स्वयंसेवक', 'Себестоимость'),
('cost_to_departments', 'По департаментам →', 'By department →', 'विभागों के अनुसार →', 'Себестоимость'),
('cost_people_short', 'чел.', 'ppl', 'लोग', 'Себестоимость'),
('cost_unnamed_booking', 'Бронь без имени', 'Unnamed booking', 'बिना नाम की बुकिंग', 'Себестоимость'),
('cost_show_income', 'Показать приходы', 'Show income', 'आय दिखाएँ', 'Себестоимость'),
('cost_income_ops', 'Приходы прасада ретрита', 'Retreat prasad income', 'रिट्रीट की प्रसाद आय', 'Себестоимость'),
('cost_income_whole', 'весь ретрит; в период входит', 'whole retreat; share in the period', 'पूरा रिट्रीट; अवधि में हिस्सा', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
