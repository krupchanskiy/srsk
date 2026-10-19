-- 716: подсказка под таблицей аналитики департамента
insert into translations (key, ru, en, hi, context) values
('dacc_an_hint2', 'Оранжевое — трата в полтора раза больше обычной по статье, голубое — вдвое меньше. Нажмите сумму — покажу эти операции', 'Orange — spending 1.5× above usual for the category, blue — half of usual. Click an amount to see the operations', 'नारंगी — मद के सामान्य खर्च से डेढ़ गुना अधिक, नीला — आधा। संचालन देखने के लिए राशि पर क्लिक करें', 'Аналитика департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
