-- Себестоимость порции в Меню (просьба Сундары Рупы 08.10): подписи и подсказки
insert into translations (key, ru, en, hi, context) values
('menu_cost_per_portion', 'порция', 'portion', 'भाग', 'Меню: себестоимость приёма пищи «₹N / порция»'),
('menu_cost_dish_hint', 'Себестоимость продуктов на 1 порцию по ценам на этот день', 'Food cost per portion at this day''s prices', 'इस दिन की कीमतों पर प्रति भाग खाद्य लागत', 'Меню: подсказка у цены блюда'),
('menu_cost_meal_hint', 'Себестоимость продуктов на 1 порцию: блюда + готовое со стороны. Без посуды, зарплат и общих расходов.', 'Food cost per portion: dishes + ready-made from outside. Excludes dishware, salaries and overheads.', 'प्रति भाग खाद्य लागत: व्यंजन + बाहर से तैयार। बर्तन, वेतन और सामान्य खर्च शामिल नहीं।', 'Меню: подсказка у цены приёма пищи'),
('menu_cost_partial', 'Посчитано не всё', 'Not everything is counted', 'सब कुछ नहीं गिना गया', 'Меню: часть продуктов без цены или плотности'),
('menu_cost_no_price', 'Нет цены', 'No price', 'कीमत नहीं', 'Меню: продукты без цены'),
('menu_cost_no_unit', 'Не переводится единица (нужна плотность или вес штуки)', 'Unit cannot be converted (density or piece weight needed)', 'इकाई नहीं बदली जा सकती (घनत्व या एक नग का वज़न चाहिए)', 'Меню: продукты без плотности')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
