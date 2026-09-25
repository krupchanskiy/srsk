-- Себестоимость, режим «Ретрит»: справочная строка о команде и волонтёрах в те же дни
insert into translations (key, ru, en, hi, context) values
('cost_aside_title', 'Для сведения: в эти же дни ели', 'For reference: also ate on these days', 'जानकारी हेतु: इन्हीं दिनों भोजन किया', 'Себестоимость'),
('cost_aside_note', 'за счёт департаментов, в итог ретрита не входит', 'paid by departments, not included in the retreat total', 'विभागों के खर्च पर, रिट्रीट के कुल में शामिल नहीं', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
