-- Строка «Прасад» в таблице «Ретрит / Прасад / Кафе / Итого» (см. 435)
insert into translations (key, ru, en, hi, context) values
('retreat_report_finance_prasad', 'Прасад', 'Prasad', 'प्रसाद', 'Строка таблицы финансов отчёта по ретриту')
on conflict (key) do nothing;
