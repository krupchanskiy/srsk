-- Отличаем «получатель не назван» от «названо неоднозначно».
--
-- У казначея неназванный получатель — это департамент чата, в котором он
-- пишет. Но если имя названо и оно неоднозначно (Олег Карпов отвечает за
-- «Отдел продаж» и за личный департамент), подставлять департамент чата
-- нельзя: деньги молча ушли бы не туда. Решение Адриана — уточнять каждый раз.
CREATE OR REPLACE FUNCTION tg_department_hits(p_text text, p_exclude uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH t AS (SELECT lower(translate(p_text, 'Ёё', 'Ее')) AS txt),
  keys AS (
    SELECT d.id, lower(translate(left(d.name, 4), 'Ёё', 'Ее')) AS k
    FROM fin_departments d
    UNION ALL
    SELECT d.id, lower(translate(left(COALESCE(NULLIF(v.spiritual_name,''),
             trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))), 4), 'Ёё', 'Ее'))
    FROM fin_departments d JOIN vaishnavas v ON v.id = d.responsible_person_id
  )
  SELECT count(DISTINCT k.id)::int FROM keys k, t
  WHERE length(k.k) >= 3 AND t.txt LIKE '%' || k.k || '%'
    AND k.id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000');
$$;

REVOKE ALL ON FUNCTION tg_department_hits(text, uuid) FROM PUBLIC, anon;
