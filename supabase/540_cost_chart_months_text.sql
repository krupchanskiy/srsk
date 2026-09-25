-- Себестоимость → Графики: «Расходы на питание по месяцам» без линии, стоимость приёма пищи — под месяцем (ВГ 25.09)
insert into translations (key, ru, en, hi) values
 ('cost_ch_months', 'Расходы на питание по месяцам', 'Food costs by month', 'महीने के अनुसार भोजन खर्च'),
 ('cost_ch_months_note', 'Столбик — сколько потрачено за месяц и из чего (цвета — в подписи снизу). Под месяцем — стоимость одного приёма пищи: расход месяца ÷ число приёмов пищи. Наведите на столбик — подробности.', 'A bar shows how much was spent in the month and on what (colours are in the legend below). Under the month — the cost of one meal: month''s cost ÷ number of meals. Hover over a bar for details.', 'स्तंभ — महीने में कितना और किस पर खर्च हुआ (रंग नीचे संकेत में)। महीने के नीचे — एक भोजन की लागत: महीने का खर्च ÷ भोजनों की संख्या। विवरण के लिए स्तंभ पर माउस रखें।'),
 ('cost_ch_per_meal_short', 'за приём пищи', 'per meal', 'प्रति भोजन')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
