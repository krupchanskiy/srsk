-- 625: строка расчёта процента отделу продаж в итогах ретрита (аналитика) и «в т. ч.» в карточке участника
insert into translations (key, ru, en, hi) values
  ('fin_sales_fee_pending', 'Процент отделу продаж — расчёт, не зафиксировано', 'Sales team fee — estimate, not fixed', 'बिक्री विभाग शुल्क — अनुमान, स्थिर नहीं'),
  ('fin_sales_fee_pending_delta', 'Процент отделу продаж — изменилось после фиксации, не проведено', 'Sales team fee — changed since fixing, not posted', 'बिक्री विभाग शुल्क — स्थिर करने के बाद बदला, दर्ज नहीं'),
  ('fin_incl', 'в т. ч.', 'incl.', 'जिसमें')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
