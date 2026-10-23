-- 742: ⚠ «траты в дни ретрита без пометки ретрита» в блоке спонсора (ВГ 23.10.2026).
--
-- Трата, у которой забыли указать ретрит, не попадёт в зачёт спонсору. Подозрительные:
-- расход в официальные даты ретрита без объекта, у которого
--   • в комментарии есть слово из названия ретрита («Художник…», «Artist…»), или
--   • та же статья с того же счёта, что у уже отмеченных трат этого ретрита (такси через Ашиша).
-- Исправление — поставить ретрит у траты (ДДС → правка аналитики): зачёт появится сам.
-- «Не относится» — убрать строку из предупреждения (fin_sponsor_dismissed).

CREATE TABLE IF NOT EXISTS fin_sponsor_dismissed (
  retreat_id uuid NOT NULL REFERENCES retreats(id),
  operation_id uuid NOT NULL REFERENCES fin_operations(id),
  dismissed_by uuid,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (retreat_id, operation_id)
);
ALTER TABLE fin_sponsor_dismissed ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION fin_private_sponsor_suspects(p_retreat uuid)
RETURNS TABLE (operation_id uuid, occurred_on date, account_name text, category text,
               amount numeric, currency_code text, comment text, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH r AS (
    SELECT rt.id, rt.start_date, rt.end_date, ob.id AS obj,
           -- слова названия без «ретрит/retreat»: длинные — по основе из 6 букв
           ARRAY(SELECT CASE WHEN length(w) >= 7 THEN left(w, 6) ELSE w END
                   FROM regexp_split_to_table(lower(coalesce(rt.name_ru, '') || ' ' || coalesce(rt.name_en, '')), '[^[:alpha:]]+') w
                  WHERE length(w) >= 4 AND w NOT IN ('ретрит', 'retreat')) AS words
      FROM retreats rt JOIN fin_accounting_objects ob ON ob.retreat_id = rt.id
     WHERE rt.id = p_retreat
  ), tagged AS (
    SELECT DISTINCT p.category_id, p.account_id
      FROM fin_postings p JOIN fin_operations o ON o.id = p.operation_id, r
     WHERE p.object_id = r.obj AND o.type = 'expense' AND NOT o.is_reversed
  )
  SELECT o.id, o.occurred_on, a.name, c.name, p.amount, p.currency_code, left(o.comment, 160),
         CASE WHEN EXISTS (SELECT 1 FROM unnest(r.words) w WHERE lower(coalesce(o.comment, '') || ' ' || coalesce(p.note, '')) LIKE '%' || w || '%')
              THEN 'name' ELSE 'same' END
    FROM r
    JOIN fin_operations o ON o.occurred_on BETWEEN r.start_date AND r.end_date
    JOIN fin_postings p ON p.operation_id = o.id
    JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN fin_categories c ON c.id = p.category_id
   WHERE o.type = 'expense' AND NOT o.is_reversed AND p.direction = 'out' AND p.object_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM fin_postings p2 WHERE p2.operation_id = o.id AND p2.object_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM fin_sponsor_dismissed d WHERE d.retreat_id = r.id AND d.operation_id = o.id)
     AND (EXISTS (SELECT 1 FROM unnest(r.words) w WHERE lower(coalesce(o.comment, '') || ' ' || coalesce(p.note, '')) LIKE '%' || w || '%')
          OR EXISTS (SELECT 1 FROM tagged t WHERE t.category_id = p.category_id AND t.account_id = p.account_id))
   ORDER BY o.occurred_on;
$$;

CREATE OR REPLACE FUNCTION fin_sponsor_dismiss(p_retreat uuid, p_operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := fin_actor();
BEGIN
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Доступно администратору финансов';
  END IF;
  INSERT INTO fin_sponsor_dismissed (retreat_id, operation_id, dismissed_by)
  VALUES (p_retreat, p_operation, v_actor) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- в ответ блока спонсора — подозрительные траты (только когда спонсор назначен)
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('fin_get_retreat_sponsor(uuid)'::regprocedure);
  v_new := replace(v_def,
    $s$    -- кого можно выбрать: действующие подотчётные счета в ₹$s$,
    $s$    -- ⚠ траты в дни ретрита без пометки ретрита (мигр. 742)
    'suspects', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.occurred_on)
                            FROM fin_private_sponsor_suspects(p_retreat) s
                           WHERE v_sp.account_id IS NOT NULL), '[]'::jsonb),
    -- кого можно выбрать: действующие подотчётные счета в ₹$s$);
  IF v_new = v_def THEN RAISE EXCEPTION 'fin_get_retreat_sponsor: шаблон не найден'; END IF;
  EXECUTE v_new;
END
$mig$;

REVOKE ALL ON FUNCTION fin_private_sponsor_suspects(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fin_sponsor_dismiss(uuid, uuid) TO authenticated;
