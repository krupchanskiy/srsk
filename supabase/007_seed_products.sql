-- ============================================
-- Тестовые продукты
-- ============================================

-- Получаем ID категорий
WITH cats AS (
    SELECT id, slug FROM product_categories
)
INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit) VALUES
-- Овощи
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Картофель', 'Potato', 'आलू', 'ālū', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Морковь', 'Carrot', 'गाजर', 'gājar', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Лук репчатый', 'Onion', 'प्याज', 'pyāj', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Помидоры', 'Tomatoes', 'टमाटर', 'ṭamāṭar', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Огурцы', 'Cucumbers', 'खीरा', 'khīrā', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Капуста белокочанная', 'White cabbage', 'पत्ता गोभी', 'pattā gobhī', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Перец болгарский', 'Bell pepper', 'शिमला मिर्च', 'śimlā mirch', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Баклажан', 'Eggplant', 'बैंगन', 'baiṅgan', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Кабачок', 'Zucchini', 'तोरी', 'torī', 'kg'),
((SELECT id FROM cats WHERE slug = 'vegetables'), 'Имбирь свежий', 'Fresh ginger', 'अदरक', 'adrak', 'kg'),

-- Фрукты
((SELECT id FROM cats WHERE slug = 'fruits'), 'Яблоки', 'Apples', 'सेब', 'seb', 'kg'),
((SELECT id FROM cats WHERE slug = 'fruits'), 'Бананы', 'Bananas', 'केला', 'kelā', 'kg'),
((SELECT id FROM cats WHERE slug = 'fruits'), 'Манго', 'Mango', 'आम', 'ām', 'kg'),
((SELECT id FROM cats WHERE slug = 'fruits'), 'Лимон', 'Lemon', 'नींबू', 'nīṃbū', 'kg'),
((SELECT id FROM cats WHERE slug = 'fruits'), 'Кокос', 'Coconut', 'नारियल', 'nāriyal', 'pcs'),

-- Крупы и злаки
((SELECT id FROM cats WHERE slug = 'grains'), 'Рис басмати', 'Basmati rice', 'बासमती चावल', 'bāsmatī cāval', 'kg'),
((SELECT id FROM cats WHERE slug = 'grains'), 'Рис круглый', 'Round rice', 'गोल चावल', 'gol cāval', 'kg'),
((SELECT id FROM cats WHERE slug = 'grains'), 'Манка (суджи)', 'Semolina (suji)', 'सूजी', 'sūjī', 'kg'),
((SELECT id FROM cats WHERE slug = 'grains'), 'Мука пшеничная', 'Wheat flour', 'गेहूं का आटा', 'gehūṃ kā āṭā', 'kg'),
((SELECT id FROM cats WHERE slug = 'grains'), 'Мука нутовая (бесан)', 'Chickpea flour (besan)', 'बेसन', 'besan', 'kg'),
((SELECT id FROM cats WHERE slug = 'grains'), 'Овсянка', 'Oatmeal', 'जई', 'jaī', 'kg'),

-- Бобовые
((SELECT id FROM cats WHERE slug = 'legumes'), 'Мунг дал', 'Mung dal', 'मूंग दाल', 'mūṅg dāl', 'kg'),
((SELECT id FROM cats WHERE slug = 'legumes'), 'Чана дал', 'Chana dal', 'चना दाल', 'canā dāl', 'kg'),
((SELECT id FROM cats WHERE slug = 'legumes'), 'Урад дал', 'Urad dal', 'उड़द दाल', 'uṛad dāl', 'kg'),
((SELECT id FROM cats WHERE slug = 'legumes'), 'Тур дал', 'Toor dal', 'तूर दाल', 'tūr dāl', 'kg'),
((SELECT id FROM cats WHERE slug = 'legumes'), 'Нут', 'Chickpeas', 'छोले', 'chole', 'kg'),
((SELECT id FROM cats WHERE slug = 'legumes'), 'Фасоль красная', 'Red kidney beans', 'राजमा', 'rājmā', 'kg'),

-- Молочные продукты
((SELECT id FROM cats WHERE slug = 'dairy'), 'Молоко', 'Milk', 'दूध', 'dūdh', 'l'),
((SELECT id FROM cats WHERE slug = 'dairy'), 'Йогурт (дахи)', 'Yogurt (dahi)', 'दही', 'dahī', 'kg'),
((SELECT id FROM cats WHERE slug = 'dairy'), 'Панир', 'Paneer', 'पनीर', 'panīr', 'kg'),
((SELECT id FROM cats WHERE slug = 'dairy'), 'Гхи (топлёное масло)', 'Ghee', 'घी', 'ghī', 'kg'),
((SELECT id FROM cats WHERE slug = 'dairy'), 'Сливки', 'Cream', 'क्रीम', 'krīm', 'l'),

-- Специи
((SELECT id FROM cats WHERE slug = 'spices'), 'Куркума', 'Turmeric', 'हल्दी', 'haldī', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Кумин (зира)', 'Cumin', 'जीरा', 'jīrā', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Кориандр молотый', 'Ground coriander', 'धनिया पाउडर', 'dhaniyā pāuḍar', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Гарам масала', 'Garam masala', 'गरम मसाला', 'garam masālā', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Красный перец чили', 'Red chili powder', 'लाल मिर्च', 'lāl mirch', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Асафетида (хинг)', 'Asafoetida (hing)', 'हींग', 'hīṅg', 'g'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Горчица чёрная', 'Black mustard seeds', 'राई', 'rāī', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Кардамон зелёный', 'Green cardamom', 'इलायची', 'ilāycī', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Корица', 'Cinnamon', 'दालचीनी', 'dālcīnī', 'kg'),
((SELECT id FROM cats WHERE slug = 'spices'), 'Соль', 'Salt', 'नमक', 'namak', 'kg'),

-- Масла
((SELECT id FROM cats WHERE slug = 'oils'), 'Масло подсолнечное', 'Sunflower oil', 'सूरजमुखी तेल', 'sūrajmukhī tel', 'l'),
((SELECT id FROM cats WHERE slug = 'oils'), 'Масло горчичное', 'Mustard oil', 'सरसों का तेल', 'sarsoṃ kā tel', 'l'),
((SELECT id FROM cats WHERE slug = 'oils'), 'Масло кокосовое', 'Coconut oil', 'नारियल तेल', 'nāriyal tel', 'l'),
((SELECT id FROM cats WHERE slug = 'oils'), 'Масло кунжутное', 'Sesame oil', 'तिल का तेल', 'til kā tel', 'l'),

-- Сахар и подсластители
((SELECT id FROM cats WHERE slug = 'sweeteners'), 'Сахар белый', 'White sugar', 'चीनी', 'cīnī', 'kg'),
((SELECT id FROM cats WHERE slug = 'sweeteners'), 'Гур (джаггери)', 'Jaggery (gur)', 'गुड़', 'guṛ', 'kg'),
((SELECT id FROM cats WHERE slug = 'sweeteners'), 'Мёд', 'Honey', 'शहद', 'śahad', 'kg'),

-- Орехи и семена
((SELECT id FROM cats WHERE slug = 'nuts'), 'Кешью', 'Cashew', 'काजू', 'kājū', 'kg'),
((SELECT id FROM cats WHERE slug = 'nuts'), 'Миндаль', 'Almonds', 'बादाम', 'bādām', 'kg'),
((SELECT id FROM cats WHERE slug = 'nuts'), 'Изюм', 'Raisins', 'किशमिश', 'kiśmiś', 'kg'),
((SELECT id FROM cats WHERE slug = 'nuts'), 'Кунжут белый', 'White sesame seeds', 'सफेद तिल', 'safed til', 'kg'),

-- Прочее
((SELECT id FROM cats WHERE slug = 'other'), 'Тамаринд', 'Tamarind', 'इमली', 'imlī', 'kg'),
((SELECT id FROM cats WHERE slug = 'other'), 'Кокосовая стружка', 'Desiccated coconut', 'नारियल का बुरादा', 'nāriyal kā burādā', 'kg'),
((SELECT id FROM cats WHERE slug = 'other'), 'Листья карри', 'Curry leaves', 'कढ़ी पत्ता', 'kaṛhī pattā', 'g'),
((SELECT id FROM cats WHERE slug = 'other'), 'Кинза свежая', 'Fresh coriander', 'हरा धनिया', 'harā dhaniyā', 'bunch')
ON CONFLICT DO NOTHING;
