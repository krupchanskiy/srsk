-- Переводы режима «Цена по упаковке» на kitchen/prices.html (этап 3 доп. плана)
insert into translations (key, ru, en, hi, context) values
('prices_mode_direct', 'За единицу', 'Per unit', 'प्रति इकाई', 'Кухня → Цены'),
('prices_mode_package', 'По упаковке', 'By package', 'पैकेज के अनुसार', 'Кухня → Цены'),
('prices_field_package_amount', 'Вес/объём упаковки', 'Package weight/volume', 'पैकेज का वज़न/आयतन', 'Кухня → Цены'),
('prices_field_package_price', 'Цена упаковки, ₹', 'Package price, ₹', 'पैकेज की कीमत, ₹', 'Кухня → Цены'),
('prices_package_fill_hint', 'Заполните вес и цену упаковки', 'Fill in the package weight and price', 'पैकेज का वज़न और कीमत भरें', 'Кухня → Цены'),
('prices_package_result', 'Цена за единицу', 'Price per unit', 'प्रति इकाई कीमत', 'Кухня → Цены'),
('prices_package_incomplete', 'Заполните вес и цену упаковки корректными числами', 'Fill in the package weight and price with valid numbers', 'पैकेज का वज़न और कीमत सही संख्याओं में भरें', 'Кухня → Цены'),
('prices_package_label', 'Упаковка', 'Package', 'पैकेज', 'Кухня → Цены'),
('prices_price_required', 'Укажите цену за единицу', 'Specify the price per unit', 'प्रति इकाई कीमत बताएं', 'Кухня → Цены'),
('prices_date_required', 'Укажите дату начала действия', 'Specify the effective date', 'प्रभावी होने की तारीख बताएं', 'Кухня → Цены')
on conflict (key) do nothing;
