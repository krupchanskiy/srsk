-- Просьба ВГ от 26.07.2026: «можно сюда прикрепить категории затрат для
-- каждого департамента свой набор из списка».
--
-- Было: у статьи один глобальный флаг visible_to_departments, и бот показывал
-- один и тот же набор из 11 статей всем департаментам подряд. Кухне
-- предлагались «Ремонт и стройматериалы», мастерской — «Продукты».
--
-- Стало: у департамента может быть свой набор. Правило перекрытия то же, что
-- у шаблонов задач CRM: если у департамента есть свой список — он ПОЛНОСТЬЮ
-- заменяет общий; если списка нет — работает общий набор. Так добавление
-- новой общей статьи не требует обходить все департаменты, а departments со
-- своим набором не получают лишнего.

CREATE TABLE IF NOT EXISTS public.fin_department_categories (
  department_id uuid NOT NULL REFERENCES fin_departments(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES fin_categories(id)  ON DELETE CASCADE,
  PRIMARY KEY (department_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_fin_department_categories_category
  ON public.fin_department_categories(category_id);

ALTER TABLE public.fin_department_categories ENABLE ROW LEVEL SECURITY;
-- Прямого доступа нет: читается витриной, пишется через fin_save_department.

CREATE OR REPLACE VIEW public.fin_v_department_categories AS
  SELECT dc.department_id, dc.category_id, c.name AS category_name, c.code AS category_code
  FROM fin_department_categories dc
  JOIN fin_categories c ON c.id = dc.category_id
  WHERE fin_can_read_all();

GRANT SELECT ON public.fin_v_department_categories TO authenticated;

-- Список статей для бота: свой набор департамента, иначе общий.
CREATE OR REPLACE FUNCTION public.tg_list_expense_categories(p_chat bigint DEFAULT NULL)
RETURNS TABLE(id uuid, name text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH dept AS (
    SELECT l.department_id FROM tg_chat_links l
     WHERE p_chat IS NOT NULL AND l.chat_id = p_chat AND l.is_active
  ),
  own AS (
    SELECT c.id, c.name
    FROM fin_department_categories dc
    JOIN fin_categories c ON c.id = dc.category_id
    WHERE dc.department_id = (SELECT department_id FROM dept)
      AND c.is_active AND c.direction = 'out'
  )
  SELECT id, name FROM own
  UNION ALL
  SELECT c.id, c.name FROM fin_categories c
   WHERE NOT EXISTS (SELECT 1 FROM own)
     AND c.direction = 'out' AND c.visible_to_departments AND c.is_active
  ORDER BY name;
$function$;
