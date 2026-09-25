-- «Счёт» департамента: предупреждение «по датам счёт уходил в минус»
insert into translations (key, ru, en, hi, context) values
('dacc_neg_title', 'По датам операций счёт уходил в минус', 'By operation dates the account went negative', 'लेन-देन की तिथियों के अनुसार खाता ऋणात्मक हुआ', 'Счёт департамента'),
('dacc_neg_days', 'дней', 'days', 'दिन', 'Счёт департамента'),
('dacc_neg_min', 'ниже всего', 'lowest', 'सबसे कम', 'Счёт департамента'),
('dacc_neg_hint', 'Траты проведены раньше, чем деньги пришли на счёт: перевод на счёт записан более поздней датой или не внесён. Проверьте даты переводов в ДДС.', 'Expenses are dated before the money arrived: the transfer to the account has a later date or is missing. Check transfer dates in the cash flow journal.', 'खर्च धन आने से पहले की तिथि के हैं: खाते में स्थानांतरण बाद की तिथि का है या दर्ज नहीं है। DDS में स्थानांतरण की तिथियाँ जाँचें।', 'Счёт департамента'),
('dacc_neg_show', 'Показать эти дни', 'Show these days', 'ये दिन दिखाएँ', 'Счёт департамента')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
