-- ============================================
-- Добавляем ингредиенты и инструкции для рецептов
-- ============================================

-- Сначала добавим описания к существующим рецептам
UPDATE recipes SET
    description_ru = 'Классическое североиндийское блюдо из шпината и домашнего сыра панир. Нежный сливочный вкус со специями.',
    description_en = 'Classic North Indian dish made with spinach and homemade paneer cheese. Delicate creamy taste with spices.',
    description_hi = 'पालक और घर के बने पनीर से बना उत्तर भारतीय व्यंजन। मसालों के साथ नरम मलाईदार स्वाद।',
    instructions_ru = 'Шпинат тщательно промыть, бланшировать в кипящей воде 2-3 минуты.
Измельчить шпинат в блендере до однородной пасты.
Панир нарезать кубиками 2x2 см, слегка обжарить в гхи до золотистой корочки.
В той же сковороде добавить гхи, обжарить кумин до потрескивания.
Добавить мелко нарезанные помидоры, имбирь и чили. Тушить 5 минут.
Добавить шпинатное пюре, гарам масалу и соль. Тушить 10 минут.
Добавить сливки, перемешать. Готовить ещё 3 минуты.
Аккуратно добавить обжаренный панир. Прогреть 2 минуты.
Подавать горячим с рисом басмати или чапати.',
    instructions_en = 'Wash spinach thoroughly, blanch in boiling water for 2-3 minutes.
Blend spinach into a smooth paste.
Cut paneer into 2x2 cm cubes, lightly fry in ghee until golden.
In the same pan, add ghee, fry cumin until it crackles.
Add finely chopped tomatoes, ginger and chili. Sauté for 5 minutes.
Add spinach puree, garam masala and salt. Cook for 10 minutes.
Add cream, stir. Cook for another 3 minutes.
Gently add fried paneer. Heat for 2 minutes.
Serve hot with basmati rice or chapati.',
    instructions_hi = 'पालक को अच्छी तरह धोएं, उबलते पानी में 2-3 मिनट के लिए ब्लांच करें।
पालक को ब्लेंडर में पीसकर पेस्ट बना लें।
पनीर को 2x2 सेमी के टुकड़ों में काटें, घी में हल्का सुनहरा होने तक भूनें।
उसी पैन में घी डालें, जीरा चटकने तक भूनें।
बारीक कटे टमाटर, अदरक और मिर्च डालें। 5 मिनट तक पकाएं।
पालक प्यूरी, गरम मसाला और नमक डालें। 10 मिनट पकाएं।
क्रीम डालें, मिलाएं। 3 मिनट और पकाएं।
धीरे से तला हुआ पनीर डालें। 2 मिनट गरम करें।
बासमती चावल या चपाती के साथ गरमागरम परोसें।'
WHERE name_en = 'Palak Paneer';

-- Добавляем ингредиенты для Палак Панир
-- Сначала получаем ID рецепта
DO $$
DECLARE
    recipe_uuid UUID;
    spinach_id UUID;
    paneer_id UUID;
    tomato_id UUID;
    ginger_id UUID;
    chili_id UUID;
    cream_id UUID;
    ghee_id UUID;
    cumin_id UUID;
    garam_id UUID;
    salt_id UUID;
BEGIN
    -- Получаем ID рецепта
    SELECT id INTO recipe_uuid FROM recipes WHERE name_en = 'Palak Paneer' LIMIT 1;

    -- Получаем ID продуктов (или создаём если нет)
    SELECT id INTO spinach_id FROM products WHERE name_en = 'Spinach' LIMIT 1;
    IF spinach_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Шпинат', 'Spinach', 'पालक', 'pālak', 'kg')
        RETURNING id INTO spinach_id;
    END IF;

    SELECT id INTO paneer_id FROM products WHERE name_en = 'Paneer' LIMIT 1;
    IF paneer_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Панир', 'Paneer', 'पनीर', 'panīr', 'kg')
        RETURNING id INTO paneer_id;
    END IF;

    SELECT id INTO tomato_id FROM products WHERE name_en = 'Tomatoes' LIMIT 1;
    IF tomato_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Помидоры', 'Tomatoes', 'टमाटर', 'ṭamāṭar', 'kg')
        RETURNING id INTO tomato_id;
    END IF;

    SELECT id INTO ginger_id FROM products WHERE name_en = 'Ginger' LIMIT 1;
    IF ginger_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Имбирь', 'Ginger', 'अदरक', 'adrak', 'g')
        RETURNING id INTO ginger_id;
    END IF;

    SELECT id INTO chili_id FROM products WHERE name_en ILIKE '%green chili%' LIMIT 1;
    IF chili_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'vegetables'), 'Перец чили зелёный', 'Green Chili', 'हरी मिर्च', 'harī mirch', 'g')
        RETURNING id INTO chili_id;
    END IF;

    SELECT id INTO cream_id FROM products WHERE name_en = 'Cream' LIMIT 1;
    IF cream_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Сливки', 'Cream', 'क्रीम', 'krīm', 'ml')
        RETURNING id INTO cream_id;
    END IF;

    SELECT id INTO ghee_id FROM products WHERE name_en = 'Ghee' LIMIT 1;
    IF ghee_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'dairy'), 'Гхи', 'Ghee', 'घी', 'ghī', 'g')
        RETURNING id INTO ghee_id;
    END IF;

    SELECT id INTO cumin_id FROM products WHERE name_en ILIKE '%cumin%' LIMIT 1;
    IF cumin_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'spices'), 'Кумин (зира)', 'Cumin', 'जीरा', 'jīrā', 'g')
        RETURNING id INTO cumin_id;
    END IF;

    SELECT id INTO garam_id FROM products WHERE name_en ILIKE '%garam masala%' LIMIT 1;
    IF garam_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'spices'), 'Гарам масала', 'Garam Masala', 'गरम मसाला', 'garam masālā', 'g')
        RETURNING id INTO garam_id;
    END IF;

    SELECT id INTO salt_id FROM products WHERE name_en = 'Salt' LIMIT 1;
    IF salt_id IS NULL THEN
        INSERT INTO products (category_id, name_ru, name_en, name_hi, translit, unit)
        VALUES ((SELECT id FROM product_categories WHERE slug = 'spices'), 'Соль', 'Salt', 'नमक', 'namak', 'g')
        RETURNING id INTO salt_id;
    END IF;

    -- Удаляем старые ингредиенты если есть
    DELETE FROM recipe_ingredients WHERE recipe_id = recipe_uuid;

    -- Добавляем ингредиенты
    INSERT INTO recipe_ingredients (recipe_id, product_id, amount, unit, sort_order) VALUES
        (recipe_uuid, spinach_id, 2, 'kg', 1),
        (recipe_uuid, paneer_id, 1, 'kg', 2),
        (recipe_uuid, tomato_id, 0.3, 'kg', 3),
        (recipe_uuid, ginger_id, 30, 'g', 4),
        (recipe_uuid, chili_id, 30, 'g', 5),
        (recipe_uuid, cream_id, 200, 'ml', 6),
        (recipe_uuid, ghee_id, 100, 'g', 7),
        (recipe_uuid, cumin_id, 15, 'g', 8),
        (recipe_uuid, garam_id, 10, 'g', 9),
        (recipe_uuid, salt_id, 30, 'g', 10);

END $$;

-- ============================================
-- Переводы для страницы рецепта
-- ============================================
INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('back_to_recipes', 'Назад к рецептам', 'Back to recipes', 'व्यंजनों पर वापस', 'recipe'),
    ('print', 'Печать', 'Print', 'प्रिंट', 'recipe'),
    ('ingredients_title', 'Ингредиенты', 'Ingredients', 'सामग्री', 'recipe'),
    ('instructions_title', 'Приготовление', 'Instructions', 'विधि', 'recipe'),
    ('ingredient', 'Продукт', 'Ingredient', 'सामग्री', 'recipe'),
    ('amount', 'Количество', 'Amount', 'मात्रा', 'recipe'),
    ('calc_for', 'на', 'for', '', 'recipe'),
    ('calc_persons', 'чел.', 'ppl', 'लोग', 'recipe'),
    ('calc_grams', 'г', 'g', 'ग्राम', 'recipe'),
    ('no_instructions', 'Инструкции не добавлены', 'No instructions added', 'निर्देश नहीं जोड़े गए', 'recipe'),
    ('recipe_not_found', 'Рецепт не найден', 'Recipe not found', 'रेसिपी नहीं मिली', 'recipe')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
