-- 713: переводы вкладок страницы департамента: Подотчёт / Выручка / Касса ДДС (ВГ 19.10)
insert into translations (key, ru, en, hi, context) values
('dacc_view_own', 'Подотчёт', 'Advance account', 'अग्रिम खाता', 'Страница департамента: вкладка'),
('dacc_view_revenue', 'Выручка', 'Revenue', 'राजस्व', 'Страница департамента: вкладка'),
('dacc_view_box', 'Касса ДДС', 'Cash desk', 'कैश डेस्क', 'Страница департамента: вкладка'),
('dacc_box_now', 'В кассе ДДС', 'In the cash desk', 'कैश डेस्क में', 'Страница департамента: итог'),
('dacc_given', 'Выдано', 'Given', 'दिया गया', 'Страница департамента: итог'),
('dacc_income_on_acc', 'Пришло на счёт', 'Received on the account', 'खाते में आया', 'Страница департамента: итог'),
('dacc_rev_total', 'Выручка за период', 'Revenue for the period', 'अवधि का राजस्व', 'Страница департамента: выручка'),
('dacc_rev_hint', 'с любого счёта, куда сдали деньги; «≈» — в рупиях по курсу дня', 'from whichever account the money was handed in to; «≈» is in rupees at the day''s rate', 'जिस भी खाते में पैसा जमा हुआ; «≈» — दिन की दर पर रुपये में', 'Страница департамента: выручка'),
('dacc_rev_account', 'Куда сдано', 'Handed in to', 'कहाँ जमा किया', 'Страница департамента: выручка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
