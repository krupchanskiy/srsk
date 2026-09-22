-- Переводы предупреждения «нет плотности» в редакторе рецепта (kitchen/recipe-edit.html)
insert into translations (key, ru, en, hi, context) values
('recipe_unit_unresolved', 'нет плотности', 'no density', 'घनत्व नहीं', 'Кухня → Рецепт'),
('recipe_unit_unresolved_hint', 'Единица рецепта не переводится в закупочную единицу продукта: не задано, сколько грамм в этой ложке/стакане/литре у данного продукта. Себестоимость по этому ингредиенту не посчитается — уточните в карточке продукта.', 'The recipe unit cannot be converted to the product''s purchase unit: it is not set how many grams this spoon/cup/liter is for this product. The cost of this ingredient will not be calculated — specify it in the product card.', 'व्यंजन की इकाई उत्पाद की खरीद इकाई में परिवर्तित नहीं होती: यह तय नहीं है कि इस उत्पाद के लिए यह चम्मच/कप/लीटर कितने ग्राम का है। इस सामग्री की लागत की गणना नहीं होगी — उत्पाद कार्ड में बताएं।', 'Кухня → Рецепт')
on conflict (key) do nothing;
