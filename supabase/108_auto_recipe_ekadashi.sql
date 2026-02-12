-- Автоматический расчёт ekadashi для рецептов по ингредиентам
-- Рецепт считается экадашным, если есть хотя бы один ингредиент
-- и ВСЕ ингредиенты имеют products.ekadashi = true

-- Функция пересчёта ekadashi для одного рецепта
CREATE OR REPLACE FUNCTION recalc_recipe_ekadashi(p_recipe_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_ekadashi boolean;
BEGIN
  SELECT
    CASE
      WHEN COUNT(ri.id) > 0
           AND COUNT(ri.id) = COUNT(CASE WHEN p.ekadashi = true THEN 1 END)
        THEN true
      ELSE false
    END INTO v_ekadashi
  FROM recipe_ingredients ri
  JOIN products p ON p.id = ri.product_id
  WHERE ri.recipe_id = p_recipe_id;

  UPDATE recipes
  SET ekadashi = v_ekadashi
  WHERE id = p_recipe_id
    AND ekadashi IS DISTINCT FROM v_ekadashi;
END;
$$;

-- Триггерная функция для recipe_ingredients (INSERT/DELETE)
CREATE OR REPLACE FUNCTION trg_recipe_ingredients_ekadashi()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recalc_recipe_ekadashi(OLD.recipe_id);
  ELSE
    PERFORM recalc_recipe_ekadashi(NEW.recipe_id);
  END IF;
  RETURN NULL;
END;
$$;

-- Триггерная функция для products (UPDATE ekadashi)
CREATE OR REPLACE FUNCTION trg_products_ekadashi()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT DISTINCT ri.recipe_id
    FROM recipe_ingredients ri
    WHERE ri.product_id = NEW.id
  LOOP
    PERFORM recalc_recipe_ekadashi(r.recipe_id);
  END LOOP;
  RETURN NULL;
END;
$$;

-- Триггер на recipe_ingredients
CREATE TRIGGER recipe_ingredients_ekadashi_trg
  AFTER INSERT OR DELETE ON recipe_ingredients
  FOR EACH ROW
  EXECUTE FUNCTION trg_recipe_ingredients_ekadashi();

-- Триггер на products
CREATE TRIGGER products_ekadashi_trg
  AFTER UPDATE OF ekadashi ON products
  FOR EACH ROW
  EXECUTE FUNCTION trg_products_ekadashi();

-- Пересчитать все существующие рецепты
UPDATE recipes r
SET ekadashi = sub.calc_ekadashi
FROM (
  SELECT
    r2.id,
    CASE
      WHEN COUNT(ri.id) > 0
           AND COUNT(ri.id) = COUNT(CASE WHEN p.ekadashi = true THEN 1 END)
        THEN true
      ELSE false
    END AS calc_ekadashi
  FROM recipes r2
  LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r2.id
  LEFT JOIN products p ON p.id = ri.product_id
  GROUP BY r2.id
) sub
WHERE r.id = sub.id
  AND r.ekadashi IS DISTINCT FROM sub.calc_ekadashi;
