-- 719: подсказка «По месяцам» — строки раскрываются операциями (ВГ 19.10)
insert into translations (key, ru, en, hi, context) values
('dacc_an_hint3', 'Оранжевое — трата в полтора раза больше обычной по статье, голубое — вдвое меньше. Нажмите статью — раскроются все её операции по месяцам, сумму за месяц — операции этого месяца', 'Orange — spending 1.5× above usual for the category, blue — half of usual. Click a category to expand all its operations by month, a month''s amount — that month''s operations', 'नारंगी — मद के सामान्य खर्च से डेढ़ गुना अधिक, नीला — आधा। मद पर क्लिक करें — महीनेवार सभी संचालन खुलेंगे, महीने की राशि पर — उस महीने के संचालन', 'Аналитика департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
