-- Этап 7-А интеграции: семейные связи (решения ВГ от 23.07.2026).
-- Связь ПОСТОЯННАЯ (не пер-ретритная): «не поехал» решается отсутствием данных.
-- Связи живут в CONTACTS (vaishnavas), финмодуль ими не владеет — он только
-- читает их в портальном RPC. Доступ семьи — равный; группа (лидер) — отдельная
-- задача 2, в бэклоге. Видимость по родственнику: итог + разбивка по блокам,
-- БЕЗ построчной детализации (платежи/начисления/причины скидок не отдаются).

CREATE TABLE IF NOT EXISTS family_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vaishnava_id uuid NOT NULL REFERENCES vaishnavas(id) ON DELETE CASCADE,
  relative_id uuid NOT NULL REFERENCES vaishnavas(id) ON DELETE CASCADE,
  -- кем relative приходится vaishnava: 'spouse' | 'child' | 'parent' | 'sibling'
  relation text NOT NULL CHECK (relation IN ('spouse','child','parent','sibling')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (vaishnava_id <> relative_id),
  UNIQUE (vaishnava_id, relative_id)
);
CREATE INDEX IF NOT EXISTS idx_family_links_relative ON family_links(relative_id);

ALTER TABLE family_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff manage family links" ON family_links;
CREATE POLICY "Staff manage family links" ON family_links
  FOR ALL TO authenticated
  USING (is_staff((SELECT auth.uid())))
  WITH CHECK (is_staff((SELECT auth.uid())));

COMMENT ON TABLE family_links IS
'Семейные связи (этап 7 интеграции финмодуля). Одна строка на пару; relation читается как «кем relative приходится vaishnava». Доступ к чужим фин-итогам в портале — по прямым связям, в обе стороны.';

-- Есть ли у участника фин-данные по ретриту (invoker; зовётся из definer-функций)
CREATE OR REPLACE FUNCTION public.fin_private_has_retreat_data(p_participant uuid, p_retreat uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (SELECT 1 FROM fin_charges c
                 WHERE c.retreat_id = p_retreat AND c.participant_id = p_participant)
      OR EXISTS (SELECT 1 FROM fin_participant_opening_balances b
                 WHERE b.retreat_id = p_retreat AND b.participant_id = p_participant)
      OR EXISTS (SELECT 1 FROM fin_postings p
                 JOIN fin_accounting_objects o ON o.id = p.object_id
                 WHERE o.retreat_id = p_retreat AND p.participant_id = p_participant
                   AND p.participant_balance_kind IS NOT NULL);
$function$;

-- Портальный RPC: своя детализация как была + семейные сводки + итог на семью.
CREATE OR REPLACE FUNCTION public.portal_fin_get_my_finances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_viewer uuid;
  v_result jsonb;
BEGIN
  SELECT id INTO v_viewer FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1;
  IF v_viewer IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'result', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'retreat_id', r.id,
      'retreat_name', COALESCE(r.name_ru, r.name_en),
      'start_date', r.start_date,
      'balance', fin_private_participant_balance(v_viewer, r.id),
      'charges', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'kind', c.kind, 'description', c.description,
          'amount', c.amount, 'discount_amount', c.discount_amount,
          'net_amount', c.amount - c.discount_amount,
          'is_cancelled', c.is_cancelled
        ) ORDER BY c.created_at), '[]'::jsonb)
        FROM fin_charges c
        WHERE c.participant_id = v_viewer AND c.retreat_id = r.id
      ),
      'payments', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'occurred_on', x->>'occurred_on',
          'type', x->>'type',
          'amount', x->'amount',
          'currency_code', x->>'currency_code',
          'amount_base', x->'amount_base',
          'payment_channel', x->>'payment_channel',
          'balance_kind', x->>'balance_kind',
          'status', x->>'status'
        )), '[]'::jsonb)
        FROM jsonb_array_elements(fin_private_participant_payments(v_viewer, r.id)) x
      ),
      -- Семья: только сводка по блокам, без строк платежей/начислений.
      -- Показываются лишь родственники, у которых есть данные ЭТОГО ретрита.
      'family', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'name', fin_private_person_name(f.rid),
          'relation', f.rel,
          'balance', fin_private_participant_balance(f.rid, r.id)
        ) ORDER BY fin_private_person_name(f.rid)), '[]'::jsonb)
        FROM (
          SELECT fl.relative_id AS rid, fl.relation AS rel
          FROM family_links fl WHERE fl.vaishnava_id = v_viewer
          UNION
          SELECT fl.vaishnava_id,
                 CASE fl.relation WHEN 'child' THEN 'parent'
                                  WHEN 'parent' THEN 'child'
                                  ELSE fl.relation END
          FROM family_links fl WHERE fl.relative_id = v_viewer
        ) f
        WHERE fin_private_has_retreat_data(f.rid, r.id)
      ),
      -- Итог на семью по ретриту: мой net + net родственников с данными ретрита
      'family_net', (
        SELECT round(COALESCE((fin_private_participant_balance(v_viewer, r.id)->>'net')::numeric, 0)
          + COALESCE(SUM((fin_private_participant_balance(f2.rid, r.id)->>'net')::numeric), 0), 2)
        FROM (
          SELECT fl.relative_id AS rid FROM family_links fl WHERE fl.vaishnava_id = v_viewer
          UNION
          SELECT fl.vaishnava_id FROM family_links fl WHERE fl.relative_id = v_viewer
        ) f2
        WHERE fin_private_has_retreat_data(f2.rid, r.id)
      )
    ) ORDER BY r.start_date DESC
  ), '[]'::jsonb) INTO v_result
  FROM retreats r
  WHERE fin_private_has_retreat_data(v_viewer, r.id)
     OR EXISTS (
       SELECT 1 FROM (
         SELECT fl.relative_id AS rid FROM family_links fl WHERE fl.vaishnava_id = v_viewer
         UNION
         SELECT fl.vaishnava_id FROM family_links fl WHERE fl.relative_id = v_viewer
       ) fam
       WHERE fin_private_has_retreat_data(fam.rid, r.id)
     );

  RETURN jsonb_build_object('ok', true, 'result', v_result);
END;
$function$;

-- Переводы этапа 7-А (карточка + портал)
INSERT INTO translations (key, ru, en, hi) VALUES
  ('family_block_title', 'Семья', 'Family', 'परिवार'),
  ('family_add', 'Добавить в семью', 'Add family member', 'परिवार में जोड़ें'),
  ('family_relation', 'Кем приходится', 'Relation', 'संबंध'),
  ('family_rel_spouse', 'Супруг(а)', 'Spouse', 'पति/पत्नी'),
  ('family_rel_child', 'Ребёнок', 'Child', 'संतान'),
  ('family_rel_parent', 'Родитель', 'Parent', 'माता-पिता'),
  ('family_rel_sibling', 'Брат/сестра', 'Sibling', 'भाई/बहन'),
  ('family_remove_confirm', 'Убрать этого человека из семьи? Общий доступ к финансовым итогам пропадёт.', 'Remove this person from the family? Shared access to financial totals will stop.', 'इस व्यक्ति को परिवार से हटाएँ? वित्तीय योग की साझा पहुँच समाप्त होगी।'),
  ('family_no_links', 'Связи не заведены', 'No family links', 'कोई पारिवारिक संबंध नहीं'),
  ('portal_family_title', 'Семья', 'Family', 'परिवार'),
  ('portal_family_total', 'Итого на семью', 'Family total', 'परिवार का कुल'),
  ('portal_family_hint', 'Итоги членов семьи — без детализации операций', 'Family members'' totals — without transaction details', 'परिवार के सदस्यों के योग — बिना विवरण के')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
