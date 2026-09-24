-- Себестоимость, вкладка «Вкушающие»: разбивка по департаментам и предупреждение «без департамента»
insert into translations (key, ru, en, hi, context) values
('cost_by_department', 'По департаментам', 'By department', 'विभागों के अनुसार', 'Себестоимость'),
('cost_by_department_hint', 'Департамент — из карточки человека. Стоимость — приёмы пищи человека по стоимости приёма пищи его ретрита или категории.', 'Department comes from the person''s card. Cost is the person''s meals at the meal cost of their retreat or category.', 'विभाग — व्यक्ति के कार्ड से। लागत — व्यक्ति के भोजन, उसके रिट्रीट या श्रेणी की प्रति भोजन लागत पर।', 'Себестоимость'),
('cost_department', 'Департамент', 'Department', 'विभाग', 'Себестоимость'),
('cost_no_department', 'Без департамента', 'No department', 'बिना विभाग', 'Себестоимость'),
('cost_dept_guests', 'Гости', 'Guests', 'अतिथि', 'Себестоимость'),
('cost_per_month', 'В месяц', 'Per month', 'प्रति माह', 'Себестоимость'),
('cost_w_no_department', 'Команда и волонтёры без департамента — укажите департамент в карточке человека', 'Team and volunteers without a department — set the department in the person''s card', 'बिना विभाग के टीम और स्वयंसेवक — व्यक्ति के कार्ड में विभाग दर्ज करें', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
