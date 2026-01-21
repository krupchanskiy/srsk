-- ============================================
-- Ингредиенты и инструкции для рецептов
-- ============================================

-- Сначала добавим недостающие продукты
INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit) VALUES
-- Овощи
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Лук репчатый', 'Onion', 'प्याज', 'pyāj', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Картофель', 'Potato', 'आलू', 'ālū', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Морковь', 'Carrot', 'गाजर', 'gājar', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Горошек зелёный', 'Green Peas', 'मटर', 'maṭar', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Цветная капуста', 'Cauliflower', 'फूलगोभी', 'phūlgobhī', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Капуста белокочанная', 'Cabbage', 'पत्ता गोभी', 'pattā gobhī', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Огурец', 'Cucumber', 'खीरा', 'khīrā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Баклажан', 'Eggplant', 'बैंगन', 'baiṅgan', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Бамия (окра)', 'Okra', 'भिंडी', 'bhiṇḍī', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Чеснок', 'Garlic', 'लहसुन', 'lahsun', 'g'),
((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Кориандр свежий', 'Fresh Coriander', 'हरा धनिया', 'harā dhaniyā', 'g'),
-- Крупы
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Рис басмати', 'Basmati Rice', 'बासमती चावल', 'bāsmatī chāval', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Овсяные хлопья', 'Oats', 'ओट्स', 'oṭs', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Манка (суджи)', 'Semolina', 'सूजी', 'sūjī', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Поха (рисовые хлопья)', 'Poha', 'पोहा', 'pohā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Далия (дроблёная пшеница)', 'Broken Wheat', 'दलिया', 'daliyā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Мука пшеничная', 'Wheat Flour', 'आटा', 'āṭā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'grains'), 'Вермишель', 'Vermicelli', 'सेवइयां', 'sevaiyā̃', 'kg'),
-- Бобовые
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Мунг дал', 'Moong Dal', 'मूंग दाल', 'mūṅg dāl', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Тур дал', 'Toor Dal', 'तूर दाल', 'tūr dāl', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Чана дал', 'Chana Dal', 'चना दाल', 'chanā dāl', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Нут', 'Chickpeas', 'छोले', 'chhōle', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Раджма (красная фасоль)', 'Kidney Beans', 'राजमा', 'rājmā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'legumes'), 'Урад дал', 'Urad Dal', 'उड़द दाल', 'uṛad dāl', 'kg'),
-- Молочные
((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Молоко', 'Milk', 'दूध', 'dūdh', 'l'),
((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Йогурт', 'Yogurt', 'दही', 'dahī', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Сливочное масло', 'Butter', 'मक्खन', 'makkhan', 'g'),
-- Специи
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Куркума', 'Turmeric', 'हल्दी', 'haldī', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Красный перец', 'Red Chili Powder', 'लाल मिर्च', 'lāl mirch', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Кориандр молотый', 'Coriander Powder', 'धनिया पाउडर', 'dhaniyā pāuḍar', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Горчица (семена)', 'Mustard Seeds', 'राई', 'rāī', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Асафетида', 'Asafoetida', 'हींग', 'hīṅg', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Карри листья', 'Curry Leaves', 'करी पत्ता', 'karī pattā', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Самбар масала', 'Sambar Masala', 'सांभर मसाला', 'sāmbhar masālā', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Тамаринд', 'Tamarind', 'इमली', 'imlī', 'g'),
((SELECT id FROM product_categories WHERE slug = 'spices'), 'Чёрный перец', 'Black Pepper', 'काली मिर्च', 'kālī mirch', 'g'),
-- Масла
((SELECT id FROM product_categories WHERE slug = 'oils'), 'Масло растительное', 'Vegetable Oil', 'तेल', 'tel', 'ml'),
((SELECT id FROM product_categories WHERE slug = 'oils'), 'Кокосовое масло', 'Coconut Oil', 'नारियल तेल', 'nāriyal tel', 'ml'),
-- Подсластители
((SELECT id FROM product_categories WHERE slug = 'sweeteners'), 'Сахар', 'Sugar', 'चीनी', 'chīnī', 'g'),
((SELECT id FROM product_categories WHERE slug = 'sweeteners'), 'Гур (джаггери)', 'Jaggery', 'गुड़', 'guṛ', 'g'),
-- Фрукты
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Лимон', 'Lemon', 'नींबू', 'nīmbū', 'pcs'),
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Кокос тёртый', 'Grated Coconut', 'कसा नारियल', 'kasā nāriyal', 'g'),
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Яблоко', 'Apple', 'सेब', 'seb', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Банан', 'Banana', 'केला', 'kelā', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Манго', 'Mango', 'आम', 'ām', 'kg'),
((SELECT id FROM product_categories WHERE slug = 'fruits'), 'Папайя', 'Papaya', 'पपीता', 'papītā', 'kg'),
-- Орехи
((SELECT id FROM product_categories WHERE slug = 'nuts'), 'Кешью', 'Cashews', 'काजू', 'kājū', 'g'),
((SELECT id FROM product_categories WHERE slug = 'nuts'), 'Арахис', 'Peanuts', 'मूंगफली', 'mūṅgphalī', 'g'),
((SELECT id FROM product_categories WHERE slug = 'nuts'), 'Изюм', 'Raisins', 'किशमिश', 'kishmish', 'g'),
-- Прочее
((SELECT id FROM product_categories WHERE slug = 'other'), 'Вода', 'Water', 'पानी', 'pānī', 'l'),
((SELECT id FROM product_categories WHERE slug = 'other'), 'Паппад', 'Papad', 'पापड़', 'pāpaṛ', 'pcs')
ON CONFLICT (name_en) DO NOTHING;

-- ============================================
-- ОБНОВЛЯЕМ РЕЦЕПТЫ: описания и инструкции
-- ============================================

-- КИЧРИ
UPDATE recipes SET
    description_ru = 'Лёгкое питательное блюдо из риса и дала с овощами. Идеально для завтрака.',
    description_en = 'Light nutritious dish of rice and dal with vegetables. Perfect for breakfast.',
    description_hi = 'चावल और दाल से बना हल्का पौष्टिक व्यंजन। नाश्ते के लिए आदर्श।',
    instructions_ru = 'Промыть рис и мунг дал, замочить на 15 минут.
В кастрюле разогреть гхи, добавить кумин.
Добавить нарезанные овощи, обжарить 3 минуты.
Добавить рис и дал, куркуму, соль.
Залить водой (1:3), довести до кипения.
Варить 20-25 минут до готовности.
Подавать горячим с гхи.',
    instructions_en = 'Rinse rice and moong dal, soak for 15 minutes.
Heat ghee in pot, add cumin.
Add chopped vegetables, sauté 3 minutes.
Add rice and dal, turmeric, salt.
Add water (1:3), bring to boil.
Cook 20-25 minutes until done.
Serve hot with ghee.',
    instructions_hi = 'चावल और दाल धोकर 15 मिनट भिगोएं।
घी गरम करें, जीरा डालें।
सब्जियां डालें, 3 मिनट भूनें।
चावल, दाल, हल्दी, नमक डालें।
पानी डालें, उबालें।
20-25 मिनट पकाएं।
घी के साथ परोसें।'
WHERE name_en = 'Vegetable Khichdi';

-- ДАЛ ТАДКА
UPDATE recipes SET
    description_ru = 'Ароматный дал с обжаренными специями. Основа индийской кухни.',
    description_en = 'Aromatic dal with tempered spices. A staple of Indian cuisine.',
    description_hi = 'तड़के वाली दाल। भारतीय खाने का मुख्य हिस्सा।',
    instructions_ru = 'Промыть тур дал, замочить на 30 минут.
Варить дал с куркумой и солью до мягкости.
Для тадки: разогреть гхи, добавить кумин, горчицу.
Добавить асафетиду, чеснок, помидоры.
Влить тадку в готовый дал.
Украсить кориандром.',
    instructions_en = 'Rinse toor dal, soak 30 minutes.
Cook dal with turmeric and salt until soft.
For tadka: heat ghee, add cumin, mustard.
Add asafoetida, garlic, tomatoes.
Pour tadka into dal.
Garnish with coriander.',
    instructions_hi = 'दाल धोकर 30 मिनट भिगोएं।
हल्दी-नमक के साथ पकाएं।
तड़के के लिए: घी में जीरा, राई भूनें।
हींग, लहसुन, टमाटर डालें।
तड़का दाल में डालें।
धनिये से सजाएं।'
WHERE name_en = 'Dal Tadka';

-- ДАЛ ФРАЙ
UPDATE recipes SET
    description_ru = 'Простой и вкусный дал с луком и специями.',
    description_en = 'Simple and tasty dal with onions and spices.',
    description_hi = 'प्याज और मसालों के साथ सरल दाल।',
    instructions_ru = 'Сварить тур дал до мягкости.
Обжарить лук до золотистого цвета.
Добавить помидоры, специи.
Смешать с далом, прогреть.
Подавать с рисом или чапати.',
    instructions_en = 'Cook toor dal until soft.
Fry onions until golden.
Add tomatoes, spices.
Mix with dal, heat through.
Serve with rice or chapati.',
    instructions_hi = 'दाल नरम होने तक पकाएं।
प्याज सुनहरा भूनें।
टमाटर, मसाले डालें।
दाल में मिलाएं।
चावल या चपाती के साथ परोसें।'
WHERE name_en = 'Dal Fry';

-- РИС БАСМАТИ
UPDATE recipes SET
    description_ru = 'Ароматный рассыпчатый рис — идеальный гарнир.',
    description_en = 'Fragrant fluffy rice — perfect side dish.',
    description_hi = 'खुशबूदार खिला चावल — परफेक्ट साइड डिश।',
    instructions_ru = 'Промыть рис 3-4 раза до прозрачной воды.
Замочить на 20 минут.
Вскипятить воду (1:1.5), добавить соль.
Добавить рис, варить 12-15 минут.
Дать постоять 5 минут.
Разрыхлить вилкой.',
    instructions_en = 'Rinse rice 3-4 times until clear.
Soak 20 minutes.
Boil water (1:1.5), add salt.
Add rice, cook 12-15 minutes.
Rest 5 minutes.
Fluff with fork.',
    instructions_hi = 'चावल 3-4 बार धोएं।
20 मिनट भिगोएं।
पानी उबालें, नमक डालें।
चावल डालें, 12-15 मिनट पकाएं।
5 मिनट रखें।
कांटे से फुलाएं।'
WHERE name_en = 'Steamed Basmati Rice';

-- ЧАПАТИ
UPDATE recipes SET
    description_ru = 'Традиционные индийские лепёшки из цельнозерновой муки.',
    description_en = 'Traditional Indian flatbread from whole wheat flour.',
    description_hi = 'आटे से बनी पारंपरिक रोटी।',
    instructions_ru = 'Смешать муку с солью.
Замесить мягкое тесто с водой.
Дать отдохнуть 20 минут.
Разделить на шарики, раскатать.
Печь на сухой сковороде.
Смазать гхи.',
    instructions_en = 'Mix flour with salt.
Knead soft dough with water.
Rest 20 minutes.
Divide into balls, roll out.
Cook on dry pan.
Brush with ghee.',
    instructions_hi = 'आटे में नमक मिलाएं।
पानी से नरम आटा गूंथें।
20 मिनट रखें।
लोइयां बनाकर बेलें।
तवे पर सेकें।
घी लगाएं।'
WHERE name_en = 'Chapati';

-- ПУРИ
UPDATE recipes SET
    description_ru = 'Хрустящие жареные лепёшки.',
    description_en = 'Crispy fried flatbread.',
    description_hi = 'कुरकुरी तली पूरी।',
    instructions_ru = 'Замесить крутое тесто из муки, соли и воды.
Дать отдохнуть 15 минут.
Раскатать маленькие лепёшки.
Жарить в горячем масле до золотистого цвета.
Подавать горячими.',
    instructions_en = 'Knead stiff dough from flour, salt and water.
Rest 15 minutes.
Roll small circles.
Deep fry until golden.
Serve hot.',
    instructions_hi = 'आटे, नमक, पानी से कड़ा आटा गूंथें।
15 मिनट रखें।
छोटी पूरियां बेलें।
गरम तेल में तलें।
गरम परोसें।'
WHERE name_en = 'Puri';

-- САМБАР
UPDATE recipes SET
    description_ru = 'Южноиндийский овощной суп с тамариндом.',
    description_en = 'South Indian vegetable soup with tamarind.',
    description_hi = 'इमली के साथ दक्षिण भारतीय सूप।',
    instructions_ru = 'Сварить тур дал до мягкости.
Сварить овощи с куркумой.
Добавить тамариндовый сок и самбар масалу.
Сделать тадку из горчицы и карри листьев.
Влить тадку в самбар.',
    instructions_en = 'Cook toor dal until soft.
Cook vegetables with turmeric.
Add tamarind juice and sambar masala.
Make tadka with mustard and curry leaves.
Pour tadka into sambar.',
    instructions_hi = 'दाल नरम पकाएं।
सब्जियां हल्दी के साथ पकाएं।
इमली और सांभर मसाला डालें।
राई-करी पत्ते का तड़का लगाएं।'
WHERE name_en = 'Sambar';

-- АЛУ ГОБИ
UPDATE recipes SET
    description_ru = 'Картофель с цветной капустой и специями.',
    description_en = 'Potatoes with cauliflower and spices.',
    description_hi = 'मसालों के साथ आलू गोभी।',
    instructions_ru = 'Нарезать картофель и капусту.
Обжарить в масле с кумином.
Добавить специи: куркуму, красный перец.
Тушить под крышкой 15-20 минут.
Добавить гарам масалу в конце.',
    instructions_en = 'Cut potatoes and cauliflower.
Fry in oil with cumin.
Add spices: turmeric, red chili.
Cook covered 15-20 minutes.
Add garam masala at end.',
    instructions_hi = 'आलू-गोभी काटें।
तेल में जीरे के साथ भूनें।
हल्दी, लाल मिर्च डालें।
ढककर 15-20 मिनट पकाएं।
अंत में गरम मसाला डालें।'
WHERE name_en = 'Aloo Gobi';

-- АЛУ МАТАР
UPDATE recipes SET
    description_ru = 'Картофель с зелёным горошком в томатном соусе.',
    description_en = 'Potatoes with green peas in tomato sauce.',
    description_hi = 'टमाटर ग्रेवी में आलू मटर।',
    instructions_ru = 'Обжарить лук до золотистого цвета.
Добавить помидоры и специи.
Добавить картофель и горошек.
Тушить до готовности картофеля.
Украсить кориандром.',
    instructions_en = 'Fry onions until golden.
Add tomatoes and spices.
Add potatoes and peas.
Cook until potatoes done.
Garnish with coriander.',
    instructions_hi = 'प्याज सुनहरा भूनें।
टमाटर और मसाले डालें।
आलू-मटर डालें।
आलू पकने तक पकाएं।
धनिये से सजाएं।'
WHERE name_en = 'Aloo Matar';

-- СЛАДКИЙ ЛАССИ
UPDATE recipes SET
    description_ru = 'Освежающий йогуртовый напиток с сахаром.',
    description_en = 'Refreshing yogurt drink with sugar.',
    description_hi = 'चीनी के साथ ताज़ा लस्सी।',
    instructions_ru = 'Взбить йогурт с водой.
Добавить сахар.
Взбивать до образования пены.
Подавать холодным.',
    instructions_en = 'Blend yogurt with water.
Add sugar.
Blend until frothy.
Serve cold.',
    instructions_hi = 'दही को पानी के साथ फेंटें।
चीनी डालें।
झाग आने तक फेंटें।
ठंडा परोसें।'
WHERE name_en = 'Sweet Lassi';

-- СОЛЁНЫЙ ЛАССИ
UPDATE recipes SET
    description_ru = 'Освежающий йогуртовый напиток с солью и кумином.',
    description_en = 'Refreshing yogurt drink with salt and cumin.',
    description_hi = 'नमक और जीरे के साथ लस्सी।',
    instructions_ru = 'Взбить йогурт с водой.
Добавить соль и жареный кумин.
Взбивать до однородности.
Подавать холодным.',
    instructions_en = 'Blend yogurt with water.
Add salt and roasted cumin.
Blend until smooth.
Serve cold.',
    instructions_hi = 'दही-पानी फेंटें।
नमक और भुना जीरा डालें।
अच्छे से मिलाएं।
ठंडा परोसें।'
WHERE name_en = 'Salted Lassi';

-- РИСОВЫЙ КХИР
UPDATE recipes SET
    description_ru = 'Молочный десерт с рисом и орехами.',
    description_en = 'Milk pudding with rice and nuts.',
    description_hi = 'चावल और मेवे की खीर।',
    instructions_ru = 'Вскипятить молоко.
Добавить промытый рис.
Варить на медленном огне 30-40 минут.
Добавить сахар и орехи.
Подавать тёплым или холодным.',
    instructions_en = 'Boil milk.
Add washed rice.
Cook on low heat 30-40 minutes.
Add sugar and nuts.
Serve warm or cold.',
    instructions_hi = 'दूध उबालें।
धुले चावल डालें।
धीमी आंच पर 30-40 मिनट पकाएं।
चीनी और मेवे डालें।
गरम या ठंडा परोसें।'
WHERE name_en = 'Rice Kheer';

-- ХАЛВА ИЗ МАНКИ
UPDATE recipes SET
    description_ru = 'Сладкая манная халва с орехами.',
    description_en = 'Sweet semolina halwa with nuts.',
    description_hi = 'मेवों के साथ सूजी हलवा।',
    instructions_ru = 'Обжарить манку в гхи до золотистого цвета.
Вскипятить воду с сахаром.
Осторожно влить сироп в манку.
Перемешивать до загустения.
Добавить орехи и изюм.',
    instructions_en = 'Roast semolina in ghee until golden.
Boil water with sugar.
Carefully add syrup to semolina.
Stir until thick.
Add nuts and raisins.',
    instructions_hi = 'सूजी को घी में सुनहरा भूनें।
पानी में चीनी उबालें।
चाशनी सूजी में डालें।
गाढ़ा होने तक चलाएं।
मेवे और किशमिश डालें।'
WHERE name_en = 'Suji Halwa';

-- КАЧУМБЕР
UPDATE recipes SET
    description_ru = 'Свежий салат из огурцов, помидоров и лука.',
    description_en = 'Fresh salad of cucumber, tomatoes and onion.',
    description_hi = 'खीरे, टमाटर और प्याज का सलाद।',
    instructions_ru = 'Нарезать огурцы, помидоры и лук мелкими кубиками.
Добавить соль, перец и лимонный сок.
Перемешать и подавать свежим.',
    instructions_en = 'Dice cucumber, tomatoes and onion.
Add salt, pepper and lemon juice.
Mix and serve fresh.',
    instructions_hi = 'खीरा, टमाटर, प्याज काटें।
नमक, मिर्च, नींबू डालें।
मिलाकर ताज़ा परोसें।'
WHERE name_en = 'Kachumber Salad';

-- РАЙТА С ОГУРЦОМ
UPDATE recipes SET
    description_ru = 'Йогуртовый соус с огурцом и специями.',
    description_en = 'Yogurt sauce with cucumber and spices.',
    description_hi = 'खीरे का रायता।',
    instructions_ru = 'Натереть огурец, отжать лишнюю воду.
Смешать йогурт с огурцом.
Добавить соль и жареный кумин.
Охладить перед подачей.',
    instructions_en = 'Grate cucumber, squeeze excess water.
Mix yogurt with cucumber.
Add salt and roasted cumin.
Chill before serving.',
    instructions_hi = 'खीरा कद्दूकस करें, पानी निचोड़ें।
दही में मिलाएं।
नमक और भुना जीरा डालें।
ठंडा परोसें।'
WHERE name_en = 'Cucumber Raita';

-- НИМБУ ПАНИ
UPDATE recipes SET
    description_ru = 'Освежающий лимонад с солью или сахаром.',
    description_en = 'Refreshing lemonade with salt or sugar.',
    description_hi = 'नमक या चीनी के साथ नींबू पानी।',
    instructions_ru = 'Выжать лимонный сок.
Смешать с водой.
Добавить сахар или соль по вкусу.
Подавать со льдом.',
    instructions_en = 'Squeeze lemon juice.
Mix with water.
Add sugar or salt to taste.
Serve with ice.',
    instructions_hi = 'नींबू निचोड़ें।
पानी में मिलाएं।
चीनी या नमक डालें।
बर्फ के साथ परोसें।'
WHERE name_en = 'Nimbu Pani';

-- ============================================
-- ИНГРЕДИЕНТЫ ДЛЯ РЕЦЕПТОВ
-- ============================================

-- Удаляем старые ингредиенты (кроме Палак Панир, который уже готов)
DELETE FROM recipe_ingredients WHERE recipe_id IN (
    SELECT id FROM recipes WHERE name_en != 'Palak Paneer'
);

-- КИЧРИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Basmati Rice', 1, 'kg', 1),
    ('Moong Dal', 0.5, 'kg', 2),
    ('Carrot', 0.3, 'kg', 3),
    ('Green Peas', 0.2, 'kg', 4),
    ('Potato', 0.3, 'kg', 5),
    ('Ghee', 100, 'g', 6),
    ('Cumin', 15, 'g', 7),
    ('Turmeric', 10, 'g', 8),
    ('Salt', 40, 'g', 9),
    ('Water', 3, 'l', 10)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Vegetable Khichdi' AND p.name_en = v.product_name;

-- ДАЛ ТАДКА
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Toor Dal', 0.8, 'kg', 1),
    ('Tomatoes', 0.3, 'kg', 2),
    ('Onion', 0.2, 'kg', 3),
    ('Garlic', 30, 'g', 4),
    ('Ghee', 100, 'g', 5),
    ('Cumin', 15, 'g', 6),
    ('Mustard Seeds', 10, 'g', 7),
    ('Turmeric', 10, 'g', 8),
    ('Red Chili Powder', 10, 'g', 9),
    ('Asafoetida', 3, 'g', 10),
    ('Salt', 35, 'g', 11),
    ('Fresh Coriander', 30, 'g', 12)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Dal Tadka' AND p.name_en = v.product_name;

-- РИС БАСМАТИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Basmati Rice', 2, 'kg', 1),
    ('Water', 3, 'l', 2),
    ('Salt', 20, 'g', 3)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Steamed Basmati Rice' AND p.name_en = v.product_name;

-- ЧАПАТИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Wheat Flour', 2.5, 'kg', 1),
    ('Salt', 20, 'g', 2),
    ('Water', 1.5, 'l', 3),
    ('Ghee', 100, 'g', 4)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Chapati' AND p.name_en = v.product_name;

-- АЛУ ГОБИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Potato', 1.5, 'kg', 1),
    ('Cauliflower', 1.5, 'kg', 2),
    ('Onion', 0.3, 'kg', 3),
    ('Tomatoes', 0.3, 'kg', 4),
    ('Ginger', 30, 'g', 5),
    ('Vegetable Oil', 100, 'ml', 6),
    ('Cumin', 15, 'g', 7),
    ('Turmeric', 10, 'g', 8),
    ('Red Chili Powder', 10, 'g', 9),
    ('Garam Masala', 10, 'g', 10),
    ('Salt', 35, 'g', 11),
    ('Fresh Coriander', 30, 'g', 12)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Aloo Gobi' AND p.name_en = v.product_name;

-- СЛАДКИЙ ЛАССИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Yogurt', 3, 'kg', 1),
    ('Water', 5, 'l', 2),
    ('Sugar', 500, 'g', 3)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Sweet Lassi' AND p.name_en = v.product_name;

-- РИСОВЫЙ КХИР
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Basmati Rice', 0.3, 'kg', 1),
    ('Milk', 5, 'l', 2),
    ('Sugar', 400, 'g', 3),
    ('Cashews', 50, 'g', 4),
    ('Raisins', 50, 'g', 5)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Rice Kheer' AND p.name_en = v.product_name;

-- САМБАР
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Toor Dal', 0.5, 'kg', 1),
    ('Carrot', 0.3, 'kg', 2),
    ('Potato', 0.3, 'kg', 3),
    ('Eggplant', 0.2, 'kg', 4),
    ('Tomatoes', 0.3, 'kg', 5),
    ('Tamarind', 50, 'g', 6),
    ('Sambar Masala', 40, 'g', 7),
    ('Turmeric', 10, 'g', 8),
    ('Mustard Seeds', 10, 'g', 9),
    ('Curry Leaves', 10, 'g', 10),
    ('Vegetable Oil', 50, 'ml', 11),
    ('Salt', 40, 'g', 12)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Sambar' AND p.name_en = v.product_name;

-- ДАЛ ФРАЙ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Toor Dal', 0.8, 'kg', 1),
    ('Onion', 0.3, 'kg', 2),
    ('Tomatoes', 0.3, 'kg', 3),
    ('Garlic', 20, 'g', 4),
    ('Ginger', 20, 'g', 5),
    ('Ghee', 80, 'g', 6),
    ('Cumin', 10, 'g', 7),
    ('Turmeric', 8, 'g', 8),
    ('Red Chili Powder', 10, 'g', 9),
    ('Salt', 35, 'g', 10),
    ('Fresh Coriander', 30, 'g', 11)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Dal Fry' AND p.name_en = v.product_name;

-- ПУРИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Wheat Flour', 2, 'kg', 1),
    ('Salt', 15, 'g', 2),
    ('Water', 1, 'l', 3),
    ('Vegetable Oil', 1, 'l', 4)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Puri' AND p.name_en = v.product_name;

-- АЛУ МАТАР
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Potato', 1.5, 'kg', 1),
    ('Green Peas', 0.8, 'kg', 2),
    ('Onion', 0.3, 'kg', 3),
    ('Tomatoes', 0.4, 'kg', 4),
    ('Ginger', 25, 'g', 5),
    ('Vegetable Oil', 80, 'ml', 6),
    ('Cumin', 10, 'g', 7),
    ('Turmeric', 8, 'g', 8),
    ('Red Chili Powder', 8, 'g', 9),
    ('Garam Masala', 10, 'g', 10),
    ('Salt', 30, 'g', 11),
    ('Fresh Coriander', 30, 'g', 12)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Aloo Matar' AND p.name_en = v.product_name;

-- СОЛЁНЫЙ ЛАССИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Yogurt', 3, 'kg', 1),
    ('Water', 5, 'l', 2),
    ('Salt', 30, 'g', 3),
    ('Cumin', 10, 'g', 4)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Salted Lassi' AND p.name_en = v.product_name;

-- ХАЛВА ИЗ МАНКИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Semolina', 0.5, 'kg', 1),
    ('Ghee', 250, 'g', 2),
    ('Sugar', 400, 'g', 3),
    ('Water', 1.2, 'l', 4),
    ('Cashews', 50, 'g', 5),
    ('Raisins', 50, 'g', 6)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Suji Halwa' AND p.name_en = v.product_name;

-- КАЧУМБЕР
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Cucumber', 1, 'kg', 1),
    ('Tomatoes', 0.8, 'kg', 2),
    ('Onion', 0.4, 'kg', 3),
    ('Lemon', 4, 'pcs', 4),
    ('Salt', 15, 'g', 5),
    ('Black Pepper', 5, 'g', 6),
    ('Fresh Coriander', 30, 'g', 7)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Kachumber Salad' AND p.name_en = v.product_name;

-- РАЙТА С ОГУРЦОМ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Yogurt', 2, 'kg', 1),
    ('Cucumber', 0.5, 'kg', 2),
    ('Cumin', 10, 'g', 3),
    ('Salt', 15, 'g', 4)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Cucumber Raita' AND p.name_en = v.product_name;

-- НИМБУ ПАНИ
INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order)
SELECT r.id, p.id, v.amount, v.unit, v.sort_order
FROM recipes r, products p, (VALUES
    ('Lemon', 10, 'pcs', 1),
    ('Water', 5, 'l', 2),
    ('Sugar', 300, 'g', 3),
    ('Salt', 20, 'g', 4)
) AS v(product_name, amount, unit, sort_order)
WHERE r.name_en = 'Nimbu Pani' AND p.name_en = v.product_name;
