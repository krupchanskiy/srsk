-- ============================================
-- Политики для записи в таблицы
-- ============================================

-- Recipes: разрешаем INSERT, UPDATE, DELETE для всех (анонимных)
DROP POLICY IF EXISTS "Public insert recipes" ON recipes;
DROP POLICY IF EXISTS "Public update recipes" ON recipes;
DROP POLICY IF EXISTS "Public delete recipes" ON recipes;

CREATE POLICY "Public insert recipes" ON recipes FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update recipes" ON recipes FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete recipes" ON recipes FOR DELETE TO anon USING (true);

-- Recipe ingredients: разрешаем INSERT, UPDATE, DELETE для всех
DROP POLICY IF EXISTS "Public insert recipe_ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Public update recipe_ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Public delete recipe_ingredients" ON recipe_ingredients;

CREATE POLICY "Public insert recipe_ingredients" ON recipe_ingredients FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update recipe_ingredients" ON recipe_ingredients FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete recipe_ingredients" ON recipe_ingredients FOR DELETE TO anon USING (true);

-- Products: разрешаем INSERT, UPDATE, DELETE для всех
DROP POLICY IF EXISTS "Public insert products" ON products;
DROP POLICY IF EXISTS "Public update products" ON products;
DROP POLICY IF EXISTS "Public delete products" ON products;

CREATE POLICY "Public insert products" ON products FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update products" ON products FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete products" ON products FOR DELETE TO anon USING (true);

-- Translations: разрешаем INSERT, UPDATE для всех
DROP POLICY IF EXISTS "Public insert translations" ON translations;
DROP POLICY IF EXISTS "Public update translations" ON translations;

CREATE POLICY "Public insert translations" ON translations FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update translations" ON translations FOR UPDATE TO anon USING (true) WITH CHECK (true);
