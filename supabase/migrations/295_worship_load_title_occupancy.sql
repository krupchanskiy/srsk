-- 295: вкладка «Загрузка» → «Занятость» (просьба Адриана 25.10.2026).
update translations set ru = 'Занятость', en = 'Workload', hi = 'व्यस्तता' where key = 'worship_load_title';

-- Новый ключ: у браузеров переводы закешированы на сутки, и старый ключ
-- ещё сутки показывал бы «Загрузка». Под новым ключом в кеше пусто —
-- страница сразу берёт «Занятость» из разметки.
insert into translations (key, ru, en, hi) values ('worship_occupancy_title', 'Занятость', 'Workload', 'व्यस्तता')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
