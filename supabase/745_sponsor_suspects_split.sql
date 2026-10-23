-- 745: ⚠ плашки спонсора — не показывать доли разделённой траты (ВГ 23.10.2026).
-- Такси на несколько департаментов делится в одной заявке из чата на части; если часть
-- ретрита уже отмечена, остальные части — других департаментов, в плашку не идут.

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
     -- трата разделена по департаментам (одна заявка из чата), и доля ретрита уже отмечена —
     -- остальные доли принадлежат другим департаментам (мигр. 745)
     AND NOT EXISTS (SELECT 1 FROM tg_draft_operations d1
                       JOIN tg_draft_operations d2 ON d2.draft_id = d1.draft_id AND d2.operation_id <> d1.operation_id
                       JOIN fin_operations o2 ON o2.id = d2.operation_id AND NOT o2.is_reversed
                       JOIN fin_postings p2 ON p2.operation_id = o2.id AND p2.object_id = r.obj
                      WHERE d1.operation_id = o.id)
     AND (EXISTS (SELECT 1 FROM unnest(r.words) w WHERE lower(coalesce(o.comment, '') || ' ' || coalesce(p.note, '')) LIKE '%' || w || '%')
          OR EXISTS (SELECT 1 FROM tagged t WHERE t.category_id = p.category_id AND t.account_id = p.account_id))
   ORDER BY o.occurred_on;
$$;

