-- Кнопка «К аналитике» на странице отчёта по ретриту (finance/retreat-report.html)
insert into translations (key, ru, en, hi, context) values
('retreat_report_back_to_analytics', 'К аналитике', 'To analytics', 'एनालिटिक्स पर वापस', 'Кнопка возврата с отчёта по ретриту в финансовую аналитику')
on conflict (key) do nothing;
