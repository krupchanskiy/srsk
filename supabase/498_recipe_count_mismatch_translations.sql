-- Переводы отдельного сигнала «не в весе» (штуки vs вес/объём) в редакторе рецепта — см. 495
insert into translations (key, ru, en, hi, context) values
('recipe_unit_count_mismatch', 'не в весе', 'not in weight', 'वज़न में नहीं', 'Кухня → Рецепт'),
('recipe_unit_count_mismatch_hint', 'Единица рецепта — штуки, а продукт закупается в весе/объёме (или наоборот): себестоимость по этому ингредиенту не посчитается. Укажите вес — например, вместо «2 шт» напишите, сколько это в граммах.', 'The recipe unit is pieces, but the product is purchased by weight/volume (or the other way around): this ingredient''s cost will not be calculated. Specify the weight — e.g. instead of "2 pcs" write how many grams that is.', 'व्यंजन की इकाई नग है, पर उत्पाद वज़न/आयतन में खरीदा जाता है (या इसके विपरीत): इस सामग्री की लागत की गणना नहीं होगी। वज़न बताएं — जैसे "2 नग" की जगह लिखें कि यह कितने ग्राम है।', 'Кухня → Рецепт')
on conflict (key) do nothing;
