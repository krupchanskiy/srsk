-- 703: «Счёт» департамента — вкладка «Аналитика»: статьи по месяцам / кварталам / годам (ВГ 18.10.2026).
insert into translations (key, ru, en, hi, context) values
('dacc_view_ops', 'Операции', 'Operations', 'संचालन', 'Счёт департамента: вкладка'),
('dacc_view_analytics', 'Аналитика', 'Analytics', 'विश्लेषण', 'Счёт департамента: вкладка'),
('dacc_an_vs_avg', 'к обычному', 'vs usual', 'सामान्य की तुलना में', 'Счёт департамента: аналитика'),
('dacc_an_avg', 'В среднем', 'Average', 'औसत', 'Счёт департамента: аналитика'),
('dacc_an_other', 'Прочее', 'Other', 'अन्य', 'Счёт департамента: аналитика'),
('dacc_an_hint', 'Период — выбранный выше. Оранжевое — в полтора раза больше обычного по статье, голубое — вдвое меньше. Нажмите сумму — покажу эти операции', 'Period is the one selected above. Orange — 1.5× above the usual for the category, blue — half or less. Click an amount to see those operations', 'अवधि — ऊपर चुनी गई। नारंगी — श्रेणी के सामान्य से 1.5 गुना अधिक, नीला — आधा या कम। संचालन देखने के लिए राशि दबाएँ', 'Счёт департамента: аналитика')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
