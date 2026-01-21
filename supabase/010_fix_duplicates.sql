-- ============================================
-- Удаление дубликатов продуктов
-- ============================================

-- 1. Создаём временную таблицу с первым (оригинальным) продуктом для каждого name_en
CREATE TEMP TABLE first_products AS
SELECT DISTINCT ON (name_en) id, name_en
FROM products
ORDER BY name_en, created_at ASC;

-- 2. Обновляем recipe_ingredients чтобы ссылались на оригинальный продукт
UPDATE recipe_ingredients ri
SET product_id = fp.id
FROM products p, first_products fp
WHERE ri.product_id = p.id
  AND p.name_en = fp.name_en
  AND ri.product_id != fp.id;

-- 3. Удаляем дубликаты продуктов, оставляя только оригинальные
DELETE FROM products
WHERE id NOT IN (SELECT id FROM first_products);

-- 4. Удаляем дубликаты ингредиентов в рецептах
CREATE TEMP TABLE first_ingredients AS
SELECT DISTINCT ON (recipe_id, product_id) id
FROM recipe_ingredients
ORDER BY recipe_id, product_id, sort_order ASC;

DELETE FROM recipe_ingredients
WHERE id NOT IN (SELECT id FROM first_ingredients);

-- 5. Добавляем уникальное ограничение на name_en
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_name_en_unique;
ALTER TABLE products ADD CONSTRAINT products_name_en_unique UNIQUE (name_en);

-- Удаляем временные таблицы
DROP TABLE first_products;
DROP TABLE first_ingredients;

-- Проверка результата
SELECT COUNT(*) as total_products FROM products;
SELECT name_en, COUNT(*) as cnt FROM products GROUP BY name_en HAVING COUNT(*) > 1;
