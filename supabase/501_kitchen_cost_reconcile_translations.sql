-- Переводы блока «Сверка с ДДС» на kitchen/cost.html (этап 7)
insert into translations (key, ru, en, hi, context) values
('cost_reconcile_title', 'Сверка с ДДС', 'Cash-flow reconciliation', 'नकद प्रवाह मिलान', 'Кухня → Себестоимость'),
('cost_reconcile_hint', 'Расчёт — что должно было потратиться по рецептам, ценам и вкушающим этого периода. Факт — что реально прошло по кассе на прямых статьях кухни за те же даты. Расхождение — не обязательно ошибка: закупка «про запас» попадает в кассу раньше, чем блюдо будет приготовлено.', 'Calculated — what should have been spent by recipes, prices and diners of this period. Actual — what really went through the till on the kitchen''s direct categories for the same dates. A gap is not necessarily an error: stocking up shows in the till earlier than the dish is actually cooked.', 'गणना — इस अवधि के व्यंजनों, कीमतों और भोजन करने वालों के अनुसार क्या खर्च होना चाहिए था। तथ्य — उन्हीं तारीखों में रसोई की प्रत्यक्ष मदों पर नकद में वास्तव में क्या हुआ। अंतर ज़रूरी नहीं कि गलती हो: स्टॉक जमा करना खाना पकने से पहले ही नकद में दिखता है।', 'Кухня → Себестоимость'),
('cost_reconcile_category', 'Статья', 'Category', 'मद', 'Кухня → Себестоимость'),
('cost_reconcile_model', 'Расчёт', 'Calculated', 'गणना', 'Кухня → Себестоимость'),
('cost_reconcile_actual', 'Факт по ДДС', 'Actual (cash flow)', 'तथ्य (नकद प्रवाह)', 'Кухня → Себестоимость'),
('cost_reconcile_diff', 'Разница', 'Difference', 'अंतर', 'Кухня → Себестоимость'),
('cost_reconcile_na', 'нет в модели', 'not modeled', 'मॉडल में नहीं', 'Кухня → Себестоимость'),
('cost_cat_dept_food', 'Продукты', 'Ingredients', 'सामग्री', 'Кухня → Себестоимость'),
('cost_cat_disposable_tableware', 'Одноразовая посуда', 'Disposable tableware', 'डिस्पोज़ेबल बर्तन', 'Кухня → Себестоимость'),
('cost_cat_prasad_order', 'Закупка готового Прасада', 'Ready-made prasad purchase', 'तैयार प्रसाद की खरीद', 'Кухня → Себестоимость'),
('cost_cat_strategic_stock', 'Стратегический запас', 'Strategic stock', 'रणनीतिक भंडार', 'Кухня → Себестоимость'),
('cost_reconcile_total', 'Итого сопоставимых', 'Total comparable', 'तुलनीय कुल', 'Кухня → Себестоимость')
on conflict (key) do nothing;
