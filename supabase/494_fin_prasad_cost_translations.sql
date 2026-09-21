-- Переводы блока «Прасад: расчётная себестоимость» в финансовой аналитике (этап 6)
insert into translations (key, ru, en, hi, context) values
('fin_prasad_cost_title', 'Прасад: расчётная себестоимость', 'Prasad: calculated cost', 'प्रसाद: गणना की गई लागत', 'Финансы → Аналитика'),
('fin_prasad_cost_prov', 'предварительно', 'preliminary', 'अनंतिम', 'Финансы → Аналитика'),
('fin_prasad_cost_prov_hint', 'Период расходов ещё не закончился или зарплата взята оценкой', 'The expense period is not over yet or a salary is an estimate', 'खर्च की अवधि अभी समाप्त नहीं हुई या वेतन अनुमान से लिया गया है', 'Финансы → Аналитика'),
('fin_prasad_cost_gaps', 'Пробелы в данных', 'Data gaps', 'डेटा में कमियाँ', 'Финансы → Аналитика'),
('fin_prasad_cost_total', 'Себестоимость всего', 'Total cost', 'कुल लागत', 'Финансы → Аналитика'),
('fin_prasad_cost_per_person', 'На человека', 'Per person', 'प्रति व्यक्ति', 'Финансы → Аналитика'),
('fin_prasad_cost_person_meals', 'человеко-приёмов', 'person-meals', 'व्यक्ति-भोजन', 'Финансы → Аналитика'),
('fin_prasad_cost_income', 'Приход прасада (по ДДС)', 'Prasad income (cash flow)', 'प्रसाद की आय (नकद प्रवाह)', 'Финансы → Аналитика'),
('fin_prasad_cost_result', 'Результат: приход минус себестоимость', 'Result: income minus cost', 'परिणाम: आय घटा लागत', 'Финансы → Аналитика'),
('fin_prasad_cost_dds', 'Для справки: расход прасада по ДДС (не суммируется с расчётом)', 'For reference: prasad expenses in cash flow (not added to the calculation)', 'संदर्भ के लिए: नकद प्रवाह में प्रसाद का खर्च (गणना में नहीं जोड़ा जाता)', 'Финансы → Аналитика'),
('fin_prasad_cost_note', 'Расчёт по вкушающим, рецептам, ценам кухни и накладным расходам. Это те же затраты, что и в расходах ДДС, посчитанные по модели, поэтому одна сумма не считается дважды.', 'Calculated from diners, recipes, kitchen prices and overhead. These are the same costs as the cash-flow expenses, computed by the model, so nothing is counted twice.', 'भोजन करने वालों, व्यंजनों, रसोई की कीमतों और ओवरहेड से गणना। ये वही खर्च हैं जो नकद प्रवाह में हैं, मॉडल से गिने गए, इसलिए कुछ भी दो बार नहीं गिना जाता।', 'Финансы → Аналитика'),
('fin_prasad_cost_long', 'Расчётная себестоимость прасада считается за период не длиннее трёх месяцев', 'Calculated prasad cost is available for periods of up to three months', 'प्रसाद की गणना की गई लागत अधिकतम तीन महीने की अवधि के लिए उपलब्ध है', 'Финансы → Аналитика'),
('fin_prasad_cost_details', 'Подробнее', 'Details', 'विवरण', 'Финансы → Аналитика'),
('fin_prasad_cost_direct', 'Прямые затраты', 'Direct costs', 'प्रत्यक्ष लागत', 'Финансы → Аналитика'),
('fin_prasad_cost_overhead', 'Накладные', 'Overhead', 'ओवरहेड', 'Финансы → Аналитика')
on conflict (key) do nothing;
