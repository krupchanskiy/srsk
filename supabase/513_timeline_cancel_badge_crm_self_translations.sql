-- Шахматка: красная плашка «Отмена» на брони, если сделка в CRM отменена (снимать руками),
-- и значок CRM у людей из «Сам организует» в блоке «Самостоятельное проживание»
insert into translations (key, ru, en, hi, context) values
('timeline_deal_cancelled', 'Отмена', 'Cancelled', 'रद्द', 'Шахматка'),
('timeline_deal_cancelled_hint', 'Сделка в CRM отменена — освободите место', 'CRM deal cancelled — free up the bed', 'CRM सौदा रद्द — स्थान खाली करें', 'Шахматка'),
('timeline_self_from_crm', 'Из сделки в CRM: «Сам организует»', 'From the CRM deal: «Arranges own stay»', 'CRM सौदे से: «स्वयं व्यवस्था करेंगे»', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
