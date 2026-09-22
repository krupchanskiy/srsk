-- Переводы для клика по бейджу «уточнить плотность» на kitchen/products.html
insert into translations (key, ru, en, hi, context) values
('products_density_no_rights', 'Плотность может уточнить только шеф-повар или администратор', 'Only a chef or admin can specify density', 'केवल एक शेफ या प्रशासक घनत्व निर्दिष्ट कर सकता है', 'Кухня → Продукты'),
('products_density_count_unit', 'У этого продукта закупочная единица — «шт», плотность здесь не поможет. Проверьте единицу измерения продукта или единицу в рецепте.', 'This product''s purchase unit is "pcs" — density will not help here. Check the product''s unit or the recipe unit.', 'इस उत्पाद की खरीद इकाई "नग" है — यहाँ घनत्व काम नहीं आएगा। उत्पाद की इकाई या व्यंजन की इकाई जाँचें।', 'Кухня → Продукты')
on conflict (key) do nothing;
