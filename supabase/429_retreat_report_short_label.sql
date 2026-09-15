-- Короткая подпись кнопки «Отчёт» в списке ретритов (ashram/retreats.html)
insert into translations (key, ru, en, hi, context) values
('retreat_report_short', 'Отчёт', 'Report', 'रिपोर्ट', 'Кнопка перехода к отчёту по ретриту')
on conflict (key) do nothing;
