-- =============================================================
-- UX 7.2: category_id в by_category общей аналитики (fin_get_summary_report),
-- чтобы статью можно было кликнуть → ДДС с фильтром по статье.
-- Чисто читающая функция; закрытий/PDF/snapshot не касается.
-- (Отчёт ретрита уже отдаёт category_id из fin_private_build_snapshot —
--  там серверная правка не нужна.)
-- =============================================================
CREATE OR REPLACE FUNCTION public.fin_get_summary_report(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_by_category jsonb;
  v_by_month jsonb;
  v_by_object jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'category_id', x.id, 'name', x.name, 'direction', x.direction, 'base_total', x.base_total) ORDER BY x.direction, x.base_total DESC), '[]'::jsonb)
  INTO v_by_category
  FROM (
    SELECT c.id, c.name, c.direction::text AS direction,
           SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END)
             * CASE c.direction WHEN 'out' THEN -1 ELSE 1 END AS base_total
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_categories c ON c.id = p.category_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
    GROUP BY c.id, c.name, c.direction
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'month', x.m, 'income_base', x.inc, 'expense_base', x.exp) ORDER BY x.m), '[]'::jsonb)
  INTO v_by_month
  FROM (
    SELECT to_char(date_trunc('month', o.occurred_on), 'YYYY-MM') AS m,
           SUM(CASE WHEN p.direction = 'in'  THEN p.amount_base ELSE 0 END) AS inc,
           SUM(CASE WHEN p.direction = 'out' THEN p.amount_base ELSE 0 END) AS exp
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
      AND p.category_id IS NOT NULL
    GROUP BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'object_id', x.oid, 'name', x.nm, 'income_base', x.inc, 'expense_base', x.exp) ORDER BY x.inc DESC), '[]'::jsonb)
  INTO v_by_object
  FROM (
    SELECT p.object_id AS oid,
           COALESCE(obj.display_name, '— без объекта —') AS nm,
           SUM(CASE WHEN p.direction = 'in'  THEN p.amount_base ELSE 0 END) AS inc,
           SUM(CASE WHEN p.direction = 'out' THEN p.amount_base ELSE 0 END) AS exp
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    LEFT JOIN fin_accounting_objects obj ON obj.id = p.object_id
    WHERE o.occurred_on BETWEEN p_from AND p_to
      AND p.category_id IS NOT NULL
    GROUP BY 1, 2
  ) x;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'from', p_from, 'to', p_to,
    'by_category', v_by_category,
    'by_month', v_by_month,
    'by_object', v_by_object
  ));
END;
$function$;
