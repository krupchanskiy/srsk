-- Переводы редактора плотности и фильтра «не уточнена плотность» на kitchen/products.html
insert into translations (key, ru, en, hi, context) values
('products_filter_density_issue', 'Не уточнена плотность', 'Density not specified', 'घनत्व निर्दिष्ट नहीं', 'Кухня → Продукты'),
('products_density_issue', 'уточнить плотность', 'specify density', 'घनत्व बताएं', 'Кухня → Продукты'),
('products_density_issue_hint', 'Закупочная единица неудобна для закупки (ложка/стакан) или в рецептах эта единица не переводится в закупочную — не указано, сколько грамм в ложке/стакане/литре у этого продукта. Уточните в карточке продукта.', 'The purchase unit is impractical (a spoon/cup) or a recipe unit cannot be converted to the purchase unit — it is not set how many grams a spoon/cup/liter of this product weighs. Specify it in the product card.', 'खरीद इकाई असुविधाजनक है (चम्मच/कप) या व्यंजन की इकाई खरीद इकाई में परिवर्तित नहीं होती — यह तय नहीं है कि इस उत्पाद का चम्मच/कप/लीटर कितने ग्राम का है। उत्पाद कार्ड में बताएं।', 'Кухня → Продукты'),
('density_section_title', 'Плотность (для рецептов в ложках/стаканах/литрах)', 'Density (for recipes using spoons/cups/liters)', 'घनत्व (चम्मच/कप/लीटर वाले व्यंजनों के लिए)', 'Кухня → Продукты'),
('density_section_hint', 'Сколько весит эта мера объёма у данного продукта. Нужно, если в рецептах используются ложки/стаканы/литры, а закупочная единица продукта — вес (или наоборот).', 'How much this measure of volume weighs for this product. Needed if recipes use spoons/cups/liters while the product''s purchase unit is weight (or the other way around).', 'इस उत्पाद के लिए यह आयतन माप कितना वज़न रखती है। यदि व्यंजनों में चम्मच/कप/लीटर उपयोग होते हैं जबकि उत्पाद की खरीद इकाई वज़न है (या इसके विपरीत), तो यह आवश्यक है।', 'Кухня → Продукты'),
('density_tsp', '1 чайная ложка, г', '1 teaspoon, g', '1 चम्मच, ग्राम', 'Кухня → Продукты'),
('density_tbsp', '1 столовая ложка, г', '1 tablespoon, g', '1 बड़ा चम्मच, ग्राम', 'Кухня → Продукты'),
('density_cup', '1 стакан, г', '1 cup, g', '1 कप, ग्राम', 'Кухня → Продукты'),
('density_liter', '1 литр, г', '1 liter, g', '1 लीटर, ग्राम', 'Кухня → Продукты')
on conflict (key) do nothing;
