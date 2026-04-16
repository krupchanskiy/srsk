-- Добавление недостающих ключей переводов для модулей Кухня и Склад

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('exclude_spices_water', 'Без специй и воды', 'Without spices and water', 'मसाले और पानी के बिना', 'Фильтр в заявках склада'),
  ('placeholder_slug_example', 'например: main', 'e.g.: main', 'उदा.: main', 'Placeholder для slug категории блюд'),
  ('placeholder_category_slug', 'например: vegetables', 'e.g.: vegetables', 'उदा.: vegetables', 'Placeholder для slug категории продуктов'),
  ('placeholder_unit_name', 'Килограмм', 'Kilogram', 'किलोग्राम', 'Placeholder для полного названия единицы'),
  ('placeholder_unit_short', 'кг', 'kg', 'किग्रा', 'Placeholder для сокращения единицы'),
  ('placeholder_product_name', 'Рис', 'Rice', 'चावल', 'Placeholder для названия продукта')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context;
