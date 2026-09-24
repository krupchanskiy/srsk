-- Ник сравнивался целиком: «Женя» не совпадало с «Жене» (дательный падеж).
-- Для ников короче 5 букв берём основу без последней буквы, для длинных — 4 первые буквы.
CREATE OR REPLACE FUNCTION public.tg_match_department_holder(p_department uuid, p_text text, p_exclude uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH t AS (SELECT lower(translate(p_text, 'Ёё', 'Ее')) AS txt),
  keys AS (
    SELECT fh.vaishnava_id AS id,
           lower(translate(left(COALESCE(NULLIF(v.spiritual_name,''),
                    trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))), 4), 'Ёё', 'Ее')) AS k
      FROM fin_department_holders fh
      JOIN vaishnavas v ON v.id = fh.vaishnava_id
     WHERE fh.department_id = p_department AND fh.is_active
    UNION ALL
    SELECT fh.vaishnava_id,
           lower(translate(
             CASE WHEN length(fh.nickname) > 4 THEN left(fh.nickname, 4)
                  ELSE left(fh.nickname, length(fh.nickname) - 1) END,
             'Ёё', 'Ее'))
      FROM fin_department_holders fh
     WHERE fh.department_id = p_department AND fh.is_active
       AND fh.nickname IS NOT NULL AND length(fh.nickname) >= 4
  ),
  hits AS (
    SELECT DISTINCT k.id FROM keys k, t
    WHERE length(k.k) >= 3 AND t.txt LIKE '%' || k.k || '%'
      AND k.id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000')
  )
  SELECT id FROM hits WHERE (SELECT count(*) FROM hits) = 1;
$function$;
