-- Вес одной штуки продукта: перевод «шт» ↔ вес в рецептах и себестоимости
-- (лавровый лист «2 шт» в рецепте, а закупка в граммах). Живёт рядом с плотностью:
-- та же таблица, те же права (edit_kitchen_dictionaries), та же секция в карточке продукта.

alter table public.product_densities
    add column if not exists piece_grams numeric check (piece_grams > 0);

comment on column public.product_densities.piece_grams is 'Вес одной штуки, г — для перевода «шт» ↔ вес';

insert into translations (key, ru, en, hi, context) values
('density_piece', '1 штука, г', '1 piece, g', '1 नग, ग्राम', 'Кухня → Продукты'),
('density_piece_hint', 'Мелочь (лист, стручок) взвесьте пачкой: например, 20 штук, и разделите вес на 20.', 'Weigh small items (leaves, pods) in a batch: e.g. 20 pieces, then divide the weight by 20.', 'छोटी चीज़ें (पत्ता, फली) एक साथ तौलें: जैसे 20 नग, फिर वज़न को 20 से भाग दें।', 'Кухня → Продукты'),
('recipe_unit_no_piece_weight', 'нет веса 1 шт', 'no piece weight', '1 नग का वज़न नहीं', 'Кухня → Рецепт'),
('recipe_unit_no_piece_weight_hint', 'Ингредиент указан в штуках, а продукт закупается в весе (или наоборот): не задано, сколько весит одна штука. Себестоимость по этому ингредиенту не посчитается — укажите вес 1 шт в карточке продукта.', 'The ingredient is in pieces but the product is purchased by weight (or the other way around): the weight of one piece is not set. The cost of this ingredient will not be calculated — set the weight of 1 piece in the product card.', 'सामग्री नग में है, पर उत्पाद वज़न में खरीदा जाता है (या इसके विपरीत): एक नग का वज़न तय नहीं है। इस सामग्री की लागत की गणना नहीं होगी — उत्पाद कार्ड में 1 नग का वज़न बताएं।', 'Кухня → Рецепт')
on conflict (key) do nothing;

-- Уточнения существующих текстов: теперь секция включает вес штуки, а «не в весе» — только штуки ↔ объём
update translations set
    ru = 'Плотность и вес штуки (для перевода единиц рецепта)',
    en = 'Density and piece weight (for converting recipe units)',
    hi = 'घनत्व और नग का वज़न (व्यंजन की इकाइयों के रूपांतरण के लिए)'
where key = 'density_section_title';

update translations set
    ru = 'Сколько весит эта мера у данного продукта. Нужно, если в рецептах используются ложки/стаканы/литры или штуки, а закупочная единица продукта — вес (или наоборот).',
    en = 'How much this measure weighs for this product. Needed if recipes use spoons/cups/liters or pieces while the product''s purchase unit is weight (or the other way around).',
    hi = 'इस उत्पाद के लिए यह माप कितना वज़न रखती है। यदि व्यंजनों में चम्मच/कप/लीटर या नग उपयोग होते हैं जबकि उत्पाद की खरीद इकाई वज़न है (या इसके विपरीत), तो यह आवश्यक है।'
where key = 'density_section_hint';

update translations set
    ru = 'Единица рецепта — штуки, а продукт закупается в объёме (или наоборот): себестоимость по этому ингредиенту не посчитается. Укажите ингредиент в весе или объёме.',
    en = 'The recipe unit is pieces, but the product is purchased by volume (or the other way around): this ingredient''s cost will not be calculated. Specify the ingredient by weight or volume.',
    hi = 'व्यंजन की इकाई नग है, पर उत्पाद आयतन में खरीदा जाता है (या इसके विपरीत): इस सामग्री की लागत की गणना नहीं होगी। सामग्री को वज़न या आयतन में बताएं।'
where key = 'recipe_unit_count_mismatch_hint';
