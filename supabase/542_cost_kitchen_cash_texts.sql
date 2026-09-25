-- Себестоимость, режим «Период»: касса кухни и раздел «Касса» (ВГ 25.09)
insert into translations (key, ru, en, hi) values
 ('cost_kcash_title', 'Касса кухни — реальные деньги по датам поступления и оплаты', 'Kitchen cash — real money by date received and paid', 'रसोई नकद — प्राप्ति और भुगतान की तारीख के अनुसार वास्तविक पैसा'),
 ('cost_kcash_opening', 'Остаток на начало', 'Opening balance', 'प्रारंभिक शेष'),
 ('cost_kcash_closing', 'Остаток на конец', 'Closing balance', 'अंतिम शेष'),
 ('cost_kcash_in', 'Пришло за прасад', 'Received for prasad', 'प्रसाद के लिए प्राप्त'),
 ('cost_kcash_in_hint', 'оплаты за питание и пожертвования на прасад', 'meal payments and prasad donations', 'भोजन भुगतान और प्रसाद दान'),
 ('cost_kcash_out', 'Ушло с кухни', 'Spent by the kitchen', 'रसोई से खर्च'),
 ('cost_kcash_out_hint', 'всё со счетов департамента «Кухня»; кафе не входит', 'everything from the «Kitchen» department accounts; the cafe is not included', '«रसोई» विभाग के खातों से सब; कैफ़े शामिल नहीं'),
 ('cost_kcash_on', 'на', 'as of', 'तक'),
 ('cost_kcash_since', 'с начала учёта', 'since accounting began', 'लेखा शुरू होने से'),
 ('cost_kcash_no_data', 'в Финансах ещё нет операций', 'no operations in Finance yet', 'वित्त में अभी कोई लेन-देन नहीं'),
 ('cost_kcash_for_period', 'за период', 'for the period', 'अवधि में'),
 ('cost_kcash_net', 'За период', 'For the period', 'अवधि में'),
 ('cost_kcash_movement', 'движение денег', 'cash movement', 'नकद प्रवाह'),
 ('cost_kcash_team_note', 'Минус — не обязательно убыток: из этих денег питаются и постоянная команда с волонтёрами, их питание прасадом не оплачивается.', 'A minus is not necessarily a loss: the permanent team and volunteers also eat from this money, and their meals are not paid as prasad.', 'ऋण ज़रूरी नहीं कि घाटा हो: इसी पैसे से स्थायी टीम और स्वयंसेवक भी भोजन करते हैं, उनका भोजन प्रसाद के रूप में भुगतान नहीं होता।'),
 ('cost_kcash_note', 'Реальные деньги по датам: пришло — оплаты за питание и пожертвования на прасад, ушло — всё со счетов департамента «Кухня» (кафе не входит). Остаток переходит из месяца в месяц и из года в год. Минус — не обязательно убыток: из этих денег питаются и постоянная команда с волонтёрами. Выбранный период выделен серым.', 'Real money by date: received — meal payments and prasad donations; spent — everything from the «Kitchen» department accounts (the cafe is not included). The balance carries over from month to month and year to year. A minus is not necessarily a loss: the permanent team and volunteers also eat from this money. The selected period is highlighted in grey.', 'तारीख के अनुसार वास्तविक पैसा: प्राप्त — भोजन भुगतान और प्रसाद दान; खर्च — «रसोई» विभाग के खातों से सब (कैफ़े शामिल नहीं)। शेष महीने से महीने और साल से साल आगे जाता है। ऋण ज़रूरी नहीं कि घाटा हो: इसी पैसे से स्थायी टीम और स्वयंसेवक भी भोजन करते हैं। चुनी गई अवधि धूसर रंग में है।'),
 ('cost_section_cash', 'Касса', 'Cash', 'नकद'),
 ('cost_tab_cash_months', 'По месяцам', 'By month', 'महीने के अनुसार'),
 ('cost_tab_cash_years', 'По годам', 'By year', 'साल के अनुसार')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;

insert into translations (key, ru, en, hi) values
 ('cost_year', 'Год', 'Year', 'वर्ष'),
 ('cost_month', 'Месяц', 'Month', 'महीना')
on conflict (key) do nothing;
