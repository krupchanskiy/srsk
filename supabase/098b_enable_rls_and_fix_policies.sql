-- ================================================
-- Миграция: Включение RLS и исправление политик безопасности
-- ================================================

-- 1. КРИТИЧНО: Включить RLS на таблице superusers
ALTER TABLE superusers ENABLE ROW LEVEL SECURITY;

-- Политика: только суперпользователи могут управлять таблицей superusers
DROP POLICY IF EXISTS "Only superusers can manage superusers" ON superusers;
CREATE POLICY "Only superusers can manage superusers" ON superusers
    FOR ALL TO authenticated
    USING (auth.uid() IN (SELECT user_id FROM superusers))
    WITH CHECK (auth.uid() IN (SELECT user_id FROM superusers));

-- Политика чтения для аутентифицированных (нужна для проверки is_superuser)
DROP POLICY IF EXISTS "Authenticated can read superusers" ON superusers;
CREATE POLICY "Authenticated can read superusers" ON superusers
    FOR SELECT TO authenticated
    USING (true);

-- 2. Включить RLS на profiles (поле id, не user_id)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
CREATE POLICY "Users can read own profile" ON profiles
    FOR SELECT TO authenticated
    USING (id = auth.uid() OR auth.uid() IN (SELECT user_id FROM superusers));

DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE TO authenticated
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Superusers can manage profiles" ON profiles;
CREATE POLICY "Superusers can manage profiles" ON profiles
    FOR ALL TO authenticated
    USING (auth.uid() IN (SELECT user_id FROM superusers))
    WITH CHECK (auth.uid() IN (SELECT user_id FROM superusers));

-- 3. Включить RLS на departments и убрать anon доступ на запись
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public delete departments" ON departments;
DROP POLICY IF EXISTS "Public insert departments" ON departments;
DROP POLICY IF EXISTS "Public update departments" ON departments;
DROP POLICY IF EXISTS "Public read departments" ON departments;

CREATE POLICY "Authenticated read departments" ON departments
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Superusers manage departments" ON departments
    FOR ALL TO authenticated
    USING (auth.uid() IN (SELECT user_id FROM superusers))
    WITH CHECK (auth.uid() IN (SELECT user_id FROM superusers));

-- 4. Включить RLS на holidays и убрать anon доступ на запись
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public delete holidays" ON holidays;
DROP POLICY IF EXISTS "Public insert holidays" ON holidays;
DROP POLICY IF EXISTS "Public update holidays" ON holidays;
DROP POLICY IF EXISTS "Public read holidays" ON holidays;

CREATE POLICY "Public read holidays" ON holidays
    FOR SELECT TO public
    USING (true);

CREATE POLICY "Superusers manage holidays" ON holidays
    FOR ALL TO authenticated
    USING (auth.uid() IN (SELECT user_id FROM superusers))
    WITH CHECK (auth.uid() IN (SELECT user_id FROM superusers));

-- 5. Включить RLS на locations
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read locations" ON locations;
CREATE POLICY "Public read locations" ON locations
    FOR SELECT TO public
    USING (true);

CREATE POLICY "Superusers manage locations" ON locations
    FOR ALL TO authenticated
    USING (auth.uid() IN (SELECT user_id FROM superusers))
    WITH CHECK (auth.uid() IN (SELECT user_id FROM superusers));

-- 6. Включить RLS на menu_* таблицах
ALTER TABLE menu_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_template_dishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_template_meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_templates ENABLE ROW LEVEL SECURITY;

-- Удаляем anon политики на menu_*
DROP POLICY IF EXISTS "Public delete menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public insert menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public update menu_dishes" ON menu_dishes;
DROP POLICY IF EXISTS "Public read menu_dishes" ON menu_dishes;

DROP POLICY IF EXISTS "Public delete menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public insert menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public update menu_meals" ON menu_meals;
DROP POLICY IF EXISTS "Public read menu_meals" ON menu_meals;

DROP POLICY IF EXISTS "Public delete menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public insert menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public update menu_template_dishes" ON menu_template_dishes;
DROP POLICY IF EXISTS "Public read menu_template_dishes" ON menu_template_dishes;

DROP POLICY IF EXISTS "Public delete menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public insert menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public update menu_template_meals" ON menu_template_meals;
DROP POLICY IF EXISTS "Public read menu_template_meals" ON menu_template_meals;

DROP POLICY IF EXISTS "Public delete menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public insert menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public update menu_templates" ON menu_templates;
DROP POLICY IF EXISTS "Public read menu_templates" ON menu_templates;

-- Новые политики для menu_*
CREATE POLICY "Authenticated read menu_days" ON menu_days FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_days" ON menu_days FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_dishes" ON menu_dishes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_dishes" ON menu_dishes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_items" ON menu_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_items" ON menu_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_meals" ON menu_meals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_meals" ON menu_meals FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_template_dishes" ON menu_template_dishes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_template_dishes" ON menu_template_dishes FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_template_meals" ON menu_template_meals FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_template_meals" ON menu_template_meals FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read menu_templates" ON menu_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage menu_templates" ON menu_templates FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 7. Включить RLS на product_categories и products, убрать anon доступ на запись
ALTER TABLE product_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public delete product_categories" ON product_categories;
DROP POLICY IF EXISTS "Public insert product_categories" ON product_categories;
DROP POLICY IF EXISTS "Public update product_categories" ON product_categories;
DROP POLICY IF EXISTS "Public read product_categories" ON product_categories;

DROP POLICY IF EXISTS "Public delete products" ON products;
DROP POLICY IF EXISTS "Public insert products" ON products;
DROP POLICY IF EXISTS "Public update products" ON products;
DROP POLICY IF EXISTS "Public read products" ON products;

CREATE POLICY "Public read product_categories" ON product_categories FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated manage product_categories" ON product_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Public read products" ON products FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated manage products" ON products FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 8. Включить RLS на recipe_categories, recipe_ingredients, recipes
ALTER TABLE recipe_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public delete recipe_categories" ON recipe_categories;
DROP POLICY IF EXISTS "Public insert recipe_categories" ON recipe_categories;
DROP POLICY IF EXISTS "Public update recipe_categories" ON recipe_categories;
DROP POLICY IF EXISTS "Public read recipe_categories" ON recipe_categories;

DROP POLICY IF EXISTS "Public delete recipe_ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Public insert recipe_ingredients" ON recipe_ingredients;
DROP POLICY IF EXISTS "Public update recipe_ingredients" ON recipe_ingredients;

DROP POLICY IF EXISTS "Public delete recipes" ON recipes;
DROP POLICY IF EXISTS "Public insert recipes" ON recipes;
DROP POLICY IF EXISTS "Public update recipes" ON recipes;
DROP POLICY IF EXISTS "Public read recipes" ON recipes;

CREATE POLICY "Public read recipe_categories" ON recipe_categories FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated manage recipe_categories" ON recipe_categories FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read recipe_ingredients" ON recipe_ingredients FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage recipe_ingredients" ON recipe_ingredients FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Public read recipes" ON recipes FOR SELECT TO public USING (true);
CREATE POLICY "Authenticated manage recipes" ON recipes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 9. Включить RLS на retreats
ALTER TABLE retreats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public delete retreats" ON retreats;
DROP POLICY IF EXISTS "Public insert retreats" ON retreats;
DROP POLICY IF EXISTS "Public update retreats" ON retreats;
DROP POLICY IF EXISTS "Public read retreats" ON retreats;
DROP POLICY IF EXISTS "Authenticated delete retreats" ON retreats;
DROP POLICY IF EXISTS "Authenticated insert retreats" ON retreats;
DROP POLICY IF EXISTS "Authenticated update retreats" ON retreats;
DROP POLICY IF EXISTS "Authenticated read retreats" ON retreats;

CREATE POLICY "Authenticated read retreats" ON retreats FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage retreats" ON retreats FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 10. Включить RLS на stock_* таблицах
ALTER TABLE stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_inventories ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_inventory_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transactions ENABLE ROW LEVEL SECURITY;

-- Удаляем старые политики stock
DROP POLICY IF EXISTS "Auth delete stock" ON stock;
DROP POLICY IF EXISTS "Auth insert stock" ON stock;
DROP POLICY IF EXISTS "Auth update stock" ON stock;
DROP POLICY IF EXISTS "Public read stock" ON stock;

CREATE POLICY "Authenticated read stock" ON stock FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock" ON stock FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read stock_inventories" ON stock_inventories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock_inventories" ON stock_inventories FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read stock_inventory_items" ON stock_inventory_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock_inventory_items" ON stock_inventory_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read stock_request_items" ON stock_request_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock_request_items" ON stock_request_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read stock_requests" ON stock_requests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock_requests" ON stock_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated read stock_transactions" ON stock_transactions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage stock_transactions" ON stock_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 11. Включить RLS на team_presence
ALTER TABLE team_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read team_presence" ON team_presence FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated manage team_presence" ON team_presence FOR ALL TO authenticated USING (true) WITH CHECK (true);
