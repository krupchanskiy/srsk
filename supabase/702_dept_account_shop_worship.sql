-- 702: «Счёт» департамента — в модулях Магазин и Поклонение, сводка по статьям (ВГ 18.10.2026).
-- Тот же общий код, что у кухни (js/pages/dept-account.js): страница находит департамент по
-- постоянному code, поэтому Магазину и Поклонению — свои коды (название можно менять свободно).

update fin_departments set code = 'shop'    where id = '70c237d2-1931-48fa-8dc1-4bcda013bbf3' and code is null; -- Магазин
update fin_departments set code = 'worship' where id = '409cdd00-bd47-49a3-9081-5a2835b9caf5' and code is null; -- Поклонение

insert into translations (key, ru, en, hi, context) values
('dacc_sum_in', 'Пришло — откуда', 'Came in — from where', 'आया — कहाँ से', 'Счёт департамента: сводка приходов по статьям'),
('dacc_sum_out', 'Ушло — на что', 'Went out — on what', 'गया — किस पर', 'Счёт департамента: сводка расходов по статьям'),
('dacc_sum_hint', 'За выбранный период, без отменённых операций. Нажмите строку — покажу эти операции', 'For the selected period, without reversed operations. Click a line to show those operations', 'चुनी गई अवधि के लिए, रद्द संचालन के बिना। संचालन देखने के लिए पंक्ति दबाएँ', 'Счёт департамента: подсказка к сводке'),
('dacc_sum_empty', 'Нет операций', 'No operations', 'कोई संचालन नहीं', 'Счёт департамента: пустая сводка'),
('dacc_sum_reset', 'Показать все', 'Show all', 'सभी दिखाएँ', 'Счёт департамента: сброс фильтра из сводки')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
