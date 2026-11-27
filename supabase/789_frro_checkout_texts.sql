-- 789: подписи окна выселения иностранца (Form III, выписка FRRO; ВГ 17.11.2026, «Form III Checkout 2»)
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_frro_hint', 'Иностранец: выезд отмечается на портале FRRO в течение суток. Нужны время отъезда и куда едет.', 'Foreigner: departure must be marked on the FRRO portal within 24 hours. Departure time and next destination are needed.', 'विदेशी: प्रस्थान 24 घंटे में FRRO पोर्टल पर दर्ज करना होता है। प्रस्थान का समय और अगला गंतव्य चाहिए।'),
    ('timeline_frro_next_destination', 'Куда едет (город, страна)', 'Next destination (city, country)', 'अगला गंतव्य (शहर, देश)'),
    ('timeline_frro_group', 'То же время и «куда едет» — всем иностранцам этой брони с тем же днём выезда', 'Same time and destination for all foreigners in this booking leaving the same day', 'इसी बुकिंग के उसी दिन जाने वाले सभी विदेशियों के लिए वही समय और गंतव्य'),
    ('timeline_frro_no_time', 'время отъезда', 'departure time', 'प्रस्थान का समय'),
    ('timeline_frro_no_dest', 'куда едет', 'next destination', 'अगला गंतव्य'),
    ('timeline_frro_missing', 'Иностранец: не указано — %s. Без этого его не выписать на портале FRRO (срок — сутки после отъезда). Выселить всё равно?', 'Foreigner: missing — %s. Without it the FRRO checkout cannot be done (deadline: 24 hours after departure). Check out anyway?', 'विदेशी: नहीं भरा — %s। इसके बिना FRRO पोर्टल पर चेकआउट नहीं होगा (समय सीमा: प्रस्थान के 24 घंटे)। फिर भी चेकआउट करें?')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
