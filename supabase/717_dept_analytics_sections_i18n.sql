-- 717: разделы аналитики департамента — Сводка / По месяцам / Графики (ВГ 19.10, как «Себестоимость»)
insert into translations (key, ru, en, hi, context) values
('dacc_an_sec_summary', 'Сводка', 'Summary', 'सारांश', 'Аналитика департамента: раздел'),
('dacc_an_sec_table', 'По месяцам', 'By month', 'महीने के अनुसार', 'Аналитика департамента: раздел'),
('dacc_an_rev_from', 'Выручка — откуда', 'Revenue — from', 'राजस्व — कहाँ से', 'Аналитика департамента'),
('dacc_an_costs_on', 'Расходы — на что', 'Costs — on what', 'खर्च — किस पर', 'Аналитика департамента'),
('dacc_an_ch_result', 'Выручка, расходы и итог', 'Revenue, costs and result', 'राजस्व, खर्च और परिणाम', 'Аналитика департамента: график'),
('dacc_an_ch_costs', 'Расходы по статьям', 'Costs by category', 'मद के अनुसार खर्च', 'Аналитика департамента: график')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
