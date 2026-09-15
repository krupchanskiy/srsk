-- Таблица «Ретрит / Кафе / Итого» в разделе «Финансы» отчёта по ретриту
insert into translations (key, ru, en, hi, context) values
('retreat_report_finance_retreat_only', 'Ретрит', 'Retreat', 'रिट्रीट', 'Строка таблицы финансов отчёта по ретриту'),
('retreat_report_finance_cafe', 'Кафе', 'Café', 'कैफ़े', 'Строка таблицы финансов отчёта по ретриту'),
('retreat_report_finance_total', 'Итого', 'Total', 'कुल', 'Строка таблицы финансов отчёта по ретриту')
on conflict (key) do nothing;
