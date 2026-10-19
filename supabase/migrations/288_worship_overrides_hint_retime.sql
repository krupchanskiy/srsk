-- 288: подсказка «Праздники и отмены» — про сдвиг времени (миграция 287).
update translations set
    ru = 'Праздник или экадаши — это не второе расписание, а точечная правка: добавить службу на день, сдвинуть время службы на день или на несколько (ретрит) либо отметить, что она не проводится.',
    en = 'A festival or Ekadashi is not a second schedule but a spot change: add a service for a day, move a service to another time for a day or several (retreat), or mark that it is not held.',
    hi = 'पर्व या एकादशी दूसरा कार्यक्रम नहीं, केवल एक बदलाव है: किसी दिन सेवा जोड़ें, एक या कई दिनों (रिट्रीट) के लिए सेवा का समय बदलें, या चिह्नित करें कि सेवा नहीं होगी।'
 where key = 'worship_overrides_hint';
