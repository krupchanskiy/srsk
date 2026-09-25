-- Себестоимость → Сверка с ДДС: понятные названия, сверка только в режиме «Период» (ВГ 25.09)
update translations set ru = 'Траты по меню (расчёт)', en = 'Spent by menu (calculated)', hi = 'मेनू के अनुसार खर्च (गणना)'
where key = 'cost_reconcile_model';
update translations set ru = 'Куплено (ДДС)', en = 'Bought (cash flow)', hi = 'खरीदा गया (नकद प्रवाह)'
where key = 'cost_reconcile_actual';
update translations set ru = 'не сравнивается — закупка впрок', en = 'not compared — stocking up', hi = 'तुलना नहीं — भंडार के लिए खरीद'
where key = 'cost_reconcile_na';
update translations set
 ru = 'Проверка кухни: сколько продуктов и посуды должно было уйти по меню (рецепты × цены × вкушающие) и сколько реально купили по кассе за те же даты. Зарплаты, билеты и оборудование здесь не сверяются — они и так берутся из ДДС. Расхождение не обязательно ошибка: закупка про запас попадает в кассу раньше, чем блюдо приготовлено.',
 en = 'Kitchen check: how much food and tableware should have been used by the menu (recipes × prices × diners) and how much was actually bought through the till for the same dates. Salaries, tickets and equipment are not reconciled here — they are taken from cash flow anyway. A gap is not necessarily an error: stocking up shows in the till earlier than the dish is cooked.',
 hi = 'रसोई की जाँच: मेनू के अनुसार (व्यंजन × कीमतें × भोजन करने वाले) कितना सामान और बर्तन लगना चाहिए था और उन्हीं तारीखों में नकद से वास्तव में कितना खरीदा गया। वेतन, टिकट और उपकरण यहाँ नहीं मिलाए जाते — वे वैसे भी नकद प्रवाह से लिए जाते हैं। अंतर ज़रूरी नहीं कि गलती हो: स्टॉक जमा करना खाना पकने से पहले ही नकद में दिखता है।'
where key = 'cost_reconcile_hint';

insert into translations (key, ru, en, hi) values
 ('cost_reconcile_scope', 'Вся кухня за', 'Whole kitchen for', 'पूरी रसोई'),
 ('cost_reconcile_scope_note', 'все, кто ел, и все закупки кухни — не только ретриты', 'everyone who ate and all kitchen purchases — not only retreats', 'सभी भोजन करने वाले और रसोई की सभी खरीद — केवल रिट्रीट नहीं'),
 ('cost_reconcile_no_prices', 'Цены не внесены — «Траты по меню» пока 0, сверка заработает после внесения цен', 'Prices are not entered — «Spent by menu» is 0 for now, reconciliation will work once prices are entered', 'कीमतें दर्ज नहीं हैं — «मेनू के अनुसार खर्च» अभी 0 है, कीमतें दर्ज होने पर मिलान काम करेगा'),
 ('cost_reconcile_diff_hint', 'Траты по меню минус куплено. Минус — купили больше, чем ушло по меню; плюс — меньше.', 'Spent by menu minus bought. Negative — bought more than the menu used; positive — less.', 'मेनू के अनुसार खर्च घटा खरीदा गया। ऋण — मेनू से अधिक खरीदा; धन — कम।')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
