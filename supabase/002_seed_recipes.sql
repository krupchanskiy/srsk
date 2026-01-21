-- ============================================
-- SEED DATA: Рецепты из прототипа
-- ============================================

-- Вставляем рецепты (category_id будет через подзапрос)
insert into recipes (category_id, name_ru, name_en, name_hi, translit, output_amount, output_unit, portion_amount, portion_unit, cooking_time, photo_url) values

-- Основные блюда
((select id from recipe_categories where slug = 'main'), 'Кичри с овощами', 'Vegetable Khichdi', 'सब्जी खिचड़ी', 'Sabjī Khicṛī', 5, 'kg', 200, 'g', 40, 'https://images.unsplash.com/photo-1596797038530-2c107229654b?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Овсяная каша с фруктами', 'Oats Porridge with Fruits', 'फलों के साथ ओट्स', 'Phalõ ke Sāth Oṭs', 5, 'kg', 200, 'g', 20, 'https://images.unsplash.com/photo-1517673400267-0251440c45dc?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Упма', 'Upma', 'उपमा', 'Upmā', 5, 'kg', 180, 'g', 25, 'https://images.unsplash.com/photo-1567337710282-00832b415979?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Поха с овощами', 'Vegetable Poha', 'सब्जी पोहा', 'Sabjī Pohā', 5, 'kg', 180, 'g', 20, 'https://images.unsplash.com/photo-1625398407796-82650a8c135f?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Далия', 'Daliya Porridge', 'दलिया', 'Daliyā', 5, 'kg', 200, 'g', 30, 'https://images.unsplash.com/photo-1490474418585-ba9bad8fd0ea?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Идли', 'Idli', 'इडली', 'Iḍlī', 50, 'pcs', 3, 'pcs', 30, 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Паратха с картофелем', 'Aloo Paratha', 'आलू पराठा', 'Ālū Parāṭhā', 30, 'pcs', 2, 'pcs', 45, 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Дал тадка', 'Dal Tadka', 'दाल तड़का', 'Dāl Taṛkā', 5, 'kg', 150, 'g', 35, 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Дал фрай', 'Dal Fry', 'दाल फ्राई', 'Dāl Phrāī', 5, 'kg', 150, 'g', 30, 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Алу гоби', 'Aloo Gobi', 'आलू गोभी', 'Ālū Gobhī', 5, 'kg', 150, 'g', 35, 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Палак панир', 'Palak Paneer', 'पालक पनीर', 'Pālak Panīr', 5, 'kg', 150, 'g', 40, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Бхинди масала', 'Bhindi Masala', 'भिंडी मसाला', 'Bhiṇḍī Masālā', 4, 'kg', 120, 'g', 30, 'https://images.unsplash.com/photo-1567337710282-00832b415979?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Алу матар', 'Aloo Matar', 'आलू मटर', 'Ālū Maṭar', 5, 'kg', 150, 'g', 35, 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Миксед веджитебл', 'Mixed Vegetable', 'मिक्स वेजिटेबल', 'Miks Vejiṭebal', 5, 'kg', 150, 'g', 40, 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Панир баттер масала', 'Paneer Butter Masala', 'पनीर बटर मसाला', 'Panīr Baṭar Masālā', 5, 'kg', 150, 'g', 45, 'https://images.unsplash.com/photo-1631452180519-c014fe946bc7?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Баинган бхарта', 'Baingan Bharta', 'बैंगन भर्ता', 'Baiṅgan Bhartā', 4, 'kg', 120, 'g', 40, 'https://images.unsplash.com/photo-1574484284002-952d92456975?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Чана масала', 'Chana Masala', 'छोले मसाला', 'Chhole Masālā', 5, 'kg', 150, 'g', 50, 'https://images.unsplash.com/photo-1585937421612-70a008356fbe?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'main'), 'Раджма', 'Rajma', 'राजमा', 'Rājmā', 5, 'kg', 150, 'g', 60, 'https://images.unsplash.com/photo-1546833999-b9f581a1996d?w=400&h=300&fit=crop'),

-- Гарниры
((select id from recipe_categories where slug = 'garnish'), 'Рис басмати', 'Steamed Basmati Rice', 'बासमती चावल', 'Bāsmatī Chāval', 5, 'kg', 150, 'g', 25, 'https://images.unsplash.com/photo-1516684732162-798a0062be99?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'garnish'), 'Чапати', 'Chapati', 'चपाती', 'Chapātī', 50, 'pcs', 3, 'pcs', 45, 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'garnish'), 'Пури', 'Puri', 'पूरी', 'Pūrī', 50, 'pcs', 3, 'pcs', 40, 'https://images.unsplash.com/photo-1567337710282-00832b415979?w=400&h=300&fit=crop'),

-- Супы
((select id from recipe_categories where slug = 'soup'), 'Самбар', 'Sambar', 'सांभर', 'Sāmbhar', 6, 'kg', 180, 'g', 45, 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'soup'), 'Расам', 'Rasam', 'रसम', 'Rasam', 5, 'kg', 150, 'g', 25, 'https://images.unsplash.com/photo-1476718406336-bb5a9690ee2a?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'soup'), 'Томатный суп', 'Tomato Soup', 'टमाटर सूप', 'Ṭamāṭar Sūp', 5, 'kg', 200, 'g', 30, 'https://images.unsplash.com/photo-1547592166-23ac45744acd?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'soup'), 'Овощной суп', 'Vegetable Soup', 'सब्जी सूप', 'Sabjī Sūp', 5, 'kg', 200, 'g', 35, 'https://images.unsplash.com/photo-1503766580805-f4f2f0ed4f4a?w=400&h=300&fit=crop'),

-- Салаты
((select id from recipe_categories where slug = 'salad'), 'Качумбер', 'Kachumber Salad', 'कचूंबर सलाद', 'Kachūmbar Salād', 3, 'kg', 80, 'g', 15, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'salad'), 'Салат из капусты', 'Cabbage Carrot Salad', 'पत्ता गोभी गाजर सलाद', 'Pattā Gobhī Gājar Salād', 3, 'kg', 80, 'g', 15, 'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'salad'), 'Райта с огурцом', 'Cucumber Raita', 'खीरे का रायता', 'Khīre kā Rāytā', 3, 'kg', 80, 'g', 10, 'https://images.unsplash.com/photo-1563379926898-05f4575a45d8?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'salad'), 'Райта с овощами', 'Vegetable Raita', 'सब्जी रायता', 'Sabjī Rāytā', 3, 'kg', 80, 'g', 15, 'https://images.unsplash.com/photo-1563379926898-05f4575a45d8?w=400&h=300&fit=crop'),

-- Напитки
((select id from recipe_categories where slug = 'drink'), 'Нимбу пани', 'Nimbu Pani', 'नींबू पानी', 'Nīmbū Pānī', 10, 'l', 250, 'ml', 10, 'https://images.unsplash.com/photo-1621263764928-df1444c5e859?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'drink'), 'Ласси сладкий', 'Sweet Lassi', 'मीठी लस्सी', 'Mīṭhī Lassī', 10, 'l', 250, 'ml', 10, 'https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'drink'), 'Ласси солёный', 'Salted Lassi', 'नमकीन लस्सी', 'Namkīn Lassī', 10, 'l', 250, 'ml', 10, 'https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'drink'), 'Чхаас', 'Chaas', 'छाछ', 'Chāch', 10, 'l', 250, 'ml', 10, 'https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'drink'), 'Масала чхаас', 'Masala Chaas', 'मसाला छाछ', 'Masālā Chāch', 10, 'l', 250, 'ml', 15, 'https://images.unsplash.com/photo-1626200419199-391ae4be7a41?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'drink'), 'Джаггери вода', 'Jaggery Water', 'गुड़ का पानी', 'Guṛ kā Pānī', 10, 'l', 250, 'ml', 10, 'https://images.unsplash.com/photo-1544252890-c3e95e867d73?w=400&h=300&fit=crop'),

-- Сладости
((select id from recipe_categories where slug = 'sweet'), 'Кхир рисовый', 'Rice Kheer', 'चावल की खीर', 'Chāval kī Khīr', 5, 'kg', 100, 'g', 45, 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'sweet'), 'Севиян кхир', 'Vermicelli Kheer', 'सेवइयां खीर', 'Sevaiyā̃ Khīr', 5, 'kg', 100, 'g', 30, 'https://images.unsplash.com/photo-1571115177098-24ec42ed204d?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'sweet'), 'Халва из манки', 'Suji Halwa', 'सूजी हलवा', 'Sūjī Halvā', 4, 'kg', 80, 'g', 25, 'https://images.unsplash.com/photo-1567337710282-00832b415979?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'sweet'), 'Гулаб джамун', 'Gulab Jamun', 'गुलाब जामुन', 'Gulāb Jāmun', 50, 'pcs', 2, 'pcs', 45, 'https://images.unsplash.com/photo-1666190020955-07fc82c87b3f?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'sweet'), 'Фруктовый салат', 'Fruit Salad', 'फ्रूट सलाद', 'Phrūṭ Salād', 4, 'kg', 100, 'g', 20, 'https://images.unsplash.com/photo-1564093497595-593b96d80180?w=400&h=300&fit=crop'),

-- Закуски
((select id from recipe_categories where slug = 'snack'), 'Тост с паниром', 'Paneer Toast', 'पनीर टोस्ट', 'Panīr Ṭosṭ', 50, 'pcs', 2, 'pcs', 15, 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'snack'), 'Паппад жареный', 'Fried Papad', 'तला पापड़', 'Talā Pāpaṛ', 50, 'pcs', 1, 'pcs', 10, 'https://images.unsplash.com/photo-1601050690597-df0568f70950?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'snack'), 'Кокосовый чатни', 'Coconut Chutney', 'नारियल चटनी', 'Nāriyal Chaṭnī', 2, 'kg', 30, 'g', 15, 'https://images.unsplash.com/photo-1563379926898-05f4575a45d8?w=400&h=300&fit=crop'),
((select id from recipe_categories where slug = 'snack'), 'Томатный чатни', 'Tomato Chutney', 'टमाटर चटनी', 'Ṭamāṭar Chaṭnī', 2, 'kg', 30, 'g', 20, 'https://images.unsplash.com/photo-1574484284002-952d92456975?w=400&h=300&fit=crop');
