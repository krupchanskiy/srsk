insert into translations (key, ru, en, hi) values
    ('nav_worship_kits',   'Подборки', 'Reading kits', 'संकलन'),
    ('worship_kits_title', 'Подборки', 'Reading kits', 'संकलन'),
    ('worship_kits_hint',  'Дорожка для того, кто только начинает: что прочитать, что посмотреть и в каком порядке. Выданную подборку человек читает ещё до приезда, в портале гостя.',
                           'A path for someone just starting: what to read, what to look at, in what order. A granted kit is read before arrival, in the guest portal.',
                           'नए व्यक्ति के लिए मार्ग: क्या पढ़ें, क्या देखें और किस क्रम में। दिया गया संकलन अतिथि पोर्टल में आने से पहले ही पढ़ा जाता है।'),
    ('worship_new_kit',    'Новая подборка', 'New kit', 'नया संकलन'),
    ('worship_grants_title','Кому выдано', 'Granted to', 'किसे दिया गया'),
    ('worship_grants_hint','Выдача — это решение о раскрытии: содержимое уходит человеку, который не сотрудник отдела и, возможно, ещё не в ашраме. Выдачу можно отозвать, доступ закроется сразу.',
                           'Granting is a decision to disclose: the content goes to someone outside the department who may not even be in the ashram yet. A grant can be revoked, and access closes at once.',
                           'देना — प्रकटीकरण का निर्णय है: सामग्री उस व्यक्ति तक जाती है जो विभाग का सदस्य नहीं और शायद आश्रम में भी नहीं। देना वापस लिया जा सकता है, पहुँच तुरंत बंद हो जाती है।')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
